import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { serverEnv } from '@/lib/config/env.ts'
import { UPLOAD_NAME_PATTERN } from '@/lib/uploads/image-key.ts'

/**
 * アップロード画像の保存と読み出し。
 *
 * ■ パスは組み立てない、検査する
 *   保存名は採番したものしか使わないが、配信側は URL から受け取る。
 *   受け取った名前は必ず UPLOAD_NAME_PATTERN で検査し、
 *   さらに結合後のパスが保存ディレクトリ配下にあることを確認する。
 *   検査を 1 つにすると、片方を回避されたときに素通りする。
 *
 * ■ MVP はローカルファイルシステム
 *   コンテナが入れ替わると消える。クローズドテストでは許容し、
 *   本番では S3 互換ストレージへ差し替える前提で、
 *   読み書きをこのファイルに閉じ込めている。
 */

function uploadRoot(): string {
  return path.resolve(serverEnv().UPLOAD_DIR)
}

/**
 * 保存名から実際のファイルパスを求める。
 * 不正な名前・ディレクトリ外を指す名前は null を返す。
 */
export function resolveUploadPath(storedName: string): string | null {
  if (!UPLOAD_NAME_PATTERN.test(storedName)) {
    return null
  }

  const root = uploadRoot()
  const resolved = path.resolve(root, storedName)

  // 結合後にディレクトリ外を指していないことを必ず確認する
  // （パターン検査をすり抜けた場合の最後の砦）
  if (resolved !== path.join(root, storedName)) {
    return null
  }
  if (!resolved.startsWith(root + path.sep)) {
    return null
  }

  return resolved
}

export async function saveUpload(storedName: string, bytes: Uint8Array): Promise<void> {
  const target = resolveUploadPath(storedName)
  if (!target) {
    throw new Error(`保存名が不正です: ${storedName}`)
  }

  await mkdir(uploadRoot(), { recursive: true })
  await writeFile(target, bytes)
}

export async function readUpload(storedName: string): Promise<Buffer | null> {
  const target = resolveUploadPath(storedName)
  if (!target) return null

  try {
    return await readFile(target)
  } catch {
    // 存在しない場合も読めない場合も「見つからない」として扱う。
    // 理由を返し分けると、ファイルの有無を推測されうる。
    return null
  }
}
