import type {
  CampaignStatus,
  EffectTier,
  InventoryStatus,
  PrizeStatus,
  ShippingStatus,
  UserStatus,
} from '@/generated/prisma/enums.ts'
import { cn } from '@/lib/utils.ts'
import type { PublicSaleState } from '@/modules/oripa/queries.ts'

const BADGE_BASE = 'inline-block rounded-full px-2.5 py-0.5 text-xs font-bold'

const USER_STATUS_LABELS: Record<UserStatus, { label: string; className: string }> = {
  ACTIVE: { label: '利用中', className: 'bg-emerald-500/15 text-emerald-300' },
  SUSPENDED: { label: '停止中', className: 'bg-red-500/15 text-red-300' },
  WITHDRAWN: { label: '退会済み', className: 'bg-base-700/40 text-base-100' },
}

/**
 * 状態バッジ。
 * 色だけに依存せず、必ずテキストラベルを併記する（アクセシビリティ要件）。
 */
export function UserStatusBadge({ status }: { status: UserStatus }) {
  const { label, className } = USER_STATUS_LABELS[status]
  return <span className={cn(BADGE_BASE, className)}>{label}</span>
}

const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, { label: string; className: string }> = {
  DRAFT: { label: '下書き', className: 'bg-base-700/40 text-base-100' },
  SCHEDULED: { label: '販売前', className: 'bg-sky-500/15 text-sky-300' },
  ACTIVE: { label: '販売中', className: 'bg-emerald-500/15 text-emerald-300' },
  SUSPENDED: { label: '停止中', className: 'bg-red-500/15 text-red-300' },
  SOLD_OUT: { label: '完売', className: 'bg-amber-500/15 text-amber-300' },
  ENDED: { label: '販売終了', className: 'bg-base-700/40 text-base-100' },
  ARCHIVED: { label: 'アーカイブ', className: 'bg-base-700/40 text-base-100' },
}

/** 管理画面向け。DB の status をそのまま表す。 */
export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const { label, className } = CAMPAIGN_STATUS_LABELS[status]
  return <span className={cn(BADGE_BASE, className)}>{label}</span>
}

const SALE_STATE_LABELS: Record<PublicSaleState, { label: string; className: string }> = {
  ON_SALE: { label: '販売中', className: 'bg-emerald-500/15 text-emerald-300' },
  SCHEDULED: { label: '販売前', className: 'bg-sky-500/15 text-sky-300' },
  SOLD_OUT: { label: '完売', className: 'bg-amber-500/15 text-amber-300' },
  ENDED: { label: '販売終了', className: 'bg-base-700/40 text-base-100' },
  SUSPENDED: { label: '販売停止中', className: 'bg-red-500/15 text-red-300' },
}

/**
 * ユーザー向け。DB の status ではなく、時刻と残り口数も踏まえた表示用の状態を表す
 * （modules/oripa/queries.ts の resolveSaleState）。
 */
export function SaleStateBadge({ state }: { state: PublicSaleState }) {
  const { label, className } = SALE_STATE_LABELS[state]
  return <span className={cn(BADGE_BASE, className)}>{label}</span>
}

const INVENTORY_STATUS_LABELS: Record<InventoryStatus, { label: string; className: string }> = {
  AVAILABLE: { label: '在庫あり', className: 'bg-emerald-500/15 text-emerald-300' },
  ALLOCATED: { label: 'オリパ割当済み', className: 'bg-sky-500/15 text-sky-300' },
  WON: { label: '当選済み', className: 'bg-amber-500/15 text-amber-300' },
  SHIPPING_REQUESTED: { label: '発送申請中', className: 'bg-amber-500/15 text-amber-300' },
  SHIPPED: { label: '発送済み', className: 'bg-base-700/40 text-base-100' },
  EXCHANGED: { label: 'ポイント交換済み', className: 'bg-base-700/40 text-base-100' },
  DAMAGED: { label: '破損', className: 'bg-red-500/15 text-red-300' },
  LOST: { label: '紛失', className: 'bg-red-500/15 text-red-300' },
}

export function InventoryStatusBadge({ status }: { status: InventoryStatus }) {
  const { label, className } = INVENTORY_STATUS_LABELS[status]
  return <span className={cn(BADGE_BASE, className)}>{label}</span>
}

const EFFECT_TIER_STYLES: Record<EffectTier, string> = {
  JACKPOT: 'bg-fuchsia-500/20 text-fuchsia-200',
  RAINBOW: 'bg-violet-500/20 text-violet-200',
  GOLD: 'bg-amber-500/20 text-amber-200',
  BLUE: 'bg-sky-500/20 text-sky-200',
  NORMAL: 'bg-base-700/40 text-base-100',
}

/**
 * 景品ランクのバッジ。
 *
 * ランク名（S賞 など）を必ず併記する。色だけで等級を示さないのは
 * アクセシビリティ要件であると同時に、演出色と景品価値が
 * 一致しない設定にもできるようにしておくため。
 */
export function EffectTierBadge({ tier, label }: { tier: EffectTier; label: string }) {
  return <span className={cn(BADGE_BASE, EFFECT_TIER_STYLES[tier])}>{label}</span>
}

const PRIZE_STATUS_LABELS: Record<PrizeStatus, { label: string; className: string }> = {
  UNDECIDED: { label: '未選択', className: 'bg-amber-500/15 text-amber-300' },
  EXCHANGED: { label: 'ポイント交換済み', className: 'bg-base-700/40 text-base-100' },
  SHIPPING_REQUESTED: { label: '発送申請中', className: 'bg-sky-500/15 text-sky-300' },
  SHIPPED: { label: '発送済み', className: 'bg-emerald-500/15 text-emerald-300' },
  CANCELLED: { label: '取消済み', className: 'bg-red-500/15 text-red-300' },
}

export function PrizeStatusBadge({ status }: { status: PrizeStatus }) {
  const { label, className } = PRIZE_STATUS_LABELS[status]
  return <span className={cn(BADGE_BASE, className)}>{label}</span>
}

/**
 * 発送状態。
 *
 * 申請直後から配達完了までを 1 本の流れとして色で示す。
 * 「今どこまで進んでいるか」が一覧で分かることを優先し、
 * 取消しだけを別系統の色にする。
 */
const SHIPPING_STATUS_LABELS: Record<ShippingStatus, { label: string; className: string }> = {
  REQUESTED: { label: '申請受付', className: 'bg-amber-500/15 text-amber-300' },
  CHECKING: { label: '検品中', className: 'bg-sky-500/15 text-sky-300' },
  PACKING: { label: '梱包中', className: 'bg-sky-500/15 text-sky-300' },
  SHIPPED: { label: '発送済み', className: 'bg-emerald-500/15 text-emerald-300' },
  DELIVERED: { label: '配達完了', className: 'bg-emerald-500/15 text-emerald-300' },
  CANCELLED: { label: '取消済み', className: 'bg-red-500/15 text-red-300' },
}

export function ShippingStatusBadge({ status }: { status: ShippingStatus }) {
  const { label, className } = SHIPPING_STATUS_LABELS[status]
  return <span className={cn(BADGE_BASE, className)}>{label}</span>
}
