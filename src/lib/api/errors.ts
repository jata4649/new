/**
 * ドメインエラーの定義。
 *
 * 要件: 「エラー時に内部情報やスタックトレースをユーザーへ表示しない」
 *
 * 設計:
 *  - ユーザーへ返してよい情報は code / userMessage / details（Zod のフィールドエラー）だけ。
 *  - 原因調査に必要な情報は meta に入れ、ログにのみ出力する。レスポンスには絶対に含めない。
 *  - 想定外の例外は withApi が INTERNAL_ERROR へ丸め、requestId だけを返す。
 */

export const ERROR_CODES = {
  // 認証・認可
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  USER_SUSPENDED: 'USER_SUSPENDED',
  SESSION_REVOKED: 'SESSION_REVOKED',

  // 入力
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',

  // ポイント
  INSUFFICIENT_POINTS: 'INSUFFICIENT_POINTS',
  POINT_LOT_INCONSISTENCY: 'POINT_LOT_INCONSISTENCY',

  // オリパ・抽選
  CAMPAIGN_NOT_ON_SALE: 'CAMPAIGN_NOT_ON_SALE',
  CAMPAIGN_OUT_OF_PERIOD: 'CAMPAIGN_OUT_OF_PERIOD',
  INSUFFICIENT_SLOTS: 'INSUFFICIENT_SLOTS',
  PURCHASE_LIMIT_EXCEEDED: 'PURCHASE_LIMIT_EXCEEDED',
  INVALID_DRAW_COUNT: 'INVALID_DRAW_COUNT',

  // 当選商品
  PRIZE_NOT_UNDECIDED: 'PRIZE_NOT_UNDECIDED',
  PRIZE_NOT_SHIPPABLE: 'PRIZE_NOT_SHIPPABLE',
  PRIZE_ALREADY_REQUESTED: 'PRIZE_ALREADY_REQUESTED',

  // 決済
  PAYMENT_NOT_CONFIRMABLE: 'PAYMENT_NOT_CONFIRMABLE',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',

  // 管理
  CAMPAIGN_NOT_PUBLISHABLE: 'CAMPAIGN_NOT_PUBLISHABLE',
  CAMPAIGN_IMMUTABLE: 'CAMPAIGN_IMMUTABLE',
  INVENTORY_ALREADY_ALLOCATED: 'INVENTORY_ALREADY_ALLOCATED',
  REASON_REQUIRED: 'REASON_REQUIRED',

  // 横断
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export interface FieldError {
  field: string
  message: string
}

export interface AppErrorOptions {
  /** ログにのみ出力する診断情報。レスポンスには含めない。 */
  meta?: Record<string, unknown>
  /** Zod などのフィールド単位エラー。ユーザーへ返してよい。 */
  details?: FieldError[]
  cause?: unknown
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly httpStatus: number
  readonly userMessage: string
  readonly meta: Record<string, unknown> | undefined
  readonly details: FieldError[] | undefined

  constructor(
    code: ErrorCode,
    httpStatus: number,
    userMessage: string,
    options: AppErrorOptions = {},
  ) {
    // Error.message は内部ログ向け。ユーザーへは userMessage のみを出す。
    super(`${code}: ${userMessage}`, options.cause ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.httpStatus = httpStatus
    this.userMessage = userMessage
    this.meta = options.meta
    this.details = options.details
  }

  /** 想定内のエラーか（＝ユーザーへ内容を返してよいか） */
  static isAppError(error: unknown): error is AppError {
    return error instanceof AppError
  }
}

/* -------------------------------------------------------------------------- */
/* よく使うエラーのファクトリ                                                  */
/* -------------------------------------------------------------------------- */

export const errors = {
  unauthenticated: (meta?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.UNAUTHENTICATED, 401, 'ログインが必要です', { meta }),

  forbidden: (meta?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.FORBIDDEN, 403, 'この操作を行う権限がありません', { meta }),

  userSuspended: () =>
    new AppError(
      ERROR_CODES.USER_SUSPENDED,
      403,
      'アカウントが停止されています。サポートへお問い合わせください',
    ),

  sessionRevoked: () =>
    new AppError(
      ERROR_CODES.SESSION_REVOKED,
      401,
      'セッションが無効になりました。再度ログインしてください',
    ),

  validation: (details: FieldError[], meta?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.VALIDATION_ERROR, 400, '入力内容に誤りがあります', {
      details,
      meta,
    }),

  notFound: (what = '対象', meta?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.NOT_FOUND, 404, `${what}が見つかりません`, { meta }),

  insufficientPoints: (meta?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.INSUFFICIENT_POINTS, 400, 'ポイントが不足しています', { meta }),

  campaignNotOnSale: () =>
    new AppError(ERROR_CODES.CAMPAIGN_NOT_ON_SALE, 409, 'このオリパは現在販売していません'),

  campaignOutOfPeriod: () =>
    new AppError(ERROR_CODES.CAMPAIGN_OUT_OF_PERIOD, 409, 'このオリパは販売期間外です'),

  insufficientSlots: (meta?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.INSUFFICIENT_SLOTS, 409, '残り口数が不足しています', { meta }),

  purchaseLimitExceeded: (limit: number) =>
    new AppError(
      ERROR_CODES.PURCHASE_LIMIT_EXCEEDED,
      409,
      `このオリパの購入上限（${limit} 口）に達しています`,
      { meta: { limit } },
    ),

  invalidDrawCount: (allowed: readonly number[]) =>
    new AppError(
      ERROR_CODES.INVALID_DRAW_COUNT,
      400,
      `抽選口数は ${allowed.join(' または ')} のみ指定できます`,
      { meta: { allowed } },
    ),

  prizeNotUndecided: () =>
    new AppError(
      ERROR_CODES.PRIZE_NOT_UNDECIDED,
      409,
      'この商品はすでに交換または発送申請が済んでいます',
    ),

  prizeNotShippable: () =>
    new AppError(ERROR_CODES.PRIZE_NOT_SHIPPABLE, 409, 'この商品は発送申請の対象外です'),

  prizeAlreadyRequested: () =>
    new AppError(ERROR_CODES.PRIZE_ALREADY_REQUESTED, 409, 'この商品はすでに発送申請中です'),

  paymentNotConfirmable: (meta?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.PAYMENT_NOT_CONFIRMABLE, 409, 'この決済は確定できない状態です', {
      meta,
    }),

  webhookSignatureInvalid: (meta?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, 401, '署名の検証に失敗しました', {
      meta,
    }),

  campaignNotPublishable: (reasons: FieldError[]) =>
    new AppError(ERROR_CODES.CAMPAIGN_NOT_PUBLISHABLE, 409, '公開条件を満たしていません', {
      details: reasons,
    }),

  campaignImmutable: (field: string) =>
    new AppError(
      ERROR_CODES.CAMPAIGN_IMMUTABLE,
      409,
      '販売開始後のオリパでは、この項目を変更できません',
      { meta: { field } },
    ),

  inventoryAlreadyAllocated: (inventoryId: string) =>
    new AppError(
      ERROR_CODES.INVENTORY_ALREADY_ALLOCATED,
      409,
      'この在庫はすでに他のオリパへ割り当てられています',
      { meta: { inventoryId } },
    ),

  reasonRequired: () =>
    new AppError(ERROR_CODES.REASON_REQUIRED, 400, 'この操作には理由の入力が必要です'),

  idempotencyKeyRequired: () =>
    new AppError(
      ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
      400,
      'リクエストの重複を防ぐためのキーが指定されていません',
    ),

  idempotencyKeyConflict: () =>
    new AppError(
      ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
      409,
      '同じキーで異なる内容のリクエストが送信されました',
    ),

  requestInProgress: () =>
    new AppError(
      ERROR_CODES.REQUEST_IN_PROGRESS,
      409,
      '同じリクエストを処理中です。しばらく待ってから再度お試しください',
    ),

  rateLimited: (retryAfterSeconds: number) =>
    new AppError(
      ERROR_CODES.RATE_LIMITED,
      429,
      'リクエストが多すぎます。しばらく待ってから再度お試しください',
      { meta: { retryAfterSeconds } },
    ),

  conflict: (userMessage: string, meta?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.CONFLICT, 409, userMessage, { meta }),

  internal: (cause?: unknown, meta?: Record<string, unknown>) =>
    new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      500,
      'システムエラーが発生しました。時間をおいて再度お試しください',
      { cause, meta },
    ),
} as const
