# API 仕様書

§1・§2 は全フェーズを通した**共通仕様とエンドポイント一覧**。
§3 に実装済みエンドポイントの詳細を、実装フェーズごとに追記していく。
リクエストの検証内容は `src/modules/**/schema.ts` の Zod スキーマが真実。

---

## 1. 共通仕様

### レスポンス形式

```jsonc
// 成功
{
  "success": true,
  "data": { /* エンドポイントごと */ },
  "meta": { "requestId": "uuid", "pagination": { "page": 1, "perPage": 20, "total": 120, "totalPages": 6 } }
}

// 失敗
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_POINTS",
    "message": "ポイントが不足しています",
    "details": [{ "field": "drawCount", "message": "1 または 10 を指定してください" }]
  },
  "meta": { "requestId": "uuid" }
}
```

- `details` は入力値の検証エラーのみ。内部情報は含まない
- 想定外のエラーは `INTERNAL_ERROR` に丸められ、`requestId` だけが返る
- スタックトレース・SQL・接続先は**一切返さない**

### エラーコード

`src/lib/api/errors.ts` の `ERROR_CODES` が真実。主なもの:

| コード                     | HTTP | 意味                                   |
| -------------------------- | ---- | -------------------------------------- |
| `UNAUTHENTICATED`          | 401  | 未ログイン                             |
| `SESSION_REVOKED`          | 401  | セッションが失効した                   |
| `FORBIDDEN`                | 403  | 権限不足                               |
| `USER_SUSPENDED`           | 403  | アカウント停止中                       |
| `VALIDATION_ERROR`         | 400  | 入力値が不正                           |
| `NOT_FOUND`                | 404  | 対象が存在しない                       |
| `INSUFFICIENT_POINTS`      | 400  | ポイント不足                           |
| `CAMPAIGN_NOT_ON_SALE`     | 409  | 販売していない                         |
| `CAMPAIGN_OUT_OF_PERIOD`   | 409  | 販売期間外                             |
| `INSUFFICIENT_SLOTS`       | 409  | 残り口数不足                           |
| `PURCHASE_LIMIT_EXCEEDED`  | 409  | 購入上限超過                           |
| `PRIZE_NOT_UNDECIDED`      | 409  | すでに交換・申請済み                   |
| `PRIZE_ALREADY_REQUESTED`  | 409  | 発送申請中                             |
| `IDEMPOTENCY_KEY_REQUIRED` | 400  | `Idempotency-Key` ヘッダが無い         |
| `IDEMPOTENCY_KEY_CONFLICT` | 409  | 同じキーで異なる内容                   |
| `REQUEST_IN_PROGRESS`      | 409  | 同一リクエストを処理中                 |
| `RATE_LIMITED`             | 429  | レート制限（`Retry-After` ヘッダあり） |
| `INTERNAL_ERROR`           | 500  | 想定外のエラー                         |

### 認証

Cookie ベースのセッション。`withApi` の `auth` オプションで要求レベルを指定する。

| 値      | 意味                                                 |
| ------- | ---------------------------------------------------- |
| `none`  | 認証不要                                             |
| `user`  | ログイン必須。`status = ACTIVE` であること           |
| `admin` | 管理ロール必須。加えて `permission` で個別権限を検査 |

### 冪等性

副作用のある API は `Idempotency-Key` ヘッダ（クライアント生成の一意文字列）が必須。

- 同じキー・同じ内容 → 記録済みレスポンスを返す（`Idempotency-Replayed: true`）
- 同じキー・異なる内容 → `IDEMPOTENCY_KEY_CONFLICT`
- 処理中 → `REQUEST_IN_PROGRESS`（しばらく待って同じキーで再送する）
- キーの保持期間は 24 時間

### レート制限

| ルール     | 上限         |
| ---------- | ------------ |
| `login`    | 5 回 / 15 分 |
| `signup`   | 3 回 / 60 分 |
| `draw`     | 60 回 / 分   |
| `mutation` | 30 回 / 分   |
| `read`     | 120 回 / 分  |
| `admin`    | 60 回 / 分   |
| `webhook`  | 300 回 / 分  |

