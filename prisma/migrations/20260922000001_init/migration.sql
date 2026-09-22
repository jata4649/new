-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "role" AS ENUM ('USER', 'SUPPORT', 'OPERATOR', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "point_type" AS ENUM ('PAID', 'FREE');

-- CreateEnum
CREATE TYPE "point_tx_type" AS ENUM ('PURCHASE', 'DRAW', 'PRIZE_EXCHANGE', 'BONUS', 'ADJUSTMENT', 'EXPIRE', 'REFUND', 'REVERSAL');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "inventory_status" AS ENUM ('AVAILABLE', 'ALLOCATED', 'WON', 'SHIPPING_REQUESTED', 'SHIPPED', 'EXCHANGED', 'DAMAGED', 'LOST');

-- CreateEnum
CREATE TYPE "card_condition" AS ENUM ('MINT', 'NEAR_MINT', 'EXCELLENT', 'GOOD', 'PLAYED', 'DAMAGED', 'GRADED');

-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'SUSPENDED', 'SOLD_OUT', 'ENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "slot_status" AS ENUM ('AVAILABLE', 'RESERVED', 'DRAWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "prize_status" AS ENUM ('UNDECIDED', 'EXCHANGED', 'SHIPPING_REQUESTED', 'SHIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "shipping_status" AS ENUM ('REQUESTED', 'CHECKING', 'PACKING', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "effect_tier" AS ENUM ('NORMAL', 'BLUE', 'GOLD', 'RAINBOW', 'JACKPOT');

-- CreateEnum
CREATE TYPE "idempotency_state" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" TIMESTAMP(3),
    "password_hash" TEXT NOT NULL,
    "phone_number" TEXT,
    "phone_verified" TIMESTAMP(3),
    "role" "role" NOT NULL DEFAULT 'USER',
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "status_reason" TEXT,
    "status_changed_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "birth_date" TIMESTAMP(3),
    "avatar_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "recipient_name" TEXT NOT NULL,
    "postal_code" TEXT NOT NULL,
    "prefecture" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "phone_number" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role_assignments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "granted_by" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'EMAIL_VERIFICATION'
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "paid_balance" INTEGER NOT NULL DEFAULT 0,
    "free_balance" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "point_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_lots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "point_type" "point_type" NOT NULL,
    "amount_issued" INTEGER NOT NULL,
    "amount_remaining" INTEGER NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "source_type" "point_tx_type" NOT NULL,
    "source_id" TEXT,
    "exhausted_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),

    CONSTRAINT "point_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_ledger_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tx_type" "point_tx_type" NOT NULL,
    "point_type" "point_type",
    "amount" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "reason" TEXT,
    "source_type" TEXT,
    "source_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_lot_consumptions" (
    "id" TEXT NOT NULL,
    "ledger_entry_id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_lot_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "provider_payment_id" TEXT NOT NULL,
    "amount_yen" INTEGER NOT NULL,
    "grant_points" INTEGER NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "failure_code" TEXT,
    "grant_ledger_entry_id" TEXT,
    "idempotency_key_id" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payment_transaction_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature_valid" BOOLEAN NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "skip_reason" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "card_title" TEXT NOT NULL,
    "card_name" TEXT NOT NULL,
    "card_number" TEXT,
    "rarity" TEXT,
    "condition" "card_condition" NOT NULL DEFAULT 'NEAR_MINT',
    "grading_company" TEXT,
    "grading_score" TEXT,
    "grading_cert_no" TEXT,
    "cost_price_yen" INTEGER,
    "reference_price_yen" INTEGER,
    "exchange_points" INTEGER NOT NULL,
    "storage_location" TEXT,
    "front_image_key" TEXT,
    "back_image_key" TEXT,
    "note" TEXT,
    "status" "inventory_status" NOT NULL DEFAULT 'AVAILABLE',
    "acquisition_source" TEXT,
    "acquired_from" TEXT,
    "acquired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "inventories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generic_prizes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_key" TEXT,
    "exchange_points" INTEGER NOT NULL,
    "shippable" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generic_prizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oripa_campaigns" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "thumbnail_key" TEXT,
    "price_points" INTEGER NOT NULL,
    "total_slots" INTEGER NOT NULL,
    "remaining_slots" INTEGER NOT NULL,
    "per_user_limit" INTEGER,
    "sales_start_at" TIMESTAMP(3) NOT NULL,
    "sales_end_at" TIMESTAMP(3) NOT NULL,
    "status" "campaign_status" NOT NULL DEFAULT 'DRAFT',
    "effect_set_key" TEXT NOT NULL DEFAULT 'default',
    "published_at" TIMESTAMP(3),
    "published_by" TEXT,
    "slot_order_commit" TEXT,
    "config_locked_hash" TEXT,
    "suspended_at" TIMESTAMP(3),
    "suspend_reason" TEXT,
    "sold_out_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "oripa_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oripa_prize_tiers" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "effect_tier" "effect_tier" NOT NULL,
    "slot_count" INTEGER NOT NULL,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oripa_prize_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oripa_slots" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "slot_number" INTEGER NOT NULL,
    "draw_order" INTEGER NOT NULL,
    "inventory_id" TEXT,
    "generic_prize_id" TEXT,
    "tier_id" TEXT NOT NULL,
    "exchange_points" INTEGER NOT NULL,
    "status" "slot_status" NOT NULL DEFAULT 'AVAILABLE',
    "drawn_by_user_id" TEXT,
    "drawn_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oripa_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_campaign_counters" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "drawn_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_campaign_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draw_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "draw_count" INTEGER NOT NULL,
    "unit_price_points" INTEGER NOT NULL,
    "total_price_points" INTEGER NOT NULL,
    "ledger_entry_id" TEXT NOT NULL,
    "idempotency_key_id" TEXT,
    "client_ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draw_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draw_results" (
    "id" TEXT NOT NULL,
    "draw_transaction_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "slot_id" TEXT NOT NULL,
    "tier_id" TEXT NOT NULL,
    "tier_code_snapshot" TEXT NOT NULL,
    "tier_name_snapshot" TEXT NOT NULL,
    "effect_tier" "effect_tier" NOT NULL,
    "exchange_points" INTEGER NOT NULL,
    "card_name_snapshot" TEXT NOT NULL,
    "card_title_snapshot" TEXT,
    "rarity_snapshot" TEXT,
    "image_key_snapshot" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draw_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_prizes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "draw_result_id" TEXT NOT NULL,
    "inventory_id" TEXT,
    "generic_prize_id" TEXT,
    "status" "prize_status" NOT NULL DEFAULT 'UNDECIDED',
    "exchange_points" INTEGER NOT NULL,
    "name_snapshot" TEXT NOT NULL,
    "effect_tier" "effect_tier" NOT NULL,
    "image_key_snapshot" TEXT,
    "shippable" BOOLEAN NOT NULL DEFAULT true,
    "exchanged_at" TIMESTAMP(3),
    "exchange_ledger_entry_id" TEXT,
    "shipping_requested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_prizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "shipping_status" NOT NULL DEFAULT 'REQUESTED',
    "address_id" TEXT,
    "recipient_name" TEXT NOT NULL,
    "postal_code" TEXT NOT NULL,
    "prefecture" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "phone_number" TEXT NOT NULL,
    "carrier" TEXT,
    "tracking_number" TEXT,
    "shipped_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "admin_note" TEXT,
    "idempotency_key_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_request_items" (
    "id" TEXT NOT NULL,
    "shipping_request_id" TEXT NOT NULL,
    "user_prize_id" TEXT NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipping_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" "idempotency_state" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_code" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_created_at_idx" ON "users"("status", "created_at");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");

-- CreateIndex
CREATE INDEX "addresses_user_id_deleted_at_idx" ON "addresses"("user_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_assignments_user_id_role_key" ON "user_role_assignments"("user_id", "role");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_revoked_at_idx" ON "user_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_provider_account_id_key" ON "accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_hash_key" ON "verification_tokens"("identifier", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "point_accounts_user_id_key" ON "point_accounts"("user_id");

-- CreateIndex
CREATE INDEX "point_lots_user_id_point_type_expires_at_amount_remaining_idx" ON "point_lots"("user_id", "point_type", "expires_at", "amount_remaining");

-- CreateIndex
CREATE INDEX "point_lots_expires_at_amount_remaining_idx" ON "point_lots"("expires_at", "amount_remaining");

-- CreateIndex
CREATE INDEX "point_lots_source_type_source_id_idx" ON "point_lots"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "point_ledger_entries_user_id_created_at_idx" ON "point_ledger_entries"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "point_ledger_entries_tx_type_created_at_idx" ON "point_ledger_entries"("tx_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "point_ledger_entries_source_type_source_id_tx_type_key" ON "point_ledger_entries"("source_type", "source_id", "tx_type");

-- CreateIndex
CREATE INDEX "point_lot_consumptions_ledger_entry_id_idx" ON "point_lot_consumptions"("ledger_entry_id");

-- CreateIndex
CREATE INDEX "point_lot_consumptions_lot_id_idx" ON "point_lot_consumptions"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_grant_ledger_entry_id_key" ON "payment_transactions"("grant_ledger_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_idempotency_key_id_key" ON "payment_transactions"("idempotency_key_id");

-- CreateIndex
CREATE INDEX "payment_transactions_user_id_created_at_idx" ON "payment_transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_transactions_status_created_at_idx" ON "payment_transactions"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_provider_provider_payment_id_key" ON "payment_transactions"("provider", "provider_payment_id");

-- CreateIndex
CREATE INDEX "payment_webhook_events_payment_transaction_id_occurred_at_idx" ON "payment_webhook_events"("payment_transaction_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_event_id_key" ON "payment_webhook_events"("provider", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventories_code_key" ON "inventories"("code");

-- CreateIndex
CREATE INDEX "inventories_status_created_at_idx" ON "inventories"("status", "created_at");

-- CreateIndex
CREATE INDEX "inventories_card_title_rarity_idx" ON "inventories"("card_title", "rarity");

-- CreateIndex
CREATE INDEX "inventories_deleted_at_idx" ON "inventories"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "generic_prizes_code_key" ON "generic_prizes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "oripa_campaigns_slug_key" ON "oripa_campaigns"("slug");

-- CreateIndex
CREATE INDEX "oripa_campaigns_status_sales_start_at_idx" ON "oripa_campaigns"("status", "sales_start_at");

-- CreateIndex
CREATE INDEX "oripa_campaigns_status_sales_end_at_idx" ON "oripa_campaigns"("status", "sales_end_at");

-- CreateIndex
CREATE INDEX "oripa_prize_tiers_campaign_id_display_order_idx" ON "oripa_prize_tiers"("campaign_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "oripa_prize_tiers_campaign_id_code_key" ON "oripa_prize_tiers"("campaign_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "oripa_slots_inventory_id_key" ON "oripa_slots"("inventory_id");

-- CreateIndex
CREATE INDEX "oripa_slots_campaign_id_status_draw_order_idx" ON "oripa_slots"("campaign_id", "status", "draw_order");

-- CreateIndex
CREATE INDEX "oripa_slots_tier_id_status_idx" ON "oripa_slots"("tier_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "oripa_slots_campaign_id_slot_number_key" ON "oripa_slots"("campaign_id", "slot_number");

-- CreateIndex
CREATE UNIQUE INDEX "oripa_slots_campaign_id_draw_order_key" ON "oripa_slots"("campaign_id", "draw_order");

-- CreateIndex
CREATE UNIQUE INDEX "user_campaign_counters_user_id_campaign_id_key" ON "user_campaign_counters"("user_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "draw_transactions_ledger_entry_id_key" ON "draw_transactions"("ledger_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "draw_transactions_idempotency_key_id_key" ON "draw_transactions"("idempotency_key_id");

-- CreateIndex
CREATE INDEX "draw_transactions_user_id_created_at_idx" ON "draw_transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "draw_transactions_campaign_id_created_at_idx" ON "draw_transactions"("campaign_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "draw_results_slot_id_key" ON "draw_results"("slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "draw_results_draw_transaction_id_sequence_key" ON "draw_results"("draw_transaction_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "user_prizes_draw_result_id_key" ON "user_prizes"("draw_result_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_prizes_inventory_id_key" ON "user_prizes"("inventory_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_prizes_exchange_ledger_entry_id_key" ON "user_prizes"("exchange_ledger_entry_id");

-- CreateIndex
CREATE INDEX "user_prizes_user_id_status_created_at_idx" ON "user_prizes"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "user_prizes_status_idx" ON "user_prizes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_requests_idempotency_key_id_key" ON "shipping_requests"("idempotency_key_id");

-- CreateIndex
CREATE INDEX "shipping_requests_user_id_created_at_idx" ON "shipping_requests"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "shipping_requests_status_created_at_idx" ON "shipping_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "shipping_request_items_shipping_request_id_idx" ON "shipping_request_items"("shipping_request_id");

-- CreateIndex
CREATE INDEX "shipping_request_items_user_prize_id_cancelled_at_idx" ON "shipping_request_items"("user_prize_id", "cancelled_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_created_at_idx" ON "audit_logs"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_scope_key_key" ON "idempotency_keys"("user_id", "scope", "key");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_accounts" ADD CONSTRAINT "point_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_lots" ADD CONSTRAINT "point_lots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_ledger_entries" ADD CONSTRAINT "point_ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_lot_consumptions" ADD CONSTRAINT "point_lot_consumptions_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "point_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_lot_consumptions" ADD CONSTRAINT "point_lot_consumptions_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "point_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_grant_ledger_entry_id_fkey" FOREIGN KEY ("grant_ledger_entry_id") REFERENCES "point_ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_idempotency_key_id_fkey" FOREIGN KEY ("idempotency_key_id") REFERENCES "idempotency_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_transaction_id_fkey" FOREIGN KEY ("payment_transaction_id") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oripa_prize_tiers" ADD CONSTRAINT "oripa_prize_tiers_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "oripa_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oripa_slots" ADD CONSTRAINT "oripa_slots_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "oripa_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oripa_slots" ADD CONSTRAINT "oripa_slots_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "oripa_prize_tiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oripa_slots" ADD CONSTRAINT "oripa_slots_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "inventories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oripa_slots" ADD CONSTRAINT "oripa_slots_generic_prize_id_fkey" FOREIGN KEY ("generic_prize_id") REFERENCES "generic_prizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oripa_slots" ADD CONSTRAINT "oripa_slots_drawn_by_user_id_fkey" FOREIGN KEY ("drawn_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_campaign_counters" ADD CONSTRAINT "user_campaign_counters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_campaign_counters" ADD CONSTRAINT "user_campaign_counters_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "oripa_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draw_transactions" ADD CONSTRAINT "draw_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draw_transactions" ADD CONSTRAINT "draw_transactions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "oripa_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draw_transactions" ADD CONSTRAINT "draw_transactions_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "point_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draw_transactions" ADD CONSTRAINT "draw_transactions_idempotency_key_id_fkey" FOREIGN KEY ("idempotency_key_id") REFERENCES "idempotency_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draw_results" ADD CONSTRAINT "draw_results_draw_transaction_id_fkey" FOREIGN KEY ("draw_transaction_id") REFERENCES "draw_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draw_results" ADD CONSTRAINT "draw_results_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "oripa_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draw_results" ADD CONSTRAINT "draw_results_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "oripa_prize_tiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_prizes" ADD CONSTRAINT "user_prizes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_prizes" ADD CONSTRAINT "user_prizes_draw_result_id_fkey" FOREIGN KEY ("draw_result_id") REFERENCES "draw_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_prizes" ADD CONSTRAINT "user_prizes_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "inventories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_prizes" ADD CONSTRAINT "user_prizes_generic_prize_id_fkey" FOREIGN KEY ("generic_prize_id") REFERENCES "generic_prizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_requests" ADD CONSTRAINT "shipping_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_requests" ADD CONSTRAINT "shipping_requests_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_requests" ADD CONSTRAINT "shipping_requests_idempotency_key_id_fkey" FOREIGN KEY ("idempotency_key_id") REFERENCES "idempotency_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_request_items" ADD CONSTRAINT "shipping_request_items_shipping_request_id_fkey" FOREIGN KEY ("shipping_request_id") REFERENCES "shipping_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_request_items" ADD CONSTRAINT "shipping_request_items_user_prize_id_fkey" FOREIGN KEY ("user_prize_id") REFERENCES "user_prizes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
