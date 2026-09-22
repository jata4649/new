# 権限一覧（RBAC）

真実は `src/lib/auth/permissions.ts` の `ROLE_PERMISSIONS`。
画面の出し分けも同じテーブルを参照するため、表示と実権限がズレない。

---

## 1. ロール

| ロール        | 想定する担当                         | 管理画面 |
| ------------- | ------------------------------------ | -------- |
| `USER`        | 一般ユーザー                         | ×        |
| `SUPPORT`     | 問い合わせ対応。参照のみ             | ○        |
| `OPERATOR`    | 在庫登録・オリパ作成・発送作業       | ○        |
| `ADMIN`       | 運営責任者。公開・停止・ポイント調整 | ○        |
| `SUPER_ADMIN` | ロール管理を含むすべて               | ○        |

MVP では実質 `USER` と `ADMIN` のみを使用する。
`User.role` を正とし、`UserRoleAssignment` テーブルは将来の複数ロール・
期限付き権限のために用意してあるが使用しない。

---

## 2. 権限マトリクス

| 権限                   | 内容                             | USER | SUPPORT | OPERATOR | ADMIN | SUPER_ADMIN |
| ---------------------- | -------------------------------- | :--: | :-----: | :------: | :---: | :---------: |
| `user:read`            | ユーザー一覧・詳細の参照         |  −   |    ○    |    ○     |   ○   |      ○      |
| `user:update_status`   | 停止・解除（**理由必須**）       |  −   |    −    |    −     |   ○   |      ○      |
| `user:adjust_points`   | ポイント調整（**理由必須**）     |  −   |    −    |    −     |   ○   |      ○      |
| `inventory:read`       | 在庫の参照                       |  −   |    ○    |    ○     |   ○   |      ○      |
| `inventory:write`      | 在庫の登録・編集                 |  −   |    −    |    ○     |   ○   |      ○      |
| `oripa:read`           | オリパの参照（下書き含む）       |  −   |    ○    |    ○     |   ○   |      ○      |
| `oripa:write`          | オリパの作成・編集（DRAFT のみ） |  −   |    −    |    ○     |   ○   |      ○      |
| `oripa:publish`        | オリパの公開                     |  −   |    −    |    −     |   ○   |      ○      |
| `oripa:suspend`        | 販売停止（**理由必須**）         |  −   |    −    |    −     |   ○   |      ○      |
| `draw:read`            | 抽選履歴の参照                   |  −   |    ○    |    ○     |   ○   |      ○      |
| `shipping:read`        | 発送申請の参照                   |  −   |    ○    |    ○     |   ○   |      ○      |
| `shipping:update`      | ステータス更新・追跡番号入力     |  −   |    −    |    ○     |   ○   |      ○      |
| `audit:read`           | 監査ログの参照                   |  −   |    −    |    −     |   ○   |      ○      |
| `admin:manage_roles`   | ロールの付与・剥奪               |  −   |    −    |    −     |   −   |      ○      |
| `test_payment:operate` | Mock 決済の操作（開発用）        |  −   |    −    |    −     |   ○   |      ○      |

> `test_payment:operate` は本番相当環境では誰にも付与しないこと
> （[11-production-checklist.md](./11-production-checklist.md) §B）。

---

## 3. 一般ユーザーができること

権限テーブルには載らない「自分のデータに対する操作」。
所有者チェックは各サービス層で必ず行う（`userId` の一致確認）。

| 操作                       | 条件                                                |
| -------------------------- | --------------------------------------------------- |
| 抽選する                   | `status = ACTIVE` かつ 残高・上限・残り口数を満たす |
| 当選商品をポイント交換する | 自分の商品かつ `UNDECIDED`                          |
| 発送申請する               | 自分の商品かつ `UNDECIDED` かつ `shippable`         |
| 発送申請を取り消す         | 自分の申請かつ `REQUESTED`（発送準備前）            |
| 配送先を登録・編集する     | 自分の住所のみ                                      |
| 履歴を参照する             | 自分の履歴のみ                                      |

**`SUSPENDED` / `WITHDRAWN` のユーザーは、抽選・交換・発送申請をすべて行えない。**
`withApi` がセッション解決時に一括で弾く。

---

## 4. 理由入力が必須の操作

`src/lib/auth/permissions.ts` の `REASON_REQUIRED_ACTIONS` に定義。
UI の確認ダイアログ・API の Zod スキーマ・`audit_logs` の 3 か所で担保する。

- `USER_SUSPEND` / `USER_WITHDRAW`
- `POINT_ADJUST`
- `ORIPA_SUSPEND`
- `SHIPPING_CANCEL`
- `INVENTORY_MARK_DAMAGED` / `INVENTORY_MARK_LOST`

`point_ledger_entries` の `ADJUSTMENT` / `REVERSAL` は DB の CHECK 制約でも
理由を必須にしている。

---

## 5. 判定の場所

| 層                              | 役割                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| Proxy（`src/proxy.ts`）         | クローズドテストの Basic 認証、管理画面の IP 制限のみ。**認可判定はしない** |
| `withApi` / `withIdempotentApi` | 認証・ステータス確認・RBAC の本判定                                         |
| サービス層                      | 所有者チェック（`userId` の一致）、状態遷移の妥当性                         |
| DB                              | 一意制約・CHECK 制約による最終防衛                                          |

Edge ランタイムでは DB を引けないため、Proxy での判定を認可の根拠にしてはならない
（[01-architecture.md](./01-architecture.md) §8）。
