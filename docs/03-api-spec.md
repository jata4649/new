# API 仕様書

Phase 1 時点では**共通仕様とエンドポイント一覧**を定める。
各エンドポイントのリクエスト・レスポンス詳細は、実装フェーズで Zod スキーマとともに
この文書へ追記する。

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
| GET      | `/api/oripas/:id`      | 詳細（ランク別の口数・確率・残り口数）              |
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

| メソッド | パス                                     | 必要権限                         |
| -------- | ---------------------------------------- | -------------------------------- |
| GET      | `/api/admin/dashboard`                   | `user:read`                      |
| GET      | `/api/admin/users`                       | `user:read`                      |
| GET      | `/api/admin/users/:id`                   | `user:read`                      |
| PATCH    | `/api/admin/users/:id/status`            | `user:update_status`（理由必須） |
| POST     | `/api/admin/users/:id/point-adjustments` | `user:adjust_points`（理由必須） |
| GET      | `/api/admin/inventories`                 | `inventory:read`                 |
| POST     | `/api/admin/inventories`                 | `inventory:write`                |
| PATCH    | `/api/admin/inventories/:id`             | `inventory:write`                |
| GET      | `/api/admin/oripas`                      | `oripa:read`                     |
| POST     | `/api/admin/oripas`                      | `oripa:write`                    |
| PATCH    | `/api/admin/oripas/:id`                  | `oripa:write`（DRAFT のみ）      |
| POST     | `/api/admin/oripas/:id/slots`            | `oripa:write`（スロット生成）    |
| POST     | `/api/admin/oripas/:id/publish`          | `oripa:publish`                  |
| POST     | `/api/admin/oripas/:id/suspend`          | `oripa:suspend`（理由必須）      |
| GET      | `/api/admin/draws`                       | `draw:read`                      |
| GET      | `/api/admin/shipping-requests`           | `shipping:read`                  |
| PATCH    | `/api/admin/shipping-requests/:id`       | `shipping:update`                |
| GET      | `/api/admin/audit-logs`                  | `audit:read`                     |

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
