import { loadDotEnvFiles } from '../../src/lib/config/dotenv.ts'

/**
 * .env の読み込みだけを行う副作用モジュール。
 *
 * seed は `src/modules/**` のサービス関数をそのまま呼ぶ。
 * それらは import した時点で `src/server/db.ts` を評価し、
 * その中で `serverEnv()` が DATABASE_URL を要求する。
 *
 * ESM の import は本体のコードより先に評価されるため、
 * index.ts の中で `loadDotEnvFiles()` を呼んでも間に合わない。
 * そこで「最初に import されるモジュール」として切り出し、
 * import 順で環境変数の読み込みを保証する。
 *
 * ★ index.ts では必ずこのモジュールを最初に import すること。
 */
loadDotEnvFiles()
