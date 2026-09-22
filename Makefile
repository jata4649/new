.DEFAULT_GOAL := help
SHELL := /bin/bash

# ==============================================================================
#  開発用ショートカット
#  すべての操作は pnpm スクリプトでも実行できる（README 参照）。
# ==============================================================================

.PHONY: help
help: ## このヘルプを表示する
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: setup
setup: ## 初回セットアップ（.env 作成 → 依存関係 → DB 起動 → マイグレーション → seed）
	@test -f .env || (cp .env.example .env && echo ".env を作成しました。AUTH_SECRET を設定してください。")
	pnpm install
	$(MAKE) up
	$(MAKE) db-wait
	pnpm db:migrate:deploy
	pnpm db:generate
	pnpm db:seed

.PHONY: up
up: ## PostgreSQL と Redis を起動する
	docker compose up -d postgres postgres-shadow redis

.PHONY: down
down: ## コンテナを停止する（データは残す）
	docker compose down

.PHONY: clean
clean: ## コンテナとデータをすべて削除する（取り返しがつかないので注意）
	docker compose down -v

.PHONY: db-wait
db-wait: ## PostgreSQL が接続を受け付けるまで待つ
	@echo "PostgreSQL の起動を待っています..."
	@for i in $$(seq 1 30); do \
	  if docker compose exec -T postgres pg_isready -U oripa -d oripa_dev > /dev/null 2>&1; then \
	    echo "  準備完了"; exit 0; \
	  fi; \
	  sleep 1; \
	done; \
	echo "  タイムアウトしました。docker compose logs postgres を確認してください。"; exit 1

.PHONY: migrate
migrate: ## マイグレーションを作成・適用する（開発用）
	pnpm db:migrate

.PHONY: db-reset
db-reset: ## DB を作り直して seed を投入する
	pnpm db:reset

.PHONY: seed
seed: ## seed データを投入する
	pnpm db:seed

.PHONY: studio
studio: ## Prisma Studio を開く
	pnpm db:studio

.PHONY: dev
dev: ## 開発サーバーを起動する
	pnpm dev

.PHONY: test
test: ## 単体テストを実行する
	pnpm test

.PHONY: test-all
test-all: ## 単体・統合・同時実行テストをすべて実行する（DB が必要）
	pnpm test:all

.PHONY: check
check: ## 型チェック・Lint・単体テストをまとめて実行する
	pnpm check

.PHONY: reconcile
reconcile: ## ポイント台帳の整合性を検証する
	pnpm points:reconcile
