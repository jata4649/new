/**
 * ブラウザから自 API を呼ぶための薄いヘルパー。
 *
 * 目的は 3 つ。
 *  1. Idempotency-Key を付け忘れないようにする（二重送信でポイントが二重に動くのを防ぐ）
 *  2. { success, data } / { success, error } の封筒を 1 か所で剥がす
 *  3. 失敗時に「サーバーが返した利用者向けメッセージ」だけを扱い、
 *     内部情報を画面へ出さない構造にする
 *
 * サーバー側の検証が正であり、ここでの整形は表示のためのもの。
 */

export interface FieldErrorLike {
  field: string
  message: string
}

export type JsonResult<T> =
  | { ok: true; data: T; replayed: boolean }
  | { ok: false; code: string; message: string; details: FieldErrorLike[] }

const FALLBACK_MESSAGE = '通信に失敗しました。しばらくしてからもう一度お試しください。'

function extractFailure(body: unknown): {
  code: string
  message: string
  details: FieldErrorLike[]
} {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error: unknown }).error
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>
      return {
        code: typeof record['code'] === 'string' ? record['code'] : 'UNKNOWN',
        message: typeof record['message'] === 'string' ? record['message'] : FALLBACK_MESSAGE,
        details: Array.isArray(record['details'])
          ? (record['details'] as FieldErrorLike[])
          : [],
      }
    }
  }
  return { code: 'UNKNOWN', message: FALLBACK_MESSAGE, details: [] }
}

/**
 * 変更系のリクエストを送る。
 * Idempotency-Key は常に付ける（サーバーが必須にしているエンドポイントがあるため）。
 */
export async function postJson<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  payload: unknown,
): Promise<JsonResult<T>> {
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, code: 'NETWORK_ERROR', message: FALLBACK_MESSAGE, details: [] }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (!response.ok) {
    return { ok: false, ...extractFailure(body) }
  }

  return {
    ok: true,
    data: (body as { data: T }).data,
    replayed: response.headers.get('Idempotency-Replayed') === 'true',
  }
}
