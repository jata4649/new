# 障害発生時の復旧手順（ランブック）

現象から入って、確認・対応の順に書いている。
**金銭に関わる訂正は、台帳を書き換えるのではなく打ち消しの記帳で行う。**

---

## 0. 共通の初動

1. 影響範囲を特定する（全体か、特定オリパか、特定ユーザーか）
2. 被害が広がるなら**まず止める**（該当オリパを `SUSPENDED` にする等）
3. 記録を残す（`audit_logs`・アプリログ・対応内容）
4. 原因の特定より**整合性の保護**を優先する

エラーの追跡には `requestId` を使う。
ユーザーへ返るエラー本文には `meta.requestId` が含まれるため、
問い合わせ時にこれを聞けばサーバーログと突き合わせられる。

---

## 1. ポイント残高が台帳と合わない

### 確認

```bash
pnpm points:reconcile
# 終了コード 1 なら不整合あり。--json で機械可読な出力も得られる
```

| 検出された種別         | 意味                                                  |
| ---------------------- | ----------------------------------------------------- |
| `LEDGER_VS_ACCOUNT`    | 台帳の合計と口座残高が不一致                          |
| `LOTS_VS_ACCOUNT`      | ロット残高の合計と口座残高が不一致                    |
| `LOT_RANGE`            | ロット残高が範囲外（DB CHECK が効いていれば起きない） |
| `CONSUMPTION_MISMATCH` | 消費明細の合計とロットの減少分が不一致                |

### 対応

**台帳が真実。直すのは `point_accounts` 側。**

1. 対象ユーザーの台帳を時系列で確認する

```sql
SELECT created_at, tx_type, point_type, amount, balance_after, reason, source_type, source_id
FROM point_ledger_entries
WHERE user_id = $1
ORDER BY created_at, id;
```

2. どの記帳から食い違っているかを特定する（`balance_after` の連続性を見る）
3. 原因がアプリのバグなら、**先に修正をデプロイする**（直しても再発するため）
4. キャッシュのズレだけなら、台帳から残高を再計算して `point_accounts` を更新する

```sql
-- 再計算（確認してから実行すること）
UPDATE point_accounts a
SET paid_balance = COALESCE(p.total, 0),
    free_balance = COALESCE(f.total, 0),
    version = a.version + 1
FROM (SELECT user_id, SUM(amount_remaining) AS total FROM point_lots
      WHERE point_type='PAID' AND expires_at > now() GROUP BY user_id) p
FULL JOIN (SELECT user_id, SUM(amount_remaining) AS total FROM point_lots
      WHERE point_type='FREE' AND expires_at > now() GROUP BY user_id) f
  USING (user_id)
WHERE a.user_id = COALESCE(p.user_id, f.user_id) AND a.user_id = $1;
```

5. 記帳そのものが誤っていた場合は、`REVERSAL`（理由必須）で打ち消してから
   正しい記帳を追加する。**元の行は絶対に書き換えない**（トリガが拒否する）
6. `pnpm points:reconcile` で 0 件になることを確認する

---

## 2. 「ポイントが減ったのに抽選されていない」という問い合わせ

### 原則、起こり得ない

抽選はポイント消費と同一トランザクションで実行される。
失敗すればポイントも戻る（そもそも減らない）。

### 確認

```sql
-- 該当時刻の DRAW 記帳と抽選トランザクションの対応
SELECT e.id AS ledger_id, e.amount, e.created_at, d.id AS draw_id, d.draw_count
FROM point_ledger_entries e
LEFT JOIN draw_transactions d ON d.ledger_entry_id = e.id
WHERE e.user_id = $1 AND e.tx_type = 'DRAW'
ORDER BY e.created_at DESC LIMIT 20;
```

- `draw_id` が NULL の DRAW 記帳があれば、それは**重大なバグ**。
  トランザクション境界が壊れている可能性があるため、該当コードパスを調査する
- すべて対応が取れていれば、ユーザーには抽選履歴（`/mypage/draws`）を案内する
  （演出を閉じたために結果を見ていないだけのことが多い）

### 対応

本当に消費だけが記録されていた場合は、`REVERSAL` で返金する。
理由に調査結果と `requestId` を記載する。

---

## 3. 同じスロットが二重当選した

### 確認

```sql
SELECT slot_id, count(*) FROM draw_results GROUP BY slot_id HAVING count(*) > 1;
```

`draw_results.slot_id` は UNIQUE なので、通常は DB が拒否する。
ここに行が出るのは制約が失われている場合のみ。

```sql
-- 制約の存在確認
SELECT conname FROM pg_constraint WHERE conrelid = 'draw_results'::regclass;
```

### 対応

1. **該当オリパを即座に `SUSPENDED` にする**（理由入力必須）
2. 制約が消えていた場合、マイグレーションの適用漏れを疑う（`prisma migrate status`）
3. 重複した当選のうち、後発を取り消す（`user_prizes` を `CANCELLED`、
   相当額を `ADJUSTMENT` で補填。理由に経緯を記載）
4. 対象ユーザーへ個別に連絡する
5. 制約を復旧し、再発しないことを確認してから販売を再開する

---

## 4. 残り口数の表示がおかしい

### 確認

```sql
SELECT c.id, c.slug, c.remaining_slots,
       count(s.id) FILTER (WHERE s.status = 'AVAILABLE') AS actual
FROM oripa_campaigns c
LEFT JOIN oripa_slots s ON s.campaign_id = c.id
GROUP BY c.id, c.slug, c.remaining_slots
HAVING c.remaining_slots <> count(s.id) FILTER (WHERE s.status = 'AVAILABLE');
```

