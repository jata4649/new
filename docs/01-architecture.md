# アーキテクチャ

オンラインオリパ MVP（クローズドテスト版）の全体設計。

---

## 1. このシステムの本質

「ガチャ UI のついた EC」ではなく、**有限台帳型の抽選付き在庫販売システム**である。
難所は 3 点に集約される。

| #   | 難所                   | 失敗したときの被害                        |
| --- | ---------------------- | ----------------------------------------- |
| A   | 有限スロットの排他制御 | 同一物理カードの二重当選 → 実物を渡せない |
| B   | ポイント台帳の整合性   | ポイントだけ減る／二重付与 → 金銭事故     |
| C   | 監査可能性             | 確率を後から変えた疑いを晴らせない        |

そのため「UI を先に作って後からトランザクションを直す」進め方は取らない。
台帳とスロットのデータモデルを最初に固め、その上に UI を載せる。

---

## 2. 不変条件（Invariants）

コード全体を貫く「絶対に破れない条件」。テストはこれを検証し、
DB 制約・トリガでも二重に守る（`prisma/migrations/20260922000002_guards`）。

| ID     | 内容                                                            | 守る場所                         |
| ------ | --------------------------------------------------------------- | -------------------------------- |
| INV-1  | Σ(point_ledger_entries.amount) == point_accounts の合計残高     | アプリ + `points:reconcile`      |
| INV-2  | Σ(point_lots.amount_remaining) == point_accounts の合計残高     | アプリ + `points:reconcile`      |
| INV-3  | 0 ≤ point_lots.amount_remaining ≤ amount_issued                 | DB CHECK                         |
| INV-4  | oripa_slots の件数 == campaign.total_slots（ACTIVE 以降は不変） | アプリ（公開条件）               |
| INV-5  | 1 つの inventory は高々 1 つのスロットにしか紐付かない          | DB UNIQUE                        |
| INV-6  | slot.status = DRAWN なら drawn_by_user_id / drawn_at が必ず存在 | DB CHECK                         |
| INV-7  | 1 つの user_prize は同時に 2 件の有効な発送申請へ入らない       | DB 部分 UNIQUE                   |
| INV-8  | 同一 idempotency_key に対する副作用は高々 1 回                  | DB UNIQUE + 同一トランザクション |
| INV-9  | payment_transaction 1 件につき PURCHASE 記帳は高々 1 件         | DB UNIQUE                        |
| INV-10 | campaign.remaining_slots == AVAILABLE なスロット数              | アプリ（条件付き UPDATE）        |

---

## 3. 全体構成：モジュラーモノリス

```
┌──────────────────────────────────────────────────────────┐
│                   Next.js (App Router)                    │
│                                                           │
│  (public)        (user)          admin/                   │
│   RSC            RSC + Client    RSC + Client             │
│     │ 参照は直接 service を呼ぶ（RSC）  │                  │
│     └──────┬──────┴────────────────────┘                  │
│            │ 書き込みは必ず /api 経由                      │
│      ┌─────▼──────────────────┐                           │
│      │ app/api/** (Route Handler)                         │
│      │ withApi / withIdempotentApi ラッパ                 │
│      │  ①Origin ②認証 ③ステータス ④RBAC                  │
│      │  ⑤レート制限 ⑥Zod ⑦冪等性 ⑧エラー整形             │
│      └─────┬──────────────────┘                           │
│  ══════════▼══════════════════════════════════            │
│      ┌────────────────────────┐                           │
│      │ modules/**（ドメイン層）│ ← 唯一の書き込み経路      │
│      └─────┬──────────────────┘                           │
│      ┌─────▼──────────────────┐                           │
│      │ server/db（Prisma）     │                           │
│      └─────┬──────────────────┘                           │
└────────────┼──────────────────────────────────────────────┘
             │
   ┌─────────▼────────┐        ┌──────────────────┐
   │ PostgreSQL       │        │ Redis            │
   │ ★正式データソース │        │ レート制限・     │
   │ 台帳・スロット・  │        │ キャッシュのみ   │
   │ 監査ログ          │        │ （落ちても整合性  │
   └──────────────────┘        │   に影響しない）  │
                               └──────────────────┘
```

MVP でマイクロサービス化はしない。モジュール境界だけを厳格にする。

---

## 4. レイヤ規約（ESLint で機械的に強制）

人のレビューに頼ると必ず漏れるため、設計上の約束を Lint ルールに落としている
（`eslint.config.mjs`）。

