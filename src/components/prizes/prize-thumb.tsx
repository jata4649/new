import type { EffectTier } from '@/generated/prisma/enums.ts'
import { TIER_PRESENTATION } from '@/lib/effects/tiers.ts'
import { cn } from '@/lib/utils.ts'

/**
 * 景品のサムネイル枠。
 *
 * 画像を持たない景品（ポイント還元アイテムなど）でも、必ず同じ縦横比の枠を描く。
 * 枠ごと出し分けると、グリッドの中で画像ありのカードだけが背を高くなり、
 * 画像なしのカードが h-full で引き伸ばされて大きな空白になってしまう。
 *
 * 画像が無いときはランク名を大きく出す。
 * 「読み込みに失敗した」ように見せず、その景品について分かっていること
 * （ランク）を出すほうが、利用者にとって情報量が多い。
 */
export function PrizeThumb({
  imageKey,
  effectTier,
  tierName,
  className,
}: {
  imageKey: string | null
  effectTier: EffectTier
  tierName: string
  className?: string
}) {
  const color = TIER_PRESENTATION[effectTier].colorVar

  if (imageKey) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- 動的生成 SVG のため最適化不要
      <img
        src={`/api/placeholder/${encodeURIComponent(imageKey)}`}
        alt=""
        width={120}
        height={168}
        className={cn('aspect-[5/7] w-full rounded-lg object-cover', className)}
      />
    )
  }

  return (
    <div
      className={cn(
        'bg-base-900 flex aspect-[5/7] w-full items-center justify-center rounded-lg border border-dashed',
        className,
      )}
      style={{ borderColor: color }}
    >
      <span className="text-sm font-bold" style={{ color }}>
        {tierName}
      </span>
    </div>
  )
}