### 対応

`oripa_slots` が真実、`remaining_slots` はキャッシュ。

```sql
UPDATE oripa_campaigns c
SET remaining_slots = sub.actual
FROM (SELECT campaign_id, count(*) FILTER (WHERE status='AVAILABLE') AS actual
      FROM oripa_slots GROUP BY campaign_id) sub
WHERE c.id = sub.campaign_id AND c.id = $1;
```

売り切れているのに `ACTIVE` のままなら `SOLD_OUT` へ遷移させる。

---

## 5. 決済が成功したのにポイントが付与されない

### 確認

```sql
SELECT p.id, p.status, p.amount_yen, p.grant_points, p.grant_ledger_entry_id, p.confirmed_at
FROM payment_transactions p WHERE p.id = $1;

-- Webhook の受信状況
SELECT event_id, event_type, occurred_at, received_at, signature_valid, applied, skip_reason
FROM payment_webhook_events
WHERE payment_transaction_id = $1 ORDER BY occurred_at;
```

| 状況                                                    | 原因                                                 |
| ------------------------------------------------------- | ---------------------------------------------------- |
| Webhook が 1 件も無い                                   | 到達していない。プロバイダ側の再送設定を確認         |
| `signature_valid = false`                               | 署名鍵の不一致。`MOCK_PAYMENT_WEBHOOK_SECRET` を確認 |
| `applied = false` で `skip_reason` あり                 | 重複または順序逆転として正しく無視された             |
| `status = SUCCEEDED` で `grant_ledger_entry_id` が NULL | **バグ**。付与処理が別トランザクションになっている   |

### 対応

- 未到達なら、プロバイダの管理画面から Webhook を再送する
- 二重付与は `point_ledger_entries` の
  `(source_type, source_id, tx_type)` UNIQUE が防ぐため、再送は安全

---

## 6. 同じリクエストが二重に処理された疑い

### 確認

```sql
SELECT scope, key, state, response_code, created_at
FROM idempotency_keys WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20;
```

同一キーの行が 2 件以上あれば UNIQUE 制約が失われている。

```sql
SELECT indexname FROM pg_indexes
WHERE tablename = 'idempotency_keys';
```

### 対応

制約の復旧を最優先。並行して、重複実行された副作用を
`REVERSAL`・`user_prizes` の `CANCELLED` 等で打ち消す。

---

## 7. データベースへ接続できない

1. `/api/health` を確認する（`{"status":"degraded","database":false}` が返る）
2. DB 側の状態を確認する

```bash
docker compose ps postgres
docker compose logs --tail=100 postgres
```

3. コネクション数を確認する

```sql
SELECT count(*), state FROM pg_stat_activity
WHERE datname = 'oripa_dev' GROUP BY state;
```

4. `idle in transaction` が多い場合、**長時間トランザクションが疑われる**

```sql
SELECT pid, now() - xact_start AS duration, state, left(query, 120)
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND now() - xact_start > interval '10 seconds'
ORDER BY duration DESC;
```

トランザクション内で外部 I/O を行っているコードが無いか確認する
（禁止事項。`src/server/db.ts` のコメント参照）。
緊急時は `pg_terminate_backend(pid)` で切断する。

---

## 8. 抽選が極端に遅い / タイムアウトする

### 確認

```sql
-- 抽選ホットパスのインデックスが使われているか
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM oripa_slots
WHERE campaign_id = $1 AND status = 'AVAILABLE'
ORDER BY draw_order LIMIT 10 FOR UPDATE SKIP LOCKED;
-- oripa_slots_available_draw_order_idx を使っていること
```

- Seq Scan になっていれば、部分インデックスが失われている
- ロック待ちが長い場合は `remaining_slots` のホットロウ競合
  （[10-known-limitations.md](./10-known-limitations.md) §1-2）

### 対応

- インデックスの復旧
- 一時的な負荷ならレート制限（`RATE_LIMIT_RULES.draw`）を絞る
- 恒常的ならシャード化カウンタの導入を検討する

---

## 9. Redis が落ちた

**サービスは継続する。** レート制限が無効化されるだけで、
ポイント・抽選の整合性には影響しない（正式なデータソースは PostgreSQL のみ）。

ただし総当たり攻撃に弱くなるため、
長引く場合は `SITE_ACCESS_MODE=closed` の Basic 認証で入口を絞るか、
一時的にサービスを停止する判断をする。

---

## 10. 不正な抽選・確率改変が疑われた場合

1. 該当オリパを `SUSPENDED` にする
2. 監査ログで公開後の変更を確認する

```sql
SELECT created_at, actor_id, action, reason, before, after
FROM audit_logs
WHERE target_type = 'ORIPA_CAMPAIGN' AND target_id = $1
ORDER BY created_at;
```

3. コミットハッシュを検証する

```sql
SELECT slot_order_commit, config_locked_hash, published_at, published_by
FROM oripa_campaigns WHERE id = $1;
```

保存されている `slot_order_commit` と、
現在のスロット構成から再計算したハッシュ（`buildSlotOrderCommitment`）が
一致すれば、公開後に景品構成は変更されていない。

4. 一致しない場合は、いつ・誰が変更したかを `audit_logs` から特定し、
   影響を受けたユーザーへの補填方針を決める

---

## 連絡先・エスカレーション

> 本番化の前に、担当者・連絡手段・エスカレーション基準をここへ記載すること。
