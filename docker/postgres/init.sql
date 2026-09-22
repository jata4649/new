-- ============================================================================
--  PostgreSQL 初期化スクリプト（docker-entrypoint-initdb.d から一度だけ実行される）
-- ----------------------------------------------------------------------------
--  2 つのロールを作る:
--    oripa      … テーブル所有者。マイグレーション・seed・管理作業で使う。
--    oripa_app  … アプリケーション実行時ロール。
--                 追記専用テーブル（台帳・監査ログ・抽選履歴）に対する
--                 UPDATE / DELETE 権限を持たない。
--
--  権限の実際の付与は prisma/migrations/20260922000002_guards で行う
--  （テーブルが存在してからでないと GRANT できないため）。
-- ============================================================================

-- パスワードは開発専用。本番では必ず変更すること。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oripa_app') THEN
    CREATE ROLE oripa_app LOGIN PASSWORD 'oripa_app_dev_password';
  END IF;
END;
$$;

-- 接続権限
GRANT CONNECT ON DATABASE oripa_dev TO oripa_app;

-- cuid / 一般的な文字列処理で使用する拡張
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