識別子はログイン済みなら `userId`、未ログインなら IP。

### CSRF

Auth.js の CSRF トークンに加え、変更系メソッドでは `Origin` ヘッダを検証する。
`Origin` が無いリクエスト（Webhook・サーバー間通信）は署名検証で別途認証する。

---

## 2. エンドポイント一覧

凡例: 🔒 = 要ログイン / 🛡 = 要管理権限 / ♻️ = `Idempotency-Key` 必須

### システム

| メソッド | パス                    | 説明                                  | 実装       |
| -------- | ----------------------- | ------------------------------------- | ---------- |
| GET      | `/api/health`           | DB 到達性の確認（内部情報は返さない） | ✅ Phase 1 |
| GET      | `/api/placeholder/:key` | 架空カードのプレースホルダー SVG      | ✅ Phase 1 |

### 認証（Phase 2）

| メソッド | パス                      | 説明                            |
| -------- | ------------------------- | ------------------------------- |
| POST     | `/api/auth/signup`        | 新規会員登録                    |
| POST     | `/api/auth/[...nextauth]` | Auth.js（ログイン・ログアウト） |
| POST     | `/api/auth/logout-all`    | 🔒 全セッションの失効           |

### ユーザー（Phase 2〜3）

| メソッド | パス                    | 説明                                    |
| -------- | ----------------------- | --------------------------------------- |
| GET      | `/api/me`               | 🔒 プロフィール                         |
| PATCH    | `/api/me`               | 🔒 プロフィール更新                     |
| GET      | `/api/me/points`        | 🔒 保有ポイント（有償 / 無償 / 期限別） |
| GET      | `/api/me/point-history` | 🔒 ポイント履歴                         |
| GET      | `/api/me/draws`         | 🔒 抽選履歴                             |
| GET      | `/api/me/prizes`        | 🔒 当選商品一覧                         |
| GET      | `/api/me/shipments`     | 🔒 発送申請一覧                         |
| GET      | `/api/me/addresses`     | 🔒 配送先一覧                           |
| POST     | `/api/me/addresses`     | 🔒 配送先登録                           |
| PATCH    | `/api/me/addresses/:id` | 🔒 配送先更新                           |

### オリパ・抽選（Phase 4〜6）

| メソッド | パス                   | 説明                                                |
| -------- | ---------------------- | --------------------------------------------------- |
| GET      | `/api/oripas`          | 一覧（販売中 / 販売前 / 完売 / 終了）               |
| GET      | `/api/oripas/:slug`    | 詳細（ランク別の口数・確率・残り口数）              |
| POST     | `/api/oripas/:id/draw` | 🔒 ♻️ 抽選（`drawCount`: 1 または 10）              |
| GET      | `/api/draws/:id`       | 🔒 抽選結果の再取得（リロード・通信断からの復帰用） |

### 当選商品・発送（Phase 6〜7）

| メソッド | パス                                | 説明                                 |
| -------- | ----------------------------------- | ------------------------------------ |
| POST     | `/api/prizes/:id/exchange`          | 🔒 ♻️ ポイント交換（原則取消不可）   |
| POST     | `/api/shipping-requests`            | 🔒 ♻️ 発送申請（複数商品をまとめて） |
| POST     | `/api/shipping-requests/:id/cancel` | 🔒 ♻️ 発送申請の取消し               |

### テスト決済（Phase 3・開発専用）

| メソッド | パス                             | 説明                                         |
| -------- | -------------------------------- | -------------------------------------------- |
| POST     | `/api/test-payments`             | 🔒 ♻️ テスト決済の作成                       |
| POST     | `/api/test-payments/:id/confirm` | 🔒 ♻️ 決済確定（成功時のみ有償ポイント付与） |
| POST     | `/api/test-payments/:id/cancel`  | 🔒 ♻️ 取消し                                 |
| POST     | `/api/test-payments/:id/refund`  | 🛡 ♻️ 返金                                   |
| POST     | `/api/webhooks/mock-payment`     | Webhook 受信（署名検証あり・重複排除あり）   |

