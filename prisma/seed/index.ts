// ★ 必ず最初に import すること（campaigns.ts が読む DATABASE_URL を先に用意する）
import './bootstrap.ts'

import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from '../../src/generated/prisma/client.ts'
import { Role, UserStatus } from '../../src/generated/prisma/enums.ts'
import { hashPassword } from '../../src/modules/auth/password.ts'

import { GENERIC_PRIZES, seedCampaigns } from './campaigns.ts'
import { assertRecordIsClean } from './ng-words.ts'
import { generateCards } from './placeholders.ts'

/**
 * 開発確認用 seed。
 *
 * 作るもの:
 *   - 管理者 1 名 / 一般ユーザー 3 名（ポイント口座つき、残高は 0）
 *   - 架空カード在庫 200 件（実在 IP を含まないことを機械的に検査する）
 *   - 汎用景品（ハズレ枠を作らないための代替商品）4 件
 *   - システム設定の初期値
 *   - オリパ: 販売中 3 種 / 販売前 1 種 / 完売 1 種（スロット生成と公開まで実施）
 *
 * Phase 5 以降で追加する:
 *   - 抽選履歴（draw_transactions / draw_results / user_prizes）
 *   - 発送申請のサンプル
 *   これらは抽選処理そのものが作るデータなので、seed で組み立てない
 *   （seed 専用の近道を作ると、本番経路の不具合に気付けなくなるため）。
 *
 * 【重要】この seed は開発環境専用。NODE_ENV=production では実行を拒否する。
 */

const SEED_PASSWORD = 'TestPassword123!'

const SEED_USERS = [
  {
    email: 'admin@example.test',
    displayName: '管理者アカウント',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
  },
  {
    email: 'user1@example.test',
    displayName: 'テストユーザー1',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    email: 'user2@example.test',
    displayName: 'テストユーザー2',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  },
  {
    email: 'user3@example.test',
    displayName: 'テストユーザー3（停止状態の確認用）',
    role: Role.USER,
    status: UserStatus.SUSPENDED,
  },
] as const

/**
 * 架空カードの枚数。
 * オリパ 5 種の景品割当で 65 件を使うため、余裕を見て 200 件にしている。
 */
const CARD_COUNT = 200

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL が設定されていません。.env を確認してください。')
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

async function seedUsers(prisma: PrismaClient): Promise<void> {
  const passwordHash = await hashPassword(SEED_PASSWORD)

  for (const user of SEED_USERS) {
    assertRecordIsClean({ ...user }, 'user')

    // email は小文字で保存する（DB 側の CHECK 制約と揃える）
    const email = user.email.toLowerCase()

    await prisma.user.upsert({
      where: { email },
      update: {
        role: user.role,
        status: user.status,
        // 既存ユーザーのパスワードは上書きしない（テスト中の変更を保持する）
      },
      create: {
        email,
        passwordHash,
        role: user.role,
        status: user.status,
        statusReason: user.status === UserStatus.SUSPENDED ? '停止ユーザーの挙動確認用' : null,
        statusChangedAt: user.status === UserStatus.SUSPENDED ? new Date() : null,
        profile: { create: { displayName: user.displayName } },
        // ポイント口座は残高 0 で作る。ポイントの付与は必ず台帳経由で行うため、
        // ここで残高を直接書き込むことはしない（Phase 3 の Mock 決済で付与する）。
        pointAccount: { create: {} },
      },
    })
  }

  console.log(`  ユーザー ${SEED_USERS.length} 件を登録しました`)
}

async function seedInventories(prisma: PrismaClient): Promise<void> {
  const cards = generateCards(CARD_COUNT)

  for (const card of cards) {
    assertRecordIsClean({ ...card }, 'inventory')
  }

  // createMany で一括投入し、既存分は skipDuplicates で無視する
  const result = await prisma.inventory.createMany({
    data: cards.map((card) => ({
      ...card,
      acquisitionSource: '開発用ダミーデータ',
      acquiredFrom: '架空の仕入先',
      acquiredAt: new Date('2026-01-15T00:00:00Z'),
    })),
    skipDuplicates: true,
  })

  console.log(`  カード在庫 ${result.count} 件を登録しました（既存分はスキップ）`)
}

async function seedGenericPrizes(prisma: PrismaClient): Promise<void> {
  // ハズレ枠を作らないための代替商品。
  // 物理在庫を持たないため、複数のスロットへ割り当てられる唯一の景品種別。
  for (const generic of GENERIC_PRIZES) {
    assertRecordIsClean({ ...generic }, 'genericPrize')

    await prisma.genericPrize.upsert({
      where: { code: generic.code },
      update: {},
      create: generic,
    })
  }

  console.log(`  汎用景品 ${GENERIC_PRIZES.length} 件を登録しました`)
}

async function seedSystemSettings(prisma: PrismaClient): Promise<void> {
  const settings = [
    {
      key: 'point.consumption_strategy',
      value: {
        strategy: 'free_first',
        note: '無償ポイントを優先して消費し、各グループ内では有効期限が近い順に消費する',
      },
    },
    {
      key: 'draw.allowed_counts',
      value: { counts: [1, 10] },
    },
  ]

  for (const setting of settings) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      update: {},
      create: setting,
    })
  }

  console.log(`  システム設定 ${settings.length} 件を登録しました`)
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed は本番環境では実行できません（NODE_ENV=production）')
  }

  const prisma = createClient()

  try {
    console.log('seed を開始します')
    await seedUsers(prisma)
    await seedInventories(prisma)
    await seedGenericPrizes(prisma)
    await seedSystemSettings(prisma)
    await seedCampaigns(prisma)

    console.log('\nseed が完了しました')
    console.log('---------------------------------------------')
    console.log('ログイン情報（すべて共通パスワード）')
    console.log(`  パスワード: ${SEED_PASSWORD}`)
    for (const user of SEED_USERS) {
      console.log(`  ${user.role.padEnd(6)} ${user.email}`)
    }
    console.log('---------------------------------------------')
    console.log('オリパ: /oripas から確認できます（管理は /admin/oripas）')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error('seed に失敗しました:', error)
  process.exit(1)
})
