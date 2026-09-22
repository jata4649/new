-- ============================================================================
--  0002_guards : Prisma スキーマでは表現できない不変条件を DB レベルで強制する
-- ----------------------------------------------------------------------------
--  ここで守るもの
--    1. CHECK 制約          … 負の残高・不正な価格・排他フィールドの同時設定を拒否
--    2. 部分 UNIQUE インデックス … 「有効な発送申請は 1 件まで」など条件付きの一意性
--    3. 追記専用テーブルの保護 … 台帳・監査ログ等の UPDATE / DELETE をトリガで拒否
--    4. 実行時ロールへの最小権限付与
--
--  注意: 3 のトリガは TRUNCATE を対象にしていない。
--        テストのデータクリーンアップや `prisma migrate reset` は TRUNCATE / DROP を
--        使うため影響を受けない。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CHECK 制約
-- ----------------------------------------------------------------------------

-- ユーザー: メールアドレスは小文字で正規化して保存する（重複アカウント防止）
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase_check"
  CHECK ("email" = lower("email"));

-- ポイント口座: 残高は絶対に負にならない（INV-3）
ALTER TABLE "point_accounts"
  ADD CONSTRAINT "point_accounts_non_negative_check"
  CHECK ("paid_balance" >= 0 AND "free_balance" >= 0);

-- ポイントロット: 0 <= 残高 <= 発行額（INV-3）
ALTER TABLE "point_lots"
  ADD CONSTRAINT "point_lots_amount_issued_positive_check"
  CHECK ("amount_issued" > 0);

ALTER TABLE "point_lots"
  ADD CONSTRAINT "point_lots_remaining_range_check"
  CHECK ("amount_remaining" >= 0 AND "amount_remaining" <= "amount_issued");

ALTER TABLE "point_lots"
  ADD CONSTRAINT "point_lots_expiry_after_issue_check"
  CHECK ("expires_at" > "issued_at");

-- ロット消費明細: 消費量は常に正
ALTER TABLE "point_lot_consumptions"
  ADD CONSTRAINT "point_lot_consumptions_amount_positive_check"
  CHECK ("amount" > 0);

-- 台帳: 金額 0 の記帳は意味を持たないため拒否する
ALTER TABLE "point_ledger_entries"
  ADD CONSTRAINT "point_ledger_entries_amount_not_zero_check"
  CHECK ("amount" <> 0);

-- 台帳: 理由の入力が必須となる種別
ALTER TABLE "point_ledger_entries"
  ADD CONSTRAINT "point_ledger_entries_reason_required_check"
  CHECK (
    "tx_type" NOT IN ('ADJUSTMENT', 'REVERSAL')
    OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0)
  );

-- 決済: 金額・付与ポイントは正
ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_amount_positive_check"
  CHECK ("amount_yen" > 0 AND "grant_points" > 0);

-- 在庫: 価格系は非負
ALTER TABLE "inventories"
  ADD CONSTRAINT "inventories_prices_non_negative_check"
  CHECK (
    "exchange_points" >= 0
    AND ("cost_price_yen" IS NULL OR "cost_price_yen" >= 0)
    AND ("reference_price_yen" IS NULL OR "reference_price_yen" >= 0)
  );

ALTER TABLE "generic_prizes"
  ADD CONSTRAINT "generic_prizes_exchange_points_non_negative_check"
  CHECK ("exchange_points" >= 0);

-- オリパ: 価格 1 以上・口数の整合・販売期間の前後関係（公開条件の一部を DB でも担保）
ALTER TABLE "oripa_campaigns"
  ADD CONSTRAINT "oripa_campaigns_price_positive_check"
  CHECK ("price_points" >= 1);

ALTER TABLE "oripa_campaigns"
  ADD CONSTRAINT "oripa_campaigns_total_slots_positive_check"
  CHECK ("total_slots" > 0);

ALTER TABLE "oripa_campaigns"
  ADD CONSTRAINT "oripa_campaigns_remaining_range_check"
  CHECK ("remaining_slots" >= 0 AND "remaining_slots" <= "total_slots");

ALTER TABLE "oripa_campaigns"
  ADD CONSTRAINT "oripa_campaigns_sales_period_check"
  CHECK ("sales_end_at" > "sales_start_at");

ALTER TABLE "oripa_campaigns"
  ADD CONSTRAINT "oripa_campaigns_per_user_limit_check"
  CHECK ("per_user_limit" IS NULL OR "per_user_limit" > 0);

ALTER TABLE "oripa_prize_tiers"
  ADD CONSTRAINT "oripa_prize_tiers_slot_count_positive_check"
  CHECK ("slot_count" > 0);

-- スロット: 物理在庫と汎用景品はどちらか一方のみ（仮決定 15 の排他）
ALTER TABLE "oripa_slots"
  ADD CONSTRAINT "oripa_slots_prize_source_exclusive_check"
  CHECK (num_nonnulls("inventory_id", "generic_prize_id") = 1);

ALTER TABLE "oripa_slots"
  ADD CONSTRAINT "oripa_slots_exchange_points_non_negative_check"
  CHECK ("exchange_points" >= 0);

ALTER TABLE "oripa_slots"
  ADD CONSTRAINT "oripa_slots_numbers_positive_check"
  CHECK ("slot_number" >= 1 AND "draw_order" >= 1);

-- スロット: DRAWN なら引いたユーザーと日時が必ず埋まっている（INV-6）
ALTER TABLE "oripa_slots"
  ADD CONSTRAINT "oripa_slots_drawn_consistency_check"
  CHECK (
    "status" <> 'DRAWN'
    OR ("drawn_by_user_id" IS NOT NULL AND "drawn_at" IS NOT NULL)
  );

