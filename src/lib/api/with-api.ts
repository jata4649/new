import type { NextRequest, NextResponse } from 'next/server'
import type { z } from 'zod'

import type { Role } from '@/generated/prisma/enums.ts'
import { AppError, errors, type FieldError } from '@/lib/api/errors.ts'
import { jsonFailure, jsonSuccess, type ResponseMeta } from '@/lib/api/response.ts'
import { hasPermission, isAdminRole, type Permission } from '@/lib/auth/permissions.ts'
import { newRequestId } from '@/lib/crypto/random.ts'
import {
  buildRequestHash,
  runIdempotent,
  type IdempotentResult,
} from '@/lib/idempotency/index.ts'
import { captureException, logger } from '@/lib/observability/index.ts'
import { checkRateLimit, type RateLimitRule } from '@/lib/rate-limit/index.ts'
import { getCurrentSession, type SessionUser } from '@/modules/auth/session.ts'

// セッション解決の実装を登録する（副作用つき import）
import '@/server/session-bootstrap.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

/**
 * すべての Route Handler が通る共通ラッパ。
 *
 * ここを通らないと DB へ到達できない構造にすることで、
 * 「認証を書き忘れた」「Zod を通し忘れた」「冪等性を付け忘れた」を仕組みで防ぐ。
 * （app/api 配下から prisma を直接 import することは ESLint で禁止している）
 *
 * 実行順序:
 *   1. requestId 採番
 *   2. Origin 検証（CSRF 対策の二重化）
 *   3. 認証（セッション解決）
 *   4. ユーザーステータス確認（停止ユーザーを排除）
 *   5. 認可（RBAC）
 *   6. レート制限
 *   7. 入力検証（Zod）
 *   8. 冪等性つきで業務処理を実行
 *   9. エラー整形（内部情報を落とす）
 */

export type AuthRequirement = 'none' | 'user' | 'admin'

export interface ApiContext<TBody, TQuery, TParams> {
  req: NextRequest
  requestId: string
  /** auth: 'none' の場合のみ null になりうる */
  session: SessionUser | null
  body: TBody
  query: TQuery
  params: TParams
  ip: string | null
  userAgent: string | null
}

/** 認証必須のエンドポイントで使う、session が非 null であることを保証した文脈 */
export interface AuthedApiContext<TBody, TQuery, TParams>
  extends ApiContext<TBody, TQuery, TParams> {
  session: SessionUser
}

export interface IdempotencyOptions {
  /** 'draw' / 'prize_exchange' など。キーの名前空間。 */
  scope: string
}

export interface WithApiOptions<TBodySchema, TQuerySchema, TParamsSchema> {
  auth?: AuthRequirement
  permission?: Permission
  bodySchema?: TBodySchema
  querySchema?: TQuerySchema
  paramsSchema?: TParamsSchema
  rateLimit?: RateLimitRule
  /** 指定すると Idempotency-Key ヘッダを必須にし、業務処理をトランザクションで包む */
  idempotency?: IdempotencyOptions
  /** 成功時の HTTP ステータス（既定 200） */
  successStatus?: number
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined

/**
 * 冪等性ありの場合、ハンドラはトランザクションクライアントを受け取る。
 * 受け取った tx 以外（prisma シングルトン）を触らないこと。
 */
export type IdempotentHandler<TBody, TQuery, TParams, TResult> = (
  ctx: AuthedApiContext<TBody, TQuery, TParams>,
  tx: PrismaTransactionClient,
  idempotencyKeyId: string,
) => Promise<TResult>

export type PlainHandler<TBody, TQuery, TParams, TResult> = (
  ctx: ApiContext<TBody, TQuery, TParams>,
) => Promise<TResult>

/** Next.js の Route Handler シグネチャ */
type RouteHandler = (
  req: NextRequest,
  segment: { params: Promise<Record<string, string | string[]>> },
) => Promise<NextResponse>

/* -------------------------------------------------------------------------- */

function getClientIp(req: NextRequest): string | null {
  // プロキシ配下を想定。信頼できるプロキシのみが x-forwarded-for を設定する前提。
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return req.headers.get('x-real-ip')
}

/**
 * Origin ヘッダ検証。
 * Auth.js の CSRF トークンに加えた二重防御。
 * 変更系メソッドのみを対象とする。
 */
function assertSameOrigin(req: NextRequest): void {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return
  }

  const origin = req.headers.get('origin')
  if (!origin) {
    // ブラウザ以外からの正当な呼び出し（Webhook・サーバー間通信）を許容する。
    // それらの認証は署名検証で別途行う。
    return
  }

