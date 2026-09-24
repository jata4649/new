import type { Metadata } from 'next'
import Link from 'next/link'

import { AddressForm } from '@/components/addresses/address-form.tsx'
import { AddressList } from '@/components/addresses/address-list.tsx'
import { Card, CardTitle } from '@/components/ui/card.tsx'
import { listAddresses } from '@/modules/addresses/queries.ts'
import { MAX_ADDRESSES_PER_USER } from '@/modules/addresses/service.ts'
import { requireUser } from '@/server/guards.ts'

export const metadata: Metadata = { title: '配送先' }
export const dynamic = 'force-dynamic'

/**
 * 配送先の管理。
 *
 * 発送申請の前提になる画面。登録が 0 件だと申請できないので、
 * 当選商品の画面からここへ誘導する。
 */
export default async function AddressesPage() {
  const session = await requireUser('/mypage/addresses')
  const addresses = await listAddresses(session.id)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">配送先</h1>
        <Link href="/mypage/prizes" className="text-accent-400 text-sm underline">
          当選商品
        </Link>
      </div>

      <AddressList addresses={addresses} />

      {addresses.length < MAX_ADDRESSES_PER_USER ? (
        <Card>
          <CardTitle>配送先を追加</CardTitle>
          <p className="text-base-100/70 mt-1 mb-4 text-xs">
            発送に必要な情報だけを預かります。 登録できるのは {MAX_ADDRESSES_PER_USER}{' '}
            件までです。
          </p>
          <AddressForm />
        </Card>
      ) : (
        <Card>
          <p className="text-base-100 text-sm">
            配送先は {MAX_ADDRESSES_PER_USER}{' '}
            件までです。追加するには不要なものを削除してください。
          </p>
        </Card>
      )}
    </div>
  )
}
