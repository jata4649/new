import { errors } from '@/lib/api/errors.ts'
import { now } from '@/lib/datetime/index.ts'
import type { PrismaTransactionClient } from '@/server/db.ts'

import type { AddressInput, AddressUpdateInput } from './schema.ts'

/**
 * 配送先の登録・更新・削除。
 *
 * ■ 所有者チェックはすべて WHERE 句で行う
 *   「取得してから userId を比べる」ではなく、最初から自分の行しか
 *   引かないようにする。比較を書き忘れる余地を無くすため。
 *
 * ■ 既定住所は 1 件だけ
 *   DB 側に部分 UNIQUE インデックス（is_default = true AND deleted_at IS NULL）が
 *   あるため、アプリが解除を忘れると DB が弾く。
 *   アプリ側では「新しい既定を立てる前に他を解除する」順序を必ず守る。
 *
 * ■ 削除は論理削除
 *   過去の発送申請が参照しているため、物理削除できない。
 *   なお発送申請は申請時点の住所をスナップショットで持つので、
 *   削除しても過去の申請の宛先表示は変わらない。
 */

export interface AddressActorParams {
  userId: string
}

/** 上限。1 人が無制限に住所を持てると、一覧も運用も破綻する。 */
export const MAX_ADDRESSES_PER_USER = 20

export async function createAddress(
  tx: PrismaTransactionClient,
  params: AddressActorParams & { input: AddressInput },
): Promise<{ id: string }> {
  const { userId, input } = params

  const count = await tx.address.count({ where: { userId, deletedAt: null } })
  if (count >= MAX_ADDRESSES_PER_USER) {
    throw errors.validation([
      {
        field: 'recipientName',
        message: `配送先は ${MAX_ADDRESSES_PER_USER} 件までです。不要なものを削除してください`,
      },
    ])
  }

  // 最初の 1 件は必ず既定にする。既定が無い状態で発送申請させないため。
  const shouldBeDefault = input.isDefault || count === 0

  if (shouldBeDefault) {
    await clearDefault(tx, userId)
  }

  const created = await tx.address.create({
    data: {
      userId,
      recipientName: input.recipientName,
      postalCode: input.postalCode,
      prefecture: input.prefecture,
      city: input.city,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      phoneNumber: input.phoneNumber,
      isDefault: shouldBeDefault,
    },
    select: { id: true },
  })

  return created
}

export async function updateAddress(
  tx: PrismaTransactionClient,
  params: AddressActorParams & { addressId: string; input: AddressUpdateInput },
): Promise<{ id: string }> {
  const { userId, addressId, input } = params

  const existing = await tx.address.findFirst({
    where: { id: addressId, userId, deletedAt: null },
    select: { id: true, isDefault: true },
  })
  // 他人の住所も「存在しない」として扱う（ID の存在を推測させない）
  if (!existing) {
    throw errors.notFound('配送先')
  }

  if (input.isDefault === true && !existing.isDefault) {
    await clearDefault(tx, userId)
  }

  // 既定を自分で外すのは許さない。外した結果「既定が 1 件も無い」状態になり、
  // 発送申請の初期選択が決まらなくなる。別の住所を既定にすれば自動で外れる。
  if (input.isDefault === false && existing.isDefault) {
    throw errors.validation([
      {
        field: 'isDefault',
        message: '既定を外すには、別の配送先を既定に設定してください',
      },
    ])
  }

  await tx.address.update({
    where: { id: existing.id },
    data: {
      ...(input.recipientName !== undefined ? { recipientName: input.recipientName } : {}),
      ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
      ...(input.prefecture !== undefined ? { prefecture: input.prefecture } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
      ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
      ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
      ...(input.isDefault === true ? { isDefault: true } : {}),
    },
  })

  return { id: existing.id }
}

export async function deleteAddress(
  tx: PrismaTransactionClient,
  params: AddressActorParams & { addressId: string },
): Promise<{ id: string }> {
  const { userId, addressId } = params

  const existing = await tx.address.findFirst({
    where: { id: addressId, userId, deletedAt: null },
    select: { id: true, isDefault: true },
  })
  if (!existing) {
    throw errors.notFound('配送先')
  }

  const remaining = await tx.address.count({
    where: { userId, deletedAt: null, id: { not: existing.id } },
  })

  await tx.address.update({
    where: { id: existing.id },
    data: { deletedAt: now(), isDefault: false },
  })

  // 既定を消したら、残っているうちの 1 件を既定へ繰り上げる。
  // 「既定が無い」状態を作らないほうが、発送申請の画面が単純になる。
  if (existing.isDefault && remaining > 0) {
    const next = await tx.address.findFirst({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (next) {
      await tx.address.update({ where: { id: next.id }, data: { isDefault: true } })
    }
  }

  return { id: existing.id }
}

/**
 * 既定フラグを落とす。
 *
 * 部分 UNIQUE インデックスがあるため、新しい既定を立てる前に必ず呼ぶ。
 * 呼び忘れると DB が一意制約違反で止める（壊れたデータは入らない）。
 */
async function clearDefault(tx: PrismaTransactionClient, userId: string): Promise<void> {
  await tx.address.updateMany({
    where: { userId, isDefault: true, deletedAt: null },
    data: { isDefault: false },
  })
}
