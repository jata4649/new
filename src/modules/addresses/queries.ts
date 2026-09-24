import { prisma } from '@/server/db.ts'

/**
 * 配送先の参照。
 *
 * 【重要】すべての関数が userId を必須で受け取り、WHERE 句に必ず含める。
 *   「ID を知っていれば読める」構造にしない。
 */

export interface AddressItem {
  id: string
  recipientName: string
  postalCode: string
  prefecture: string
  city: string
  addressLine1: string
  addressLine2: string | null
  phoneNumber: string
  isDefault: boolean
  createdAt: Date
}

const SELECT = {
  id: true,
  recipientName: true,
  postalCode: true,
  prefecture: true,
  city: true,
  addressLine1: true,
  addressLine2: true,
  phoneNumber: true,
  isDefault: true,
  createdAt: true,
} as const

/** 既定を先頭に、あとは登録順。選ぶときに迷わせない並びにする。 */
export async function listAddresses(userId: string): Promise<AddressItem[]> {
  return prisma.address.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: SELECT,
  })
}

export async function getAddress(
  userId: string,
  addressId: string,
): Promise<AddressItem | null> {
  return prisma.address.findFirst({
    where: { id: addressId, userId, deletedAt: null },
    select: SELECT,
  })
}

/** 1 行の表示用文字列。一覧・確認ダイアログで同じ形にする。 */
export function formatAddress(address: AddressItem): string {
  const line2 = address.addressLine2 ? ` ${address.addressLine2}` : ''
  return `〒${address.postalCode} ${address.prefecture}${address.city}${address.addressLine1}${line2}`
}
