# 抽選処理の説明書

有限プール抽選の方式・同時実行制御・公正性の検証方法。

---

## 1. 方式：事前シャッフル + `FOR UPDATE SKIP LOCKED`

販売開始前に全スロットを作成し、**CSPRNG で決めた順列（`draw_order`）を各スロットへ
割り当てておく**。抽選は「シャッフル済みのデッキを上から引く」操作になる。

```
公開時（1 回だけ）
  ┌─────────────────────────────────────────────────┐
  │ 総口数 5,000 のスロットを作成                     │
  │   S賞 1 / A賞 4 / B賞 20 / C賞 100 / D賞 4,875   │
  │                                                  │
  │ crypto.randomInt による Fisher-Yates で          │
  │ 1..5000 の順列を生成 → draw_order へ割当         │
  │                                                  │
  │ SHA-256(campaignId | serverSeed | ランク列)      │
  │   → campaign.slot_order_commit に保存            │
  └─────────────────────────────────────────────────┘

抽選時（毎回）
  ┌─────────────────────────────────────────────────┐
  │ SELECT ... WHERE status='AVAILABLE'              │
  │   ORDER BY draw_order LIMIT n                    │
  │   FOR UPDATE SKIP LOCKED                         │
  └─────────────────────────────────────────────────┘
```

### なぜこの方式か

| 方式                                          | 計算量          | 同時実行         | 分布       | 監査可能性 |
| --------------------------------------------- | --------------- | ---------------- | ---------- | ---------- |
| A. `ORDER BY random() FOR UPDATE SKIP LOCKED` | O(n) 毎回全走査 | ○                | ○          | △          |
| B. `OFFSET floor(random()*remaining)`         | O(offset)       | **× 競合で偏る** | △          | △          |
| **C. 事前シャッフル + `draw_order` 昇順**     | **O(log n)**    | ○                | **◎ 厳密** | **◎**      |

C を採用する理由は 3 つ。

**(1) 分布が厳密に正しい**
販売前に 1 回だけ順列を作るため、抽選は非復元抽出として数学的に一様になる。
残り口数が減れば確率が正しく変動する（有限プールの本質）。

**(2) 競合に強い**
`WHERE campaign_id=? AND status='AVAILABLE' ORDER BY draw_order LIMIT n FOR UPDATE
SKIP LOCKED` は部分インデックス
（`oripa_slots_available_draw_order_idx`）の先頭だけを見る。
同時に 1,000 リクエストが来ても各々が別の行を即座に掴み、
`SKIP LOCKED` によりロック待ち行列が発生しない。
DRAWN になった行は部分インデックスから物理的に消えるため、
売れ進んでも性能が劣化しない。

**(3) 後から確率を変えられないことを証明できる**
公開時に `SHA-256(campaignId | serverSeed | draw_order 昇順のランクコード列)` を
`slot_order_commit` へ保存する。販売終了後に `serverSeed` を公開すれば、
第三者が「途中で景品構成が差し替えられていないこと」を検証できる
（コミット＆リビール方式）。

### 乱数

- `node:crypto` の `randomInt()` を使用（拒否サンプリングによりモジュロバイアスが無い）
- `Math.random()` の使用は ESLint（`no-restricted-properties`）で禁止
- 一様性は `src/tests/unit/crypto/random.test.ts` でカイ二乗検定により検証

### この方式の弱点（既知の制約）

事前シャッフルである以上、**DB へ直接アクセスできる人物は「次に何が出るか」を
知りうる**。対策：

- `draw_order` を API・管理画面へ一切露出させない
- 本番では DBA ロールを分離し、踏み台経由のアクセスに監査ログを付ける
- コミットハッシュを公開し、事後検証を可能にする

詳細は [10-known-limitations.md](./10-known-limitations.md) を参照。

---

## 2. 抽選トランザクション（1 回抽選・10 連とも同一コードパス）

`drawCount` をパラメータ化し、`LIMIT 1` / `LIMIT 10` の違いだけにする。
分岐を作らないことでテスト対象を減らす。

