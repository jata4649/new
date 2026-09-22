# オンラインオリパ MVP（クローズドテスト版）

トレーディングカードのオンラインオリパ Web システム。
管理者が有限口数のオリパを作成し、テストユーザーがポイントで抽選し、
当選商品を「発送申請」または「サイト内ポイントへの交換」から選べる。

> ## ⚠️ このシステムについて
>
> - **現金決済は実装していない。** 決済は `MockPaymentProvider` によるテストのみ。
> - **一般公開しない。** `SITE_ACCESS_MODE=closed` でサイト全体を Basic 認証で保護する。
> - **現金買取り・ポイントの現金払戻し・ユーザー間譲渡は実装しない。**
> - カード名・画像はすべて架空のもの。実在の作品名・キャラクター・ロゴは使用しない
>   （`prisma/seed/ng-words.ts` が seed 投入時に機械的に検査する）。
> - 法務確認・古物商許可・決済事業者の審査が完了するまで、
>   現金を受け取らないテスト環境として運用する。
>   本番化の要件は [`docs/11-production-checklist.md`](./docs/11-production-checklist.md)。

---

## 開発状況

| Phase | 内容                                                                          | 状態    |
| ----- | ----------------------------------------------------------------------------- | ------- |
| 1     | 要件整理・アーキテクチャ・Prisma スキーマ・Docker・環境変数・初期セットアップ | ✅ 完了 |
| 2     | 認証・ユーザー・RBAC・管理画面基盤                                            | ✅ 完了 |
| 3     | ポイント台帳・ポイントロット・Mock 決済                                       | 未着手  |
| 4     | カード在庫・オリパ作成・景品ランク・抽選スロット生成                          | 未着手  |
| 5     | 1 回抽選・10 連抽選・冪等性・排他制御                                         | 未着手  |
| 6     | 演出・抽選結果・商品一覧・ポイント交換                                        | 未着手  |
| 7     | 配送先・発送申請・発送管理                                                    | 未着手  |
| 8     | 監査ログ・セキュリティ・テスト・ドキュメント                                  | 未着手  |

Phase 1 時点で未実装のものは
[`docs/10-known-limitations.md`](./docs/10-known-limitations.md) §2 にまとめてある。

---

## 1. 必要なソフトウェア

| ソフトウェア            | バージョン | 備考                                               |
| ----------------------- | ---------- | -------------------------------------------------- |
| Node.js                 | 22 以上    | `process.loadEnvFile` を使うため 20.6 未満は不可   |
| pnpm                    | 10 以上    | `corepack enable` で有効化できる                   |
| Docker / Docker Compose | 任意       | PostgreSQL・Redis をホストに直接用意する場合は不要 |
| PostgreSQL              | 16         | Docker を使わない場合                              |
| Redis                   | 7          | 任意。無い場合はレート制限が無効になるだけ         |

---

## 2. ローカル起動方法

### 2-1. かんたんセットアップ（Docker あり）

```bash
make setup    # .env 作成 → 依存関係 → DB 起動 → マイグレーション → seed
pnpm dev      # http://localhost:3000
```

`make setup` の後、**`.env` の `AUTH_SECRET` を必ず設定する**こと
（32 文字未満だと起動時にエラーで落ちる）。

```bash
openssl rand -base64 48
```

### 2-2. 手順を分けて実行する

```bash
# 1. 環境変数
cp .env.example .env
# .env を編集し、AUTH_SECRET を上の方法で生成した値に置き換える

# 2. 依存関係
pnpm install

# 3. PostgreSQL と Redis を起動
docker compose up -d postgres postgres-shadow redis

# 4. DB を初期化
pnpm db:migrate:deploy   # マイグレーション適用
pnpm db:generate         # Prisma クライアント生成
pnpm db:seed             # seed データ投入

# 5. 開発サーバー
pnpm dev
```

ブラウザで http://localhost:3000 を開くと Basic 認証を求められる。
`.env` の `SITE_BASIC_AUTH_USER` / `SITE_BASIC_AUTH_PASSWORD`（既定
`tester` / `closed_test_password`）を入力する。

### 2-3. Docker を使わない場合

PostgreSQL と Redis をホストに用意し、`.env` の `DATABASE_URL` / `REDIS_URL` を
そちらへ向ければよい。事前に実行時ロールと拡張を作る場合は
`docker/postgres/init.sql` を流す。