| 層                                | できること                           | 禁止されていること                     |
| --------------------------------- | ------------------------------------ | -------------------------------------- |
| `app/**`                          | service を呼ぶ、表示整形             | `@/server/db` の直接 import            |
| `modules/*/service.ts`            | ビジネスルール、トランザクション境界 | `next/*` の import                     |
| `modules/points`, `modules/draws` | PostgreSQL のみ                      | `ioredis` / `@/server/redis` の import |
| 全体                              | `@/lib/crypto/random.ts` の CSPRNG   | `Math.random()`                        |

例外は `eslint.config.mjs` の「例外」ブロックに明示的に列挙している。

---

## 5. 書き込み経路を 1 本にする

金銭・在庫に関わる変更は、**必ず** `withIdempotentApi` を通る。

```ts
export const POST = withIdempotentApi(
  {
    auth: 'user',
    paramsSchema: DrawParamsSchema,
    bodySchema: DrawBodySchema,
    rateLimit: RATE_LIMIT_RULES.draw,
    idempotency: { scope: 'draw' },
  },
  async (ctx, tx) => drawService.execute(tx, { userId: ctx.session.id, ... }),
)
```

このラッパは以下を順に行う。

1. **requestId 採番** — エラー時はこれだけをクライアントへ返す
2. **Origin 検証** — Auth.js の CSRF トークンに加えた二重防御
3. **認証** — セッション解決（`modules/auth/session.ts`）
4. **ステータス確認** — `ACTIVE` 以外は全操作を拒否
5. **RBAC** — `lib/auth/permissions.ts` の権限テーブルで判定
6. **レート制限** — Redis。落ちていれば許可にフォールバック
7. **Zod 検証** — body / query / params
8. **冪等性つきトランザクション実行**
9. **エラー整形** — `AppError` 以外は `INTERNAL_ERROR` へ丸める

Server Actions は参照・フォーム補助に限定し、**金銭系には使わない**。
暗黙のエンドポイントが増えて認可漏れの温床になるため。

---

## 6. トランザクション方針

### 分離レベルは READ COMMITTED（Serializable は使わない）

必要な排他は「特定行の奪い合い」だけであり、行ロックと一意制約・条件付き
UPDATE で完全に防げる。Serializable はシリアライズ失敗（40001）の再試行が
多発し、再試行実装のバグで二重実行を招くリスクの方が大きい。

| 守りたいこと             | 使う道具                                                             |
| ------------------------ | -------------------------------------------------------------------- |
| 同一スロットの二重当選   | `FOR UPDATE SKIP LOCKED` + 条件付き UPDATE                           |
| ポイント残高のマイナス   | 条件付き UPDATE（`WHERE balance >= ?`）+ CHECK 制約                  |
| 購入上限超過             | `user_campaign_counters` の条件付き UPSERT                           |
| 同一リクエストの二重実行 | `idempotency_keys` の UNIQUE INSERT（同一トランザクション内）        |
| 決済の二重付与           | `point_ledger_entries` の `(source_type, source_id, tx_type)` UNIQUE |

詳細は [06-draw-algorithm.md](./06-draw-algorithm.md) を参照。

### トランザクション内で外部 I/O を行わない

`$transaction` の中では DB 操作だけを行う。外部 API・画像処理・メール送信を
挟むと、コネクションを長時間占有してプールが枯渇する。
タイムアウトは `TRANSACTION_OPTIONS`（maxWait 5s / timeout 10s）で明示している。

---

## 7. エラー設計

```ts
class AppError extends Error {
  code: ErrorCode // 'INSUFFICIENT_POINTS' など
  httpStatus: number
  userMessage: string // ユーザーへ表示してよい日本語
  meta?: object // ★ログにのみ出力。レスポンスには含めない
  details?: FieldError[] // Zod のフィールドエラー
}
```

- 想定外の例外は `INTERNAL_ERROR` に丸め、`requestId` だけを返す
- スタックトレース・SQL・接続先は**絶対にレスポンスへ含めない**
- 5xx のみ `captureException` へ送る。4xx は想定内なので info ログに留める
- `lib/observability` が Sentry 互換のインターフェースを持ち、
  Phase 8 で `setErrorReporter()` に実装を差し込めば全体が切り替わる

### 統一レスポンス

```jsonc
// 成功
{ "success": true, "data": { }, "meta": { "requestId": "..." } }

// 失敗
{ "success": false, "error": { "code": "INSUFFICIENT_POINTS", "message": "ポイントが不足しています" } }
```

---

## 8. 認証・認可

### 認証方式（Phase 2 で実装）