```sql
BEGIN;  -- READ COMMITTED, timeout 10s

-- 1. 冪等性キーを登録（重複なら unique violation → 記録済みレスポンスを返す）
INSERT INTO idempotency_keys (user_id, scope, key, request_hash, state, expires_at)
VALUES ($1, 'draw', $2, $3, 'IN_PROGRESS', now() + interval '24 hours');

-- 2. ユーザーが ACTIVE か
SELECT status FROM users WHERE id = $1 FOR SHARE;

-- 3. オリパが ACTIVE か / 販売期間内か（サーバー時刻で判定）
SELECT status, price_points, per_user_limit, sales_start_at, sales_end_at
FROM oripa_campaigns WHERE id = $4;

-- 4. 購入上限（条件付き UPSERT。0 行なら PURCHASE_LIMIT_EXCEEDED）
INSERT INTO user_campaign_counters (user_id, campaign_id, drawn_count)
VALUES ($1, $4, $n)
ON CONFLICT (user_id, campaign_id)
DO UPDATE SET drawn_count = user_campaign_counters.drawn_count + $n
WHERE user_campaign_counters.drawn_count + $n <= $limit;

-- 5. ★スロット確保（ここが核心）
SELECT id, inventory_id, generic_prize_id, tier_id, exchange_points
FROM oripa_slots
WHERE campaign_id = $4 AND status = 'AVAILABLE'
ORDER BY draw_order
LIMIT $n
FOR UPDATE SKIP LOCKED;
-- 取得件数 < n → INSUFFICIENT_SLOTS で ROLLBACK

-- 6. ポイント消費（FIFO）
SELECT id, amount_remaining FROM point_lots
WHERE user_id = $1 AND amount_remaining > 0 AND expires_at > now()
ORDER BY <消費順序ポリシー>
FOR UPDATE;
-- 合計 < 必要額 → INSUFFICIENT_POINTS で ROLLBACK
UPDATE point_lots SET amount_remaining = amount_remaining - $x
  WHERE id = $lot AND amount_remaining >= $x;
INSERT INTO point_ledger_entries (tx_type, amount, ...) VALUES ('DRAW', -$total, ...);
INSERT INTO point_lot_consumptions (...);
UPDATE point_accounts SET paid_balance = ..., free_balance = ..., version = version + 1
  WHERE user_id = $1 AND paid_balance >= $p AND free_balance >= $f;

-- 7〜11. 抽選記録
INSERT INTO draw_transactions (...);
UPDATE oripa_slots SET status='DRAWN', drawn_by_user_id=$1, drawn_at=now()
  WHERE id = ANY($slots) AND status='AVAILABLE';   -- 件数不一致 → ROLLBACK
UPDATE inventories SET status='WON' WHERE id = ANY($inventories);
INSERT INTO draw_results (...);    -- 交換ポイント等をスナップショット
INSERT INTO user_prizes (status='UNDECIDED', ...);

-- 12. 残り口数（★最後に更新してホットロウの保持時間を最小化）
UPDATE oripa_campaigns SET remaining_slots = remaining_slots - $n
  WHERE id = $4 AND remaining_slots >= $n;

-- 13〜14. 監査・冪等性キーの確定
INSERT INTO audit_logs (...);
UPDATE idempotency_keys SET state='SUCCEEDED', response_body=$json WHERE id=$key;

COMMIT;
-- ここで初めて結果をクライアントへ返す → 演出開始
```

### 「ポイントだけ減る」が起きない理由

全操作が単一トランザクション内にある。途中でどれか 1 つでも失敗（0 行更新を含む）
すればロールバックされ、ポイントは 1 ポイントも減らない。

**「ポイントを減らしてから抽選する」という 2 段構えを一切作らない**ことが最大の対策。

---

## 3. 冪等性

冪等性キーの INSERT を、業務処理と**同じトランザクションの最初**に置く。

```
先行リクエスト        : INSERT 成功 → 業務処理 → レスポンス記録 → COMMIT
並行する重複リクエスト : 同じキーの INSERT がユニークインデックス上でブロック
                        ├ 先行が COMMIT → unique violation
                        │   → 自分のトランザクションはまるごと ROLLBACK（副作用ゼロ）
                        │   → 記録済みレスポンスを読み直して返す（リプレイ）
                        └ 先行が ROLLBACK → 行が消えて INSERT 成功 → 自分が処理する
```

**別トランザクションで先にキーを登録しない理由**：
キー登録と業務処理が別トランザクションだと、業務処理だけ成功してキー更新に失敗した
場合に「実行済みなのに未記録」が生まれ、再送で二重実行されうる。
同一トランザクションに入れればその隙間が消える。