### 管理（Phase 2〜7）

| メソッド | パス                                     | 必要権限                              |
| -------- | ---------------------------------------- | ------------------------------------- |
| GET      | `/api/admin/dashboard`                   | `user:read`                           |
| GET      | `/api/admin/users`                       | `user:read`                           |
| GET      | `/api/admin/users/:id`                   | `user:read`                           |
| PATCH    | `/api/admin/users/:id/status`            | `user:update_status`（理由必須）      |
| POST     | `/api/admin/users/:id/point-adjustments` | `user:adjust_points`（理由必須）      |
| GET      | `/api/admin/inventories`                 | `inventory:read`                      |
| POST     | `/api/admin/inventories`                 | `inventory:write`                     |
| PATCH    | `/api/admin/inventories/:id`             | `inventory:write`                     |
| GET      | `/api/admin/oripas`                      | `oripa:read`                          |
| POST     | `/api/admin/oripas`                      | `oripa:write`                         |
| PATCH    | `/api/admin/oripas/:id`                  | `oripa:write`（DRAFT のみ）           |
| POST     | `/api/admin/oripas/:id/slots`            | `oripa:write`（スロット生成）         |
| POST     | `/api/admin/oripas/:id/publish`          | `oripa:publish`                       |
| POST     | `/api/admin/oripas/:id/suspend`          | `oripa:suspend`（理由必須）           |
| DELETE   | `/api/admin/oripas/:id/suspend`          | `oripa:suspend`（販売再開・理由必須） |
| GET      | `/api/admin/draws`                       | `draw:read`                           |
| GET      | `/api/admin/shipping-requests`           | `shipping:read`                       |
| PATCH    | `/api/admin/shipping-requests/:id`       | `shipping:update`                     |
| GET      | `/api/admin/audit-logs`                  | `audit:read`                          |

---

## 3. 実装済みエンドポイントの詳細

### `GET /api/health`

認証不要（Proxy の Basic 認証からも除外）。

```jsonc
// 200
{
  "success": true,
  "data": { "status": "ok", "database": true },
  "meta": { "requestId": "..." },
}
```

`status` は `ok` または `degraded`。DB の詳細・バージョン・接続先は返さない。

### `GET /api/placeholder/:key`

架空カードのプレースホルダー画像を SVG で生成して返す。
実在素材をリポジトリへ持たないための仕組み。

- `key` の形式: `placeholder:<rarity>:<hue>:<front|back>`
- `rarity` は `[A-Z]{1,4}`、`hue` は 0–359 に厳密に制限する（SVG への値の埋め込みを防ぐ）
- 形式が合わない場合は 404
- `Cache-Control: public, max-age=31536000, immutable`

### `GET /api/oripas`（Phase 4）

認証不要。公開済み（`published_at IS NOT NULL`）かつ下書き・アーカイブ以外を返す。

```jsonc
// 200
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "...",
        "slug": "sample-standard-01",
        "name": "サンプル・スタンダードオリパ",
        "thumbnailKey": "placeholder:SR:340:front",
        "pricePoints": 500,
        "totalSlots": 100,
        "remainingSlots": 100,
        "saleState": "ON_SALE",
        "salesStartAt": "2026-09-20T00:00:00.000Z",
        "salesEndAt": "2026-10-17T00:00:00.000Z",
        "topEffectTier": "JACKPOT",
      },
    ],
  },
}
```

`saleState` は DB の `status` そのままではなく、時刻と残り口数も見て決めた**表示用の状態**
（`ON_SALE` / `SCHEDULED` / `SOLD_OUT` / `ENDED` / `SUSPENDED`）。
「販売期間は始まっているが status が SCHEDULED のまま」というズレを画面へ持ち込まないため。

### `GET /api/oripas/:slug`（Phase 4）

認証不要。ランク別の確率と当たり残数を返す。