ALTER TABLE "user_campaign_counters"
  ADD CONSTRAINT "user_campaign_counters_non_negative_check"
  CHECK ("drawn_count" >= 0);

-- 抽選: 口数は 1 以上
ALTER TABLE "draw_transactions"
  ADD CONSTRAINT "draw_transactions_draw_count_positive_check"
  CHECK ("draw_count" >= 1);

ALTER TABLE "draw_transactions"
  ADD CONSTRAINT "draw_transactions_price_consistency_check"
  CHECK ("total_price_points" = "unit_price_points" * "draw_count");

ALTER TABLE "draw_results"
  ADD CONSTRAINT "draw_results_sequence_non_negative_check"
  CHECK ("sequence" >= 0);

-- 当選商品: 在庫と汎用景品はどちらか一方のみ
ALTER TABLE "user_prizes"
  ADD CONSTRAINT "user_prizes_source_exclusive_check"
  CHECK (num_nonnulls("inventory_id", "generic_prize_id") = 1);

ALTER TABLE "user_prizes"
  ADD CONSTRAINT "user_prizes_exchange_points_non_negative_check"
  CHECK ("exchange_points" >= 0);

-- 当選商品: EXCHANGED なら交換日時と記帳が必ず存在する
ALTER TABLE "user_prizes"
  ADD CONSTRAINT "user_prizes_exchanged_consistency_check"
  CHECK (
    "status" <> 'EXCHANGED'
    OR ("exchanged_at" IS NOT NULL AND "exchange_ledger_entry_id" IS NOT NULL)
  );

-- 発送: SHIPPED なら発送日時が必ず存在する
ALTER TABLE "shipping_requests"
  ADD CONSTRAINT "shipping_requests_shipped_consistency_check"
  CHECK ("status" <> 'SHIPPED' OR "shipped_at" IS NOT NULL);

-- ----------------------------------------------------------------------------
-- 2. 部分 UNIQUE インデックス
-- ----------------------------------------------------------------------------

-- INV-7: 1 つの当選商品が同時に 2 件の有効な発送申請へ含まれない
CREATE UNIQUE INDEX "shipping_request_items_active_prize_unique"
  ON "shipping_request_items" ("user_prize_id")
  WHERE "cancelled_at" IS NULL;

-- 配送先のデフォルトはユーザーごとに 1 件まで
CREATE UNIQUE INDEX "addresses_single_default_unique"
  ON "addresses" ("user_id")
  WHERE "is_default" = true AND "deleted_at" IS NULL;

-- 販売中・販売予定のキャンペーンで slug を重複させない（ARCHIVED は再利用可）
CREATE UNIQUE INDEX "oripa_campaigns_active_slug_unique"
  ON "oripa_campaigns" ("slug")
  WHERE "deleted_at" IS NULL;

-- ----------------------------------------------------------------------------
-- 3. 抽選ホットパス専用の部分インデックス
--    「AVAILABLE のスロットを draw_order 昇順で n 件」を最小コストで解決する。
--    DRAWN 済みの行がインデックスから物理的に消えるため、売れ進んでも劣化しない。
-- ----------------------------------------------------------------------------

CREATE INDEX "oripa_slots_available_draw_order_idx"
  ON "oripa_slots" ("campaign_id", "draw_order")
  WHERE "status" = 'AVAILABLE';

-- 未処理の発送申請を管理画面ダッシュボードで即座に数えるため
CREATE INDEX "shipping_requests_pending_idx"
  ON "shipping_requests" ("created_at")
  WHERE "status" IN ('REQUESTED', 'CHECKING', 'PACKING');

-- ユーザーの未選択当選商品一覧
CREATE INDEX "user_prizes_undecided_idx"
  ON "user_prizes" ("user_id", "created_at")
  WHERE "status" = 'UNDECIDED';

-- ----------------------------------------------------------------------------
-- 4. 追記専用テーブルの保護
--    台帳・監査ログ・抽選履歴は、アプリのバグでも運用ミスでも書き換わってはならない。
--    アプリのロール権限だけでなくトリガでも二重に守る。
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "reject_mutation_on_append_only_table"()
RETURNS TRIGGER AS $$
BEGIN
  -- ERRCODE は plpgsql 既定の P0001（raise_exception）のままにする。
  -- restrict_violation 等の既存コードを使うと、ORM が外部キー違反として
  -- 誤って解釈し、本当の原因が分からなくなるため。
  RAISE EXCEPTION
    'APPEND_ONLY_VIOLATION: テーブル % は追記専用です（% は許可されていません）。訂正は打ち消しレコードの追加で行ってください。',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'point_ledger_entries',
    'point_lot_consumptions',
    'draw_transactions',
    'draw_results',
    'audit_logs'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION "reject_mutation_on_append_only_table"()',
      target || '_append_only_trigger', target
    );
  END LOOP;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. 実行時ロールへの最小権限付与
--    マイグレーション・seed はテーブル所有者ロールで実行し、
--    アプリケーションは権限を絞った別ロール（既定: oripa_app）で接続する。
--    ロールが存在しない環境（CI 等）では何もしない。
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  app_role text := 'oripa_app';
  append_only text[] := ARRAY[
    'point_ledger_entries',
    'point_lot_consumptions',
    'draw_transactions',
    'draw_results',
    'audit_logs'
  ];
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE NOTICE 'ロール % が存在しないため権限付与をスキップします。', app_role;
    RETURN;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
    app_role
  );
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);

  -- 追記専用テーブルからは UPDATE / DELETE を剥奪する
  FOREACH t IN ARRAY append_only LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM %I', t, app_role);
  END LOOP;

  -- マイグレーションで後から作られるテーブルにも同じ既定を適用する
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    app_role
  );
END;
$$;