  const host = req.headers.get('host')
  if (!host) {
    throw errors.forbidden({ reason: 'host ヘッダがありません' })
  }

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    throw errors.forbidden({ reason: 'origin ヘッダが不正です', origin })
  }

  if (originHost !== host) {
    throw errors.forbidden({ reason: 'クロスオリジンからの変更操作', origin, host })
  }
}

function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }))
}

function parseWith<T extends z.ZodType>(schema: T, value: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw errors.validation(toFieldErrors(result.error), { label })
  }
  return result.data
}

async function readJsonBody(req: NextRequest): Promise<unknown> {
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw errors.validation([
      { field: 'content-type', message: 'Content-Type: application/json が必要です' },
    ])
  }
  try {
    return await req.json()
  } catch {
    throw errors.validation([{ field: '(body)', message: 'JSON として解釈できません' }])
  }
}

function searchParamsToObject(req: NextRequest): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [key, value] of req.nextUrl.searchParams.entries()) {
    const existing = result[key]
    if (existing === undefined) {
      result[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      result[key] = [existing, value]
    }
  }
  return result
}

async function resolveSession(
  requirement: AuthRequirement,
  permission: Permission | undefined,
): Promise<SessionUser | null> {
  if (requirement === 'none') {
    return null
  }

  const session = await getCurrentSession()
  if (!session) {
    throw errors.unauthenticated()
  }

  // 停止・退会ユーザーは抽選・交換・発送申請を含むすべての操作を行えない
  if (session.status !== 'ACTIVE') {
    throw errors.userSuspended()
  }

  if (requirement === 'admin' && !isAdminRole(session.role as Role)) {
    throw errors.forbidden({ reason: '管理者ロールが必要です', role: session.role })
  }

  if (permission && !hasPermission(session.role as Role, permission)) {
    throw errors.forbidden({ reason: '権限が不足しています', permission, role: session.role })
  }

  return session
}

async function enforceRateLimit(
  rule: RateLimitRule | undefined,
  session: SessionUser | null,
  ip: string | null,
): Promise<void> {
  if (!rule) return

  const identifier = session?.id ?? ip ?? 'anonymous'
  const result = await checkRateLimit(rule, identifier)
  if (!result.allowed) {
    throw errors.rateLimited(result.retryAfterSeconds)
  }
}

function requireIdempotencyKey(req: NextRequest): string {
  const key = req.headers.get('idempotency-key')?.trim()
  if (!key) {
    throw errors.idempotencyKeyRequired()
  }
  if (key.length > 200) {
    throw errors.validation([
      { field: 'Idempotency-Key', message: 'キーが長すぎます（200 文字以内）' },
    ])
  }
  return key
}

/**
 * 例外をレスポンスへ変換する。
 * AppError 以外は必ず INTERNAL_ERROR へ丸め、内部情報を外へ出さない。
 */
function toErrorResponse(error: unknown, meta: ResponseMeta, route: string): NextResponse {
  if (AppError.isAppError(error)) {
    // 5xx だけを異常として記録する。4xx は想定内なので info に留める。
    if (error.httpStatus >= 500) {
      captureException(error, { requestId: meta.requestId, route, meta: error.meta })
    } else {
      logger.info('リクエストを拒否しました', {
        requestId: meta.requestId,
        route,
        code: error.code,
        detail: error.meta,
      })
    }
    return jsonFailure(error, { meta })
  }

  captureException(error, { requestId: meta.requestId, route })
  return jsonFailure(errors.internal(error), { meta })
}

/* -------------------------------------------------------------------------- */
/* 本体                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 冪等性なしのエンドポイント（主に参照系）。
 */
export function withApi<
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResult = unknown,
>(
  options: WithApiOptions<TBodySchema, TQuerySchema, TParamsSchema>,
  handler: PlainHandler<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>, TResult>,
): RouteHandler {
  return async (req, segment) => {
    const requestId = newRequestId()
    const meta: ResponseMeta = { requestId }
    const route = `${req.method} ${req.nextUrl.pathname}`

    try {
      assertSameOrigin(req)

      const session = await resolveSession(options.auth ?? 'none', options.permission)
      const ip = getClientIp(req)
      await enforceRateLimit(options.rateLimit, session, ip)

      const rawParams = await segment.params
      const ctx = await buildContext(req, requestId, session, rawParams, options, ip)

      const result = await handler(ctx)
      return jsonSuccess(result, { status: options.successStatus ?? 200, meta })
    } catch (error) {
      return toErrorResponse(error, meta, route)
    }
  }
}

