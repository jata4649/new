import { z } from 'zod'

/**
 * 配送先の入力スキーマ。
 *
 * ■ 日本の住所だけを対象にする
 *   クローズドテストの配送範囲は国内に限る。
 *   国際住所を受け取れる形にしておくと、運用（送料・関税・追跡）が
 *   追いつかないまま入力だけ通ってしまう。
 *
 * ■ 正規化はここで行う
 *   郵便番号のハイフン、全角数字、前後の空白は入力段階で吸収する。
 *   DB へ入る形を 1 つに揃えておかないと、後から突き合わせができない。
 *
 * ■ 保持しない情報
 *   メールアドレス・生年月日など、発送に不要な個人情報は受け取らない。
 *   持たない情報は漏れない。
 */

/** 全角英数字・全角ハイフンを半角へ寄せる */
function toHalfWidth(value: string): string {
  return value
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[−‐‑‒–—―ー]/g, '-')
}

const trimmed = z.string().transform((value) => value.trim())

/** 郵便番号: 入力は緩く受け、保存は必ず "123-4567" にする */
const postalCode = trimmed
  .transform((value) => toHalfWidth(value).replace(/[\s-]/g, ''))
  .refine((value) => /^\d{7}$/.test(value), {
    message: '郵便番号は 7 桁の数字で入力してください',
  })
  .transform((value) => `${value.slice(0, 3)}-${value.slice(3)}`)

/**
 * 電話番号: 数字のみ 10〜11 桁へ正規化する。
 * 配送業者への連絡に使うため、書式の揺れを残さない。
 */
const phoneNumber = trimmed
  .transform((value) => toHalfWidth(value).replace(/[\s-()]/g, ''))
  .refine((value) => /^0\d{9,10}$/.test(value), {
    message: '電話番号は 0 から始まる 10〜11 桁の数字で入力してください',
  })

/** 都道府県は自由入力にせず、47 件から選ばせる（表記揺れを作らない） */
export const PREFECTURES = [
  '北海道',
  '青森県',
  '岩手県',
  '宮城県',
  '秋田県',
  '山形県',
  '福島県',
  '茨城県',
  '栃木県',
  '群馬県',
  '埼玉県',
  '千葉県',
  '東京都',
  '神奈川県',
  '新潟県',
  '富山県',
  '石川県',
  '福井県',
  '山梨県',
  '長野県',
  '岐阜県',
  '静岡県',
  '愛知県',
  '三重県',
  '滋賀県',
  '京都府',
  '大阪府',
  '兵庫県',
  '奈良県',
  '和歌山県',
  '鳥取県',
  '島根県',
  '岡山県',
  '広島県',
  '山口県',
  '徳島県',
  '香川県',
  '愛媛県',
  '高知県',
  '福岡県',
  '佐賀県',
  '長崎県',
  '熊本県',
  '大分県',
  '宮崎県',
  '鹿児島県',
  '沖縄県',
] as const

export const addressInputSchema = z.object({
  recipientName: trimmed.pipe(z.string().min(1, '宛名を入力してください').max(64)),
  postalCode,
  prefecture: z.enum(PREFECTURES, { message: '都道府県を選んでください' }),
  city: trimmed.pipe(z.string().min(1, '市区町村を入力してください').max(64)),
  addressLine1: trimmed.pipe(z.string().min(1, '番地を入力してください').max(128)),
  addressLine2: trimmed
    .pipe(z.string().max(128))
    .optional()
    .transform((value) => (value ? value : null)),
  phoneNumber,
  /** 既定の配送先にするか。true にすると他の既定は解除される。 */
  isDefault: z.boolean().default(false),
})

export type AddressInput = z.infer<typeof addressInputSchema>

/** 更新は部分指定を許す。既定の切り替えだけを送ることもある。 */
export const addressUpdateSchema = addressInputSchema.partial()

export type AddressUpdateInput = z.infer<typeof addressUpdateSchema>

export const addressIdParamsSchema = z.object({ id: z.string().min(1) })