```jsonc
// 200 （抜粋）
{
  "success": true,
  "data": {
    "pricePoints": 500,
    "remainingSlots": 100,
    "tiers": [
      {
        "code": "S",
        "name": "S賞",
        "effectTier": "JACKPOT",
        "slotCount": 1,
        "remainingCount": 1,
        "odds": { "numerator": 1, "denominator": 100 },
        "oddsPercent": "1.000%",
        "oddsFraction": "1/100",
        "maxExchangePoints": 280000,
      },
    ],
    "topPrizes": [
      { "name": "...", "imageKey": "...", "exchangePoints": 280000, "drawn": false },
    ],
    "slotOrderCommit": "8f3c…（64 桁の SHA-256）",
    "revealedSeed": null,
  },
}
```

**この応答に含めてはならないもの**（実装とテストの両方で担保している）:

| 値                | 理由                                         |
| ----------------- | -------------------------------------------- |
| `draw_order`      | 次に何が出るかが分かってしまう               |
| `slot_order_seed` | 順序を計算できてしまう（公開後のみ返す）     |
| スロットの `id`   | クライアントから当たりを狙い撃ちできてしまう |

`revealedSeed` は `slot_order_revealed_at` が設定されている場合のみ返る。
販売終了後にシードを公開することで、第三者が
`SHA-256(campaignId | serverSeed | 抽選順のランクコード列)` を再計算し、
公開時のコミットハッシュと一致することを検証できる。

### `POST /api/admin/oripas`（Phase 4）

`oripa:write`。冪等性キー必須。下書き（DRAFT）を作る。

- ランクの口数合計が `totalSlots` と一致しない場合は Zod が 400 で拒否する
- 確率を直接入力する項目は**無い**。確率はランクの口数から導出される

### `POST /api/admin/oripas/:id/slots`（Phase 4）

`oripa:write`。冪等性キー必須。DRAFT のみ。

ランクごとに使用する在庫 ID と、不足分を埋める汎用景品コードを指定する。
既存スロットは一度すべて削除され、在庫の割当も解除されてから作り直される
（部分更新にすると、途中で失敗したときに整合性が崩れるため）。

応答にコミットハッシュとシードは**含めない**。公開時に確定させる。

```jsonc
// 200
{ "success": true, "data": { "totalSlots": 100, "perTier": [{ "tierCode": "S", "count": 1 }] } }
```

### `POST /api/admin/oripas/:id/publish`（Phase 4）

`oripa:publish`（`oripa:write` とは別権限）。冪等性キー必須。本文は `{ "confirm": true }`。

公開条件をすべて満たしていない場合は `CAMPAIGN_NOT_PUBLISHABLE` を
`details` 付きで返す。満たしている場合は以下を確定させる。

- コミットハッシュ（保存済みスロットの `draw_order` 昇順のランクコード列から計算）
- シード（**応答にも監査ログにも含めない**）
- 価格・総口数・ランク構成のハッシュ（`config_locked_hash`）

以降は DB トリガが価格・総口数・スロット構成・ランク構成の変更を拒否する。

### `POST` / `DELETE /api/admin/oripas/:id/suspend`（Phase 4）

`oripa:suspend`。冪等性キー必須。理由（5 文字以上）必須。

- `POST` … 販売停止。ACTIVE / SCHEDULED のみ
- `DELETE` … 停止の解除。販売期間と現在時刻から ACTIVE / SCHEDULED / ENDED を決める

いずれも監査ログへ理由つきで記録される。停止しても確定済みの抽選結果には影響しない。

### `GET` / `POST /api/admin/inventories`、`PATCH /api/admin/inventories/:id`（Phase 4）

`inventory:read` / `inventory:write`。在庫は**物理個体ごとに 1 件**。

`PATCH` で手動変更できる状態は `AVAILABLE` / `DAMAGED` / `LOST` のみ。
`WON` / `SHIPPING_REQUESTED` / `SHIPPED` / `EXCHANGED` は抽選・発送・交換の処理が設定する。
`DAMAGED` / `LOST` へ変更する場合は理由が必須。
公開済みオリパへ割当済みの在庫は、交換ポイントと状態を変更できない。