---

## 3. DB の初期化・seed

| コマンド                 | 内容                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `pnpm db:migrate`        | マイグレーションを作成して適用（開発用。シャドウ DB が必要） |
| `pnpm db:migrate:deploy` | 既存のマイグレーションを適用するだけ（CI・本番用）           |
| `pnpm db:reset`          | DB を作り直してマイグレーションと seed を実行する            |
| `pnpm db:generate`       | Prisma クライアントを再生成する（`src/generated/`）          |
| `pnpm db:seed`           | seed データを投入する（冪等。何度実行してもよい）            |
| `pnpm db:studio`         | Prisma Studio でデータを閲覧する                             |

> Prisma 7 では接続 URL を `prisma.config.ts` で指定する（`schema.prisma` には書かない）。
> `prisma migrate reset` の `--skip-seed` は廃止されているため、
> seed を走らせたくない場合は DB を手動で作り直してから `db:migrate:deploy` を使う。

### seed の内容（Phase 1）

- 管理者 1 名 / 一般ユーザー 3 名（うち 1 名は `SUSPENDED`）
- 架空カード在庫 120 件
- 汎用景品 1 件（ハズレ枠を作らないための代替商品）
- システム設定の初期値

オリパ・抽選履歴・ポイント履歴・発送申請のサンプルは、
スロット生成ロジック（Phase 4）に依存するため Phase 4 で追加する。

---

## 4. ログイン情報

ログイン画面は `/login`、新規会員登録は `/signup`。
seed で作られるアカウントは以下のとおり。

| ロール         | メールアドレス       | パスワード         |
| -------------- | -------------------- | ------------------ |
| 管理者         | `admin@example.test` | `TestPassword123!` |
| 一般           | `user1@example.test` | `TestPassword123!` |
| 一般           | `user2@example.test` | `TestPassword123!` |
| 一般（停止中） | `user3@example.test` | `TestPassword123!` |

`user3` は停止ユーザーの挙動（ログインできず、抽選・交換・発送申請も行えないこと）を
確認するために用意している。

管理者でログインすると、ヘッダーに「管理画面」へのリンクが表示される（`/admin`）。
一般ユーザーが `/admin` を直接開いてもトップへ戻される（管理画面の存在を隠すため）。

---

## 5. テスト実行方法

```bash
pnpm test              # 単体テスト（DB 不要・高速）
pnpm test:watch        # 単体テストの監視実行
pnpm test:integration  # 統合テスト（DB 必要）
pnpm test:concurrency  # 同時実行テスト（DB 必要・直列実行）
pnpm test:all          # すべて
pnpm test:e2e          # E2E（Playwright）
pnpm check             # 型チェック + Lint + 単体テスト
```

### テスト用 DB

統合テスト・同時実行テストは **DB を TRUNCATE する**。
`TEST_DATABASE_URL` にテスト専用の DB を指定すること。

```bash
# .env
TEST_DATABASE_URL="postgresql://oripa:oripa_dev_password@localhost:5432/oripa_test?schema=public"
```

接続先の名前に `test` が含まれない場合、
誤って開発 DB を消さないよう実行を拒否する
（意図的な場合は `ALLOW_DESTRUCTIVE_TESTS=1`）。

テスト用 DB の作成:

```bash
docker compose exec -T postgres createdb -U oripa oripa_test
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate:deploy
```

> 追記専用テーブル（台帳・監査ログ・抽選履歴）は DELETE が DB トリガで拒否される。
> テストのクリーンアップは TRUNCATE で行う（`src/tests/helpers/setup-db.ts`）。

### E2E

```bash
pnpm exec playwright install chromium   # 初回のみ
pnpm test:e2e
```

すでに起動中のサーバーに対して実行する場合:

```bash
E2E_BASE_URL=http://127.0.0.1:3000 pnpm test:e2e
```

