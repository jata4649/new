-- ============================================================================
--  Phase 7: 発送まわりの DB ガード
--
--  アプリ側でも同じことを検証しているが、DB にも置く。
--  アプリの分岐は書き換えられるし、将来の移行スクリプトや手作業は
--  アプリを通らない。「整合しないデータが物理的に入らない」ことを
--  保証できるのは DB だけ。
--
--  テーブル・部分 UNIQUE インデックス（INV-7 / 既定住所 1 件）は
--  20260922000002_guards で作成済み。ここでは状態と付随データの
--  整合だけを足す。
-- ============================================================================

-- 取消しなら、取消日時と理由が必ず揃っている。
-- 「いつ・なぜ取り消したか」が欠けた取消しを残さない（監査可能性）。
ALTER TABLE "shipping_requests"
  ADD CONSTRAINT "shipping_requests_cancelled_consistency_check"
  CHECK (
    "status" <> 'CANCELLED'
    OR ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)
  );

-- 発送済みなら、配送業者と追跡番号が必ず揃っている。
-- 「発送したが追跡できない」は利用者から見て発送していないのと同じ。
-- shipped_at の必須は 0002 の shipping_requests_shipped_consistency_check が担う。
ALTER TABLE "shipping_requests"
  ADD CONSTRAINT "shipping_requests_tracking_consistency_check"
  CHECK (
    "status" <> 'SHIPPED'
    OR ("carrier" IS NOT NULL AND "tracking_number" IS NOT NULL)
  );

-- 配達完了なら、配達日時が必ず存在する。
ALTER TABLE "shipping_requests"
  ADD CONSTRAINT "shipping_requests_delivered_consistency_check"
  CHECK ("status" <> 'DELIVERED' OR "delivered_at" IS NOT NULL);

-- 当選商品が発送申請中なら、申請日時が必ず存在する。
-- 逆に申請日時があるのに未選択へ戻っている、も許さない
-- （取消し処理が shipping_requested_at を戻し忘れたら気付ける）。
ALTER TABLE "user_prizes"
  ADD CONSTRAINT "user_prizes_shipping_requested_consistency_check"
  CHECK (
    ("status" = 'SHIPPING_REQUESTED' AND "shipping_requested_at" IS NOT NULL)
    OR ("status" <> 'SHIPPING_REQUESTED' AND "status" <> 'UNDECIDED')
    OR ("status" = 'UNDECIDED' AND "shipping_requested_at" IS NULL)
  );
