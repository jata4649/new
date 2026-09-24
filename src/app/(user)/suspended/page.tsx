import type { Metadata } from 'next'

import { Alert } from '@/components/ui/alert.tsx'

export const metadata: Metadata = { title: 'アカウント停止中' }

/**
 * 停止中ユーザー向けの案内。
 * 「ログインできない」ではなく「停止されている」と明示することで、
 * 利用者が問い合わせ先を判断できるようにする。
 */
export default function SuspendedPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">アカウントが停止されています</h1>
      <Alert tone="error">
        現在このアカウントでは、抽選・ポイント交換・発送申請をご利用いただけません。
        心当たりがない場合はサポートまでお問い合わせください。
      </Alert>
    </div>
  )
}