Chromium が別の場所にある環境では
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome` を指定する。

---

## 6. Mock 決済の使い方

**Phase 3 で実装する。** 設計は以下のとおり。

- `PaymentProvider` インターフェース
  （`createPayment` / `confirmPayment` / `cancelPayment` / `refundPayment` /
  `verifyWebhook` / `getPaymentStatus`）に対する `MockPaymentProvider` を実装する
- 管理画面 `/admin/test-payments` から
  成功 / 失敗 / 処理中 / 取消し / 返金、
  Webhook の重複・遅延・順序逆転を再現できる
- **決済成功時のみ**有償ポイントを付与する
- 同じ `paymentId` や Webhook が複数回届いてもポイントは二重付与されない
  （`point_ledger_entries` の `(source_type, source_id, tx_type)` UNIQUE で保証）
- 実在するカード情報は入力させない。カード番号を保存する機能は作らない

---

## 7. 動作確認方法

### Phase 1 で確認できること

```bash
# ヘルスチェック（DB 到達性）
curl -u tester:closed_test_password http://localhost:3000/api/health
# → {"success":true,"data":{"status":"ok","database":true},"meta":{"requestId":"..."}}

# Basic 認証なしでは 401
curl -i http://localhost:3000/ | head -1
# → HTTP/1.1 401 Unauthorized

# 架空カードのプレースホルダー画像
curl -u tester:closed_test_password \
  "http://localhost:3000/api/placeholder/placeholder%3ASR%3A210%3Afront"

# DB ガードが効いていること（統合テスト）
pnpm test:integration

# ポイント台帳の整合性
pnpm points:reconcile
```

Prisma Studio（`pnpm db:studio`）で
`inventories` に 120 件、`users` に 4 件入っていることを確認できる。

### Phase 2 で確認できること

```bash
# 未ログインでは 401（内部情報を含まない統一フォーマット）
curl -u tester:closed_test_password http://localhost:3000/api/me
# → {"success":false,"error":{"code":"UNAUTHENTICATED","message":"ログインが必要です"},...}

