import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * .env ファイルの読み込み。
 *
 * Next.js は .env を自動で読み込むが、CLI から実行するスクリプト
 * （seed・バッチ・prisma.config.ts）は自前で読み込む必要がある。
 * Node 22 の process.loadEnvFile を使い、dotenv への依存を増やさない。
 *
 * 優先順位: すでに設定済みの process.env > .env.local > .env
 * （loadEnvFile は既存の値を上書きしないため、先に読んだ方が優先される）
 */
export function loadDotEnvFiles(cwd: string = process.cwd()): void {
  for (const file of ['.env.local', '.env']) {
    const fullPath = path.resolve(cwd, file)
    if (existsSync(fullPath)) {
      process.loadEnvFile(fullPath)
    }
  }
}