Auth.js v5 の Credentials プロバイダは **JWT 戦略しか選べない**。
しかし「管理者が停止した瞬間にログアウトさせる」には JWT だけでは足りないため、
次の構成を取る。

1. JWT には `userId` と `sessionId`（`user_sessions.id`）だけを載せる
2. `getCurrentSession()` が毎リクエストで DB を 1 回引き、
   セッションの失効・ユーザーの停止・ロールを確認する
3. 停止・退会・セッション取消しが即座に反映される

JWT の「DB を引かなくてよい」利点は捨てるが、残高・在庫の確認で結局 DB を
引くため追加コストは実質 1 クエリ。金銭を扱う以上こちらを優先する。

- パスワード: **argon2id**（OWASP 推奨パラメータ、`modules/auth/password.ts`）
- Cookie: `httpOnly` / `secure` / `sameSite=lax`
- ログイン試行: Redis で IP + email 単位にレート制限

### 認可

`lib/auth/permissions.ts` の `ROLE_PERMISSIONS` が唯一の真実。
画面の出し分けも同じテーブルを参照するため、表示と実権限がズレない。

**Proxy（旧 middleware）では認可判定をしない。** Edge ランタイムでは DB を
引けず、停止状態やロールを正しく確認できないため。Proxy が行うのは
クローズドテストの Basic 認証と管理画面の IP 制限という粗いゲートだけであり、
そこを通過したことを認可の根拠にしてはならない。

---

## 9. 技術リスクと対策

| #   | リスク                                   | 対策                                                       |
| --- | ---------------------------------------- | ---------------------------------------------------------- |
| R1  | `remaining_slots` のホットロウ競合       | 更新をトランザクション末尾へ寄せる。正は `oripa_slots`     |
| R2  | トランザクション長期化でコネクション枯渇 | トランザクション内は DB 操作のみ。timeout 10s              |
| R2' | 10 連で 10 件揃わない                    | 件数不足なら即ロールバック（部分購入は不可）               |
| R3  | 事前シャッフル順の漏洩                   | API・管理画面へ非公開。コミット＆リビールで事後検証可能に  |
| R4  | 演出中の離脱・通信断                     | 結果は演出前にコミット済み。冪等キーで再送も同一結果       |
| R5  | Redis を真実の源にする事故               | ESLint で points / draws からの import を禁止              |
| R6  | Serializable のリトライ地獄              | READ COMMITTED + 行ロックを採用                            |
| R7  | 浮動小数点の混入                         | `lib/money/points.ts` の整数演算のみ。比率は分子分母で保持 |
| R8  | Server Actions の認可漏れ                | 金銭系は Route Handlers に一本化                           |
| R9  | 管理画面の誤操作                         | 理由必須 + 確認ダイアログ + audit_logs                     |
| R10 | Webhook の重複・順序逆転                 | `(provider, event_id)` UNIQUE + 状態機械                   |
| R11 | 意図せぬ一般公開                         | `SITE_ACCESS_MODE=closed` で Basic 認証 + noindex          |
| R12 | Prisma で `SKIP LOCKED` が書けない       | `modules/draws/repository.ts` に限って `$queryRaw` を許可  |

---

## 10. 法務・コンプライアンス上の設計判断

法的助言ではなく、**実装構造に影響する範囲**の整理。

| 論点                         | 設計への反映                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 資金決済法（前払式支払手段） | 有償ポイントの有効期限を **180 日（6 か月未満）でハード上限**。`env.ts` が起動時に拒否し、`calculateExpiresAt` でも切り詰める |
| 賭博罪・景品表示法           | 現金払戻し・ユーザー間譲渡を実装しない。全スロットに景品を割り当てハズレ枠を作らない（汎用景品 `GenericPrize` で担保）        |
| 古物営業法                   | `inventories` に `acquisition_source` / `acquired_from` / `acquired_at` を最初から持つ（後付け不可のため）                    |
| 著作権・商標                 | seed に実在 IP が混入しないよう `prisma/seed/ng-words.ts` で機械的に検査。画像はキーから SVG を生成し、素材ファイルを持たない |

詳細と本番化前の確認項目は [11-production-checklist.md](./11-production-checklist.md) を参照。

---

## 11. タイムゾーン

- DB は UTC（`timestamp(3)`）
- 表示は `Asia/Tokyo`（`lib/datetime/index.ts` の `formatDateTimeJst`）
- 日時判定はすべてサーバー時刻。クライアント時刻は一切信用しない
- テストでは `setNowProvider()` で時刻を固定できる