# 認証フローの E2E（ログイン・権限・停止ユーザー・ログアウト）
pnpm test:e2e
```

ブラウザでの確認:

1. `/signup` から新規登録する → そのままログイン状態になり `/mypage` へ
2. `/login` で `admin@example.test` としてログインする → `/admin` が開ける
3. `/admin/users` から `user1` を開き、理由を入力して「停止する」
   （確認ダイアログが出る）
4. 別タブで `user1` としてログインしていた場合、**次の操作で即座に締め出される**
5. `/admin` のダッシュボードに、行った操作が監査ログとして表示される

### 1 回抽選の確認方法（Phase 5 で実装）

1. `/oripas` から販売中のオリパを開く
2. 残り口数と当選確率を確認する
3. 「1 回引く」→ 確認ダイアログで消費ポイントを確認して実行
4. 演出が再生され、結果が表示される
5. **演出を途中で閉じても** `/mypage/draws` から結果を確認できる
6. **リロードしても** 結果は変わらない
7. ブラウザの開発者ツールで同じリクエストを再送しても、
   同じ結果が返るだけで二重抽選されない（`Idempotency-Replayed: true`）

### 10 連抽選の確認方法（Phase 5 で実装）

1. 「10 回引く」を実行する
2. 10 件の結果が一覧表示される
3. 残り口数が 10 減っていることを確認する
4. 残り口数が 10 未満のオリパでは実行できず、
   `INSUFFICIENT_SLOTS` になりポイントが減らないことを確認する

### 発送申請の確認方法（Phase 7 で実装）

1. `/mypage/prizes` で `UNDECIDED` の商品を複数選ぶ
2. 配送先を選んで発送申請する
3. 商品が `SHIPPING_REQUESTED` になり、ポイント交換できなくなる
4. 管理画面 `/admin/shipping-requests` で申請を確認する
5. ステータスを更新し、配送会社と追跡番号を入力する
6. ユーザー側の `/mypage/shipments` に反映される

---

## 8. ドキュメント

| 文書                                                                   | 内容                                         |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| [`docs/01-architecture.md`](./docs/01-architecture.md)                 | アーキテクチャ・不変条件・レイヤ規約・リスク |
| [`docs/02-er-diagram.md`](./docs/02-er-diagram.md)                     | ER 図・状態遷移・制約一覧                    |
| [`docs/03-api-spec.md`](./docs/03-api-spec.md)                         | API 共通仕様・エンドポイント一覧             |
| [`docs/04-screens.md`](./docs/04-screens.md)                           | 画面一覧                                     |
| [`docs/05-permissions.md`](./docs/05-permissions.md)                   | 権限一覧（RBAC）                             |
| [`docs/06-draw-algorithm.md`](./docs/06-draw-algorithm.md)             | **抽選処理の説明書**                         |
| [`docs/07-point-ledger.md`](./docs/07-point-ledger.md)                 | **ポイント台帳の説明書**                     |
| [`docs/08-runbook.md`](./docs/08-runbook.md)                           | 障害発生時の復旧手順                         |
| [`docs/09-backup-restore.md`](./docs/09-backup-restore.md)             | バックアップとリストア手順                   |
| [`docs/10-known-limitations.md`](./docs/10-known-limitations.md)       | 既知の制約一覧                               |
| [`docs/11-production-checklist.md`](./docs/11-production-checklist.md) | 本番化前チェックリスト                       |

---

## 9. 技術スタック

Next.js 16（App Router）/ React 19 / TypeScript 5.9（strict）/ Tailwind CSS 4 /
PostgreSQL 16 / Prisma 7 / Redis 7 / Auth.js v5 / Zod 4 / React Hook Form /
Vitest 5 / Playwright / ESLint 9 / Prettier

ユーザー画面と管理画面は単一の Next.js アプリに実装する（モジュラーモノリス）。
ドメインロジックは `src/modules/**` に分離し、UI や Route Handler には書かない。

### ディレクトリ構成

```
src/
├── app/
│   ├── api/            # Route Handlers（withApi 経由でのみ DB へ到達する）
│   └── ...             # (public) / (auth) / (user) / admin
├── components/         # ui / oripa / points / prizes / admin / effects
├── modules/            # ★ドメイン層（auth, users, points, payments, inventory,
│                       #   oripa, draws, prizes, shipping, promotions, audit）
├── lib/                # api / auth / config / crypto / datetime /
│                       # idempotency / money / observability / rate-limit
├── server/             # db（Prisma）・redis
├── generated/          # Prisma クライアント（自動生成・コミットしない）
└── tests/              # unit / integration / concurrency / e2e / helpers
```

### 設計上の約束（ESLint で機械的に強制）

- `app/**` から `@/server/db` を直接 import しない
- `modules/**` から `next/*` を import しない
- `modules/points`・`modules/draws` から Redis を import しない
- どこでも `Math.random()` を使わない（`@/lib/crypto/random.ts` の CSPRNG を使う）

---

## 10. よく使うコマンド

```bash
make help              # Makefile のタスク一覧
pnpm dev               # 開発サーバー
pnpm build             # 本番ビルド
pnpm check             # 型チェック + Lint + 単体テスト
pnpm lint:fix          # Lint の自動修正
pnpm format            # Prettier
pnpm points:reconcile  # ポイント台帳の整合性検証
```

---

## 11. トラブルシューティング

| 症状                                                          | 原因と対応                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 起動時に `環境変数の検証に失敗しました`                       | `.env` の不足・不正。メッセージに項目名が出る。`AUTH_SECRET` は 32 文字以上                                                                      |
| `SITE_ACCESS_MODE=closed では Basic 認証の資格情報が必須です` | `SITE_BASIC_AUTH_USER` / `SITE_BASIC_AUTH_PASSWORD` を設定する                                                                                   |
| `本番既定値のままにはできません`                              | `next start` は `NODE_ENV=production` で動く。`MOCK_PAYMENT_WEBHOOK_SECRET` を変更する                                                           |
| `POINT_EXPIRY_DAYS_PAID は 180 日以下に`                      | 有償ポイントの有効期限は 6 か月未満に固定している（[理由](./docs/07-point-ledger.md#3-有償ポイントの有効期限を-180-日に固定する理由)）           |
| `SessionResolverNotConfiguredError`                           | セッション解決が未登録。`@/server/session-bootstrap.ts` を import 済みか確認する（通常は自動で登録される）                                       |
| `APPEND_ONLY_VIOLATION`                                       | 台帳・監査ログ・抽選履歴は追記専用。訂正は打ち消しの記帳で行う                                                                                   |
| テストが `"test" が含まれていません` で止まる                 | `TEST_DATABASE_URL` にテスト専用 DB を指定する                                                                                                   |
| `pnpm build` は通るのに起動しない                             | ビルド時は環境変数の相互依存ルールを検査しない（[理由](./docs/10-known-limitations.md#3-1-next-build-時は環境変数の相互依存ルールを適用しない)） |

---

## ライセンス

Private / Unpublished.
