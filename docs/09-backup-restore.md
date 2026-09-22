# バックアップとリストア手順

> **本番化の前に、この手順どおりで実際に復旧できることを必ず一度試すこと。**
> 試していないバックアップは、バックアップではない。

---

## 1. 何を守るのか

| 対象                                         | 重要度     | 失った場合の影響                                 |
| -------------------------------------------- | ---------- | ------------------------------------------------ |
| PostgreSQL（台帳・抽選履歴・在庫・監査ログ） | **最重要** | 復元不可能。金銭事故・法的リスク                 |
| アップロード画像（`UPLOAD_DIR`）             | 中         | 商品画像が表示されない（再アップロードで復旧可） |
| Redis                                        | 低         | レート制限カウンタのみ。復旧不要                 |
| 環境変数・秘密情報                           | 高         | 起動不能。秘密管理サービス側で別途管理する       |

Redis はレート制限とキャッシュにしか使っておらず、
落ちてもデータ整合性に影響しないためバックアップ対象外。

---

## 2. バックアップ

### 2-1. 開発環境（Docker Compose）

```bash
# 論理バックアップ（圧縮カスタム形式）
docker compose exec -T postgres \
  pg_dump -U oripa -d oripa_dev -Fc \
  > backup/oripa_dev_$(date +%Y%m%d_%H%M%S).dump

# スキーマのみ（差分確認用）
docker compose exec -T postgres \
  pg_dump -U oripa -d oripa_dev --schema-only \
  > backup/schema_$(date +%Y%m%d).sql
```

### 2-2. 本番環境

- マネージドサービス（RDS / Cloud SQL 等）の自動バックアップを有効にする
- **PITR（Point-In-Time Recovery）を有効にする**
  台帳の誤更新は追記専用トリガで防いでいるが、
  アプリのバグによる誤った「記帳」は PITR でしか戻せない
- 保持期間・RPO / RTO を決めて文書化する（推奨: 日次 + PITR、保持 30 日）
- バックアップ自体の暗号化と、アクセス権限の限定

```bash
# 手動バックアップ（メンテナンス前など）
pg_dump "$DATABASE_URL" -Fc --no-owner --no-acl \
  > oripa_prod_$(date +%Y%m%d_%H%M%S).dump
```

`--no-owner --no-acl` を付けることで、
ロール構成が異なる環境へも復元しやすくなる。

### 2-3. アップロード画像

```bash
tar -czf storage_$(date +%Y%m%d).tar.gz storage/uploads/
```

本番では S3 互換ストレージへ移し、バージョニングとライフサイクルを設定する。

---

## 3. リストア

### 3-1. 開発環境の完全復元

```bash
# 1. アプリを停止する
docker compose stop app

# 2. DB を作り直す
docker compose exec -T postgres dropdb -U oripa --if-exists oripa_dev
docker compose exec -T postgres createdb -U oripa oripa_dev

# 3. 実行時ロールと拡張を再作成する
docker compose exec -T postgres psql -U oripa -d oripa_dev \
  < docker/postgres/init.sql

# 4. ダンプを復元する
docker compose exec -T postgres \
  pg_restore -U oripa -d oripa_dev --no-owner --no-acl \
  < backup/oripa_dev_YYYYMMDD_HHMMSS.dump

# 5. マイグレーション状態を確認する
pnpm exec prisma migrate status

# 6. 整合性を検証する
pnpm points:reconcile
```

### 3-2. 本番環境

1. **まず書き込みを止める**（メンテナンスモード、またはアプリのスケールを 0 に）
2. 復元先を決める
   - 同一インスタンスへ上書き → 取り返しがつかない。原則行わない
   - **新しいインスタンスへ復元してから切り替える**（推奨）
3. PITR の場合は復元ポイントを決める
   - 障害の発生時刻を `audit_logs` と アプリログから特定する
   - 事故の直前を指定する
4. 復元後、**アプリを起動する前に**次を確認する

```sql
-- 追記専用トリガが全テーブルに存在するか
SELECT tgrelid::regclass AS table_name, tgname
FROM pg_trigger WHERE tgname LIKE '%append_only%'
ORDER BY 1;
-- 5 行（point_ledger_entries, point_lot_consumptions,
--       draw_transactions, draw_results, audit_logs）

-- 実行時ロールの権限が剥奪されているか
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'oripa_app'
  AND table_name IN ('point_ledger_entries','point_lot_consumptions',
                     'draw_transactions','draw_results','audit_logs')
  AND privilege_type IN ('UPDATE','DELETE');
-- 0 行であること

-- CHECK 制約の件数
SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conname LIKE '%_check';
```

```bash
# マイグレーション状態
pnpm exec prisma migrate status

# ポイント整合性（不整合があれば終了コード 1）
pnpm points:reconcile
```

5. 問題がなければアプリを起動し、`/api/health` を確認する
6. 復元の事実・復元ポイント・影響範囲を記録し、関係者へ共有する

---

## 4. 復元後に必ず確認すること

| 確認項目                           | 方法                                            |
| ---------------------------------- | ----------------------------------------------- |
| ポイント整合性（INV-1 / INV-2）    | `pnpm points:reconcile`                         |
| スロットと残り口数の整合（INV-10） | 下の SQL                                        |
| 進行中の決済の状態                 | `payment_transactions` の `PENDING` を洗い出す  |
| 未処理の発送申請                   | `shipping_requests` の `REQUESTED` / `CHECKING` |
| 復元ポイント以降に失われたデータ   | アプリログと突き合わせ、ユーザーへ個別対応      |

```sql
-- INV-10: remaining_slots が実際の AVAILABLE 件数と一致するか
SELECT c.id, c.slug, c.remaining_slots,
       count(s.id) FILTER (WHERE s.status = 'AVAILABLE') AS actual_available
FROM oripa_campaigns c
LEFT JOIN oripa_slots s ON s.campaign_id = c.id
GROUP BY c.id, c.slug, c.remaining_slots
HAVING c.remaining_slots <> count(s.id) FILTER (WHERE s.status = 'AVAILABLE');
-- 0 行であること

-- 二重当選が起きていないか（draw_results.slot_id は UNIQUE だが念のため）
SELECT slot_id, count(*) FROM draw_results GROUP BY slot_id HAVING count(*) > 1;
-- 0 行であること
```

---

## 5. やってはいけないこと

- **バックアップを取らずにマイグレーションを本番へ適用する**
- 台帳の行を手で UPDATE / DELETE して「整合させる」
  （訂正は必ず `REVERSAL` / `ADJUSTMENT` の記帳で行う）
- 本番 DB へ直接 psql で接続して書き込む（踏み台と監査ログを必ず経由する）
- 復元を試したことのないバックアップに依存し続ける