実装は `src/lib/idempotency/index.ts`。
レスポンスが再生されたかは `Idempotency-Replayed` ヘッダで判別できる
（演出の再生抑制に使う）。

---

## 4. 演出との関係

要件「演出より先にサーバーで結果を確定する」への対応。

1. サーバーが**コミット済みの結果**を返す
2. クライアントは `drawTransactionId` を受け取り、演出を開始する
3. 演出を途中で閉じても結果は失われない（DB に確定済み）
4. リロード後も `GET /api/me/draws` / `GET /api/draws/:id` で確認できる
5. 通信断で再送しても、冪等性キーにより同じ結果が返る（再抽選されない）
6. 演出の再生に失敗した場合はそのまま結果画面へ進む

---

## 5. 同時実行の検証

`src/tests/concurrency/` で以下を検証する（Phase 5）。

| ケース                            | 期待する結果                                            |
| --------------------------------- | ------------------------------------------------------- |
| 残り 1 口へ 10 ユーザーが同時抽選 | 1 人だけ成功、9 人は `INSUFFICIENT_SLOTS`。二重当選なし |
| 同じ冪等性キーを 10 並列で送信    | 1 回だけ実行され、10 件とも同じレスポンス               |
| 10 連の途中で在庫が尽きる         | 全体がロールバックされ、ポイントは減らない              |
| 残高ちょうどの同時 2 抽選         | 1 つだけ成功、残高は負にならない                        |

---

## 6. 公開条件

`ACTIVE` にする前に、以下をすべて満たすことをサーバー側で検証する。

- [ ] 景品ランクの `slot_count` 合計 == `total_slots`
- [ ] 生成済みスロット数 == `total_slots`
- [ ] 全スロットに `inventory_id` または `generic_prize_id` のいずれかが設定されている
      （DB の CHECK 制約 `oripa_slots_prize_source_exclusive_check` でも担保）
- [ ] `price_points >= 1`
- [ ] 全スロットの `exchange_points >= 0`
- [ ] `sales_end_at > sales_start_at`
- [ ] 同一物理在庫が重複割当されていない（DB の UNIQUE で担保）

公開時に `published_at` / `published_by` / `slot_order_commit` / `slot_order_seed` /
`config_locked_hash` を記録する。`ACTIVE` 以降は価格・総口数・景品スロット・当選確率を
変更できない。やむを得ない販売停止は可能だが、理由入力を必須とし `audit_logs` へ記録する。

### 実装の対応

| 内容                         | 実装                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| スロット生成・事前シャッフル | `src/modules/oripa/slots.ts` の `generateSlots`             |
| コミットハッシュの計算       | 同 `buildCommitment`（**保存済みスロットの順序**から計算）  |
| 公開条件の検証               | `src/modules/oripa/service.ts` の `checkPublishable`        |
| 公開処理                     | 同 `publishOripa`                                           |
| 事後検証                     | `src/modules/oripa/slots.ts` の `verifySlotOrderCommitment` |

コミットハッシュを `generateSlots` ではなく公開時に作っているのは、
下書きを作り直すたびに「公開していないのにコミットした」状態が生まれるのを避けるため。
また、メモリ上の計画値ではなく DB に保存された順序から計算することで、
保存に失敗した分がハッシュに含まれるズレを防いでいる。

### 公開後の改変を DB でも拒否する

アプリ層の検証だけでは、管理画面のバグや DB への直接アクセスを防げない。
`prisma/migrations/20260922000003_commit_reveal` で 3 つのトリガを追加している。

| トリガ                                | 拒否する操作                                                    |
| ------------------------------------- | --------------------------------------------------------------- |
| `oripa_campaigns_immutable_trigger`   | 公開済みの価格・総口数・コミットハッシュ・シードの変更          |
| `oripa_slots_immutable_trigger`       | 公開済みスロットの追加・削除・景品差し替え・`draw_order` の変更 |
| `oripa_prize_tiers_immutable_trigger` | 公開済みランクの追加・削除・口数変更（＝確率の後出し変更）      |

いずれもメッセージが `CAMPAIGN_IMMUTABLE:` で始まる。
抽選による `AVAILABLE` → `DRAWN` の遷移だけは許可している。