/**
 * 認証必須・冪等性なしのエンドポイント（自分のデータの参照、管理画面の一覧など）。
 *
 * withApi との違いは型だけで、パイプラインは同一。
 * ハンドラが session を非 null で受け取れるため、`ctx.session!` を書かずに済む。
 */
export function withAuthedApi<
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResult = unknown,
>(
  options: WithApiOptions<TBodySchema, TQuerySchema, TParamsSchema> & {
    auth: 'user' | 'admin'
  },
  handler: (
    ctx: AuthedApiContext<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>>,
  ) => Promise<TResult>,
): RouteHandler {
  return withApi(options, (ctx) => {
    // auth が 'user' | 'admin' のとき、resolveSession は必ず非 null を返すか例外を投げる
    if (!ctx.session) {
      throw errors.unauthenticated()
    }
    return handler(
      ctx as AuthedApiContext<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>>,
    )
  })
}

/**
 * 冪等性つきのエンドポイント（抽選・ポイント交換・発送申請・テスト決済）。
 *
 * ハンドラはトランザクションクライアントを受け取り、その中だけで DB を操作する。
 * ハンドラが例外を投げればトランザクションごとロールバックされるため、
 * 「ポイントだけ減って抽選されない」状態は原理的に発生しない。
 */
export function withIdempotentApi<
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResult = unknown,
>(
  options: WithApiOptions<TBodySchema, TQuerySchema, TParamsSchema> & {
    auth: 'user' | 'admin'
    idempotency: IdempotencyOptions
  },
  handler: IdempotentHandler<
    Infer<TBodySchema>,
    Infer<TQuerySchema>,
    Infer<TParamsSchema>,
    TResult
  >,
): RouteHandler {
  return async (req, segment) => {
    const requestId = newRequestId()
    const meta: ResponseMeta = { requestId }
    const route = `${req.method} ${req.nextUrl.pathname}`

    try {
      assertSameOrigin(req)

      const session = await resolveSession(options.auth, options.permission)
      if (!session) {
        throw errors.unauthenticated()
      }

      const ip = getClientIp(req)
      await enforceRateLimit(options.rateLimit, session, ip)

      const idempotencyKey = requireIdempotencyKey(req)
      const rawParams = await segment.params
      const ctx = (await buildContext(
        req,
        requestId,
        session,
        rawParams,
        options,
        ip,
      )) as AuthedApiContext<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>>

      // パスパラメータも含めてハッシュ化する。
      // 同じキーで別のオリパを引こうとした場合に検出できるようにするため。
      const requestHash = buildRequestHash({
        body: ctx.body ?? null,
        params: ctx.params ?? null,
        route: req.nextUrl.pathname,
      })

      const result: IdempotentResult<TResult> = await runIdempotent(
        {
          userId: session.id,
          scope: options.idempotency.scope,
          key: idempotencyKey,
          requestHash,
        },
        (tx, idempotencyKeyId) => handler(ctx, tx, idempotencyKeyId),
      )

      return jsonSuccess(result.data, {
        status: options.successStatus ?? 200,
        meta,
        // リプレイであることをクライアントが判別できるようにする（演出の再生抑制などに使う）
        headers: { 'Idempotency-Replayed': String(result.replayed) },
      })
    } catch (error) {
      return toErrorResponse(error, meta, route)
    }
  }
}

async function buildContext<
  TBodySchema extends z.ZodType | undefined,
  TQuerySchema extends z.ZodType | undefined,
  TParamsSchema extends z.ZodType | undefined,
>(
  req: NextRequest,
  requestId: string,
  session: SessionUser | null,
  rawParams: Record<string, string | string[]>,
  options: WithApiOptions<TBodySchema, TQuerySchema, TParamsSchema>,
  ip: string | null,
): Promise<ApiContext<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>>> {
  const body = options.bodySchema
    ? parseWith(options.bodySchema as z.ZodType, await readJsonBody(req), 'body')
    : undefined

  const query = options.querySchema
    ? parseWith(options.querySchema as z.ZodType, searchParamsToObject(req), 'query')
    : undefined

  const params = options.paramsSchema
    ? parseWith(options.paramsSchema as z.ZodType, rawParams, 'params')
    : undefined

  return {
    req,
    requestId,
    session,
    body: body as Infer<TBodySchema>,
    query: query as Infer<TQuerySchema>,
    params: params as Infer<TParamsSchema>,
    ip,
    userAgent: req.headers.get('user-agent'),
  }
}
