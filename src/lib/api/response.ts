import { NextResponse } from 'next/server'

import { type AppError, ERROR_CODES, type ErrorCode, type FieldError } from './errors.ts'

/**
 * API レスポンスの統一フォーマット。
 *
 * 成功: { success: true, data: {...} }
 * 失敗: { success: false, error: { code, message } }
 *
 * 内部エラーの詳細（スタックトレース・SQL・meta）は絶対に含めない。
 * 調査には requestId を使い、サーバーログと突き合わせる。
 */

export interface PaginationMeta {
  page: number
  perPage: number
  total: number
  totalPages: number
}

export interface ResponseMeta {
  requestId: string
  pagination?: PaginationMeta
}

export interface ApiSuccess<T> {
  success: true
  data: T
  meta?: ResponseMeta
}

export interface ApiFailure {
  success: false
  error: {
    code: ErrorCode
    message: string
    details?: FieldError[]
  }
  meta?: ResponseMeta
}

export type ApiResponseBody<T> = ApiSuccess<T> | ApiFailure

export function successBody<T>(data: T, meta?: ResponseMeta): ApiSuccess<T> {
  return meta ? { success: true, data, meta } : { success: true, data }
}

export function failureBody(
  code: ErrorCode,
  message: string,
  options: { details?: FieldError[]; meta?: ResponseMeta } = {},
): ApiFailure {
  const error: ApiFailure['error'] = { code, message }
  if (options.details && options.details.length > 0) {
    error.details = options.details
  }
  return options.meta
    ? { success: false, error, meta: options.meta }
    : { success: false, error }
}

export function jsonSuccess<T>(
  data: T,
  options: { status?: number; meta?: ResponseMeta; headers?: HeadersInit } = {},
): NextResponse<ApiSuccess<T>> {
  return NextResponse.json(successBody(data, options.meta), {
    status: options.status ?? 200,
    headers: options.headers,
  })
}

/**
 * AppError をレスポンスへ変換する。
 * AppError 以外（＝想定外の例外）はここへ渡さず、withApi 側で INTERNAL_ERROR に丸めること。
 */
export function jsonFailure(
  error: AppError,
  options: { meta?: ResponseMeta; headers?: HeadersInit } = {},
): NextResponse<ApiFailure> {
  const headers = new Headers(options.headers)

  // レート制限時のみ Retry-After を返す
  if (error.code === ERROR_CODES.RATE_LIMITED) {
    const retryAfter = error.meta?.['retryAfterSeconds']
    if (typeof retryAfter === 'number') {
      headers.set('Retry-After', String(retryAfter))
    }
  }

  return NextResponse.json(
    failureBody(error.code, error.userMessage, {
      details: error.details,
      meta: options.meta,
    }),
    { status: error.httpStatus, headers },
  )
}
