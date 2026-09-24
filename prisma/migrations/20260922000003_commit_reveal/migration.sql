-- AlterTable
ALTER TABLE "oripa_campaigns" ADD COLUMN     "slot_order_revealed_at" TIMESTAMP(3),
ADD COLUMN     "slot_order_seed" TEXT;

-- ============================================================================
--  公開後の改変防止
-- ----------------------------------------------------------------------------
--  要件: 「管理者による販売途中の不正な確率変更を防ぐ」
--        「ACTIVE になった後は、価格、総口数、景品スロット、当選確率を
--          原則変更不可とする」
--
--  アプリ層でも検証するが、DB でも拒否する。
--  管理画面のバグや DB への直接アクセスでも改変できないようにするため。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 公開済みキャンペーンの価格・総口数を変更できないようにする
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "reject_published_campaign_change"()
RETURNS TRIGGER AS $$
BEGIN
  -- 未公開（published_at IS NULL）なら自由に編集してよい
  IF OLD."published_at" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."price_points" <> OLD."price_points" THEN
    RAISE EXCEPTION
      'CAMPAIGN_IMMUTABLE: 公開済みオリパの 1 口価格は変更できません（% → %）',
      OLD."price_points", NEW."price_points";
  END IF;

  IF NEW."total_slots" <> OLD."total_slots" THEN
    RAISE EXCEPTION
      'CAMPAIGN_IMMUTABLE: 公開済みオリパの総口数は変更できません（% → %）',
      OLD."total_slots", NEW."total_slots";
  END IF;

  -- コミットハッシュの書き換えは「順序を差し替えた」ことを意味する
  IF NEW."slot_order_commit" IS DISTINCT FROM OLD."slot_order_commit" THEN
    RAISE EXCEPTION
      'CAMPAIGN_IMMUTABLE: 公開済みオリパのコミットハッシュは変更できません';
  END IF;

  IF NEW."slot_order_seed" IS DISTINCT FROM OLD."slot_order_seed" THEN
    RAISE EXCEPTION
      'CAMPAIGN_IMMUTABLE: 公開済みオリパのシードは変更できません';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "oripa_campaigns_immutable_trigger"
  BEFORE UPDATE ON "oripa_campaigns"
  FOR EACH ROW EXECUTE FUNCTION "reject_published_campaign_change"();

-- ----------------------------------------------------------------------------
-- 2. 公開済みオリパのスロット構成を変更できないようにする
--    抽選による状態遷移（AVAILABLE → DRAWN）だけを許可する。
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "reject_published_slot_change"()
RETURNS TRIGGER AS $$
DECLARE
  is_published boolean;
BEGIN
  SELECT c."published_at" IS NOT NULL INTO is_published
  FROM "oripa_campaigns" c
  WHERE c."id" = COALESCE(NEW."campaign_id", OLD."campaign_id");

  IF NOT COALESCE(is_published, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'CAMPAIGN_IMMUTABLE: 公開済みオリパへスロットを追加できません';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CAMPAIGN_IMMUTABLE: 公開済みオリパのスロットを削除できません';
  END IF;

  -- 景品の中身と抽選順は絶対に変えられない
  IF NEW."tier_id" <> OLD."tier_id"
     OR NEW."inventory_id" IS DISTINCT FROM OLD."inventory_id"
     OR NEW."generic_prize_id" IS DISTINCT FROM OLD."generic_prize_id"
     OR NEW."exchange_points" <> OLD."exchange_points"
     OR NEW."draw_order" <> OLD."draw_order"
     OR NEW."slot_number" <> OLD."slot_number" THEN
    RAISE EXCEPTION
      'CAMPAIGN_IMMUTABLE: 公開済みオリパのスロット構成は変更できません（slot=%）',
      OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "oripa_slots_immutable_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "oripa_slots"
  FOR EACH ROW EXECUTE FUNCTION "reject_published_slot_change"();

-- ----------------------------------------------------------------------------
-- 3. 公開済みオリパの景品ランク構成を変更できないようにする
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "reject_published_tier_change"()
RETURNS TRIGGER AS $$
DECLARE
  is_published boolean;
BEGIN
  SELECT c."published_at" IS NOT NULL INTO is_published
  FROM "oripa_campaigns" c
  WHERE c."id" = COALESCE(NEW."campaign_id", OLD."campaign_id");

  IF NOT COALESCE(is_published, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION
      'CAMPAIGN_IMMUTABLE: 公開済みオリパの景品ランクは追加・削除できません';
  END IF;

  IF NEW."slot_count" <> OLD."slot_count"
     OR NEW."effect_tier" <> OLD."effect_tier"
     OR NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION
      'CAMPAIGN_IMMUTABLE: 公開済みオリパの景品ランク構成は変更できません（tier=%）',
      OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "oripa_prize_tiers_immutable_trigger"
  BEFORE INSERT OR UPDATE OR DELETE ON "oripa_prize_tiers"
  FOR EACH ROW EXECUTE FUNCTION "reject_published_tier_change"();
