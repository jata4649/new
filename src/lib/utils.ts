import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind のクラスを衝突なく結合する（shadcn/ui の慣習に合わせる） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
