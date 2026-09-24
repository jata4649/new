import { describe, expect, it } from 'vitest'

import {
  imageSrc,
  isUploadKey,
  toUploadKey,
  UPLOAD_NAME_PATTERN,
} from '@/lib/uploads/image-key.ts'
import { detectImageType, MAX_IMAGE_BYTES, validateImageUpload } from '@/lib/uploads/images.ts'
import {
  ALLOWED_IMAGE_TYPES,
  maxImageMegabytes,
  MAX_IMAGE_BYTES as LIMIT_MAX_BYTES,
} from '@/lib/uploads/limits.ts'

/**
 * 画像アップロードの検証の単体テスト。
 *
 * ここが守るのは「Content-Type を信用しない」という一点に尽きる。
 * 偽装された種類・過大な容量・スクリプトを含む形式を、
 * 実バイト列から確実に弾けることを確かめる。
 */

function withHeader(header: number[], padTo = 32): Uint8Array {
  const bytes = new Uint8Array(padTo)
  bytes.set(header, 0)
  return bytes
}

const PNG = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = withHeader([0xff, 0xd8, 0xff, 0xe0])
const WEBP = (() => {
  const bytes = new Uint8Array(32)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  return bytes
})()

describe('detectImageType', () => {
  it('PNG / JPEG / WebP を先頭バイトから見分ける', () => {
    expect(detectImageType(PNG)?.contentType).toBe('image/png')
    expect(detectImageType(JPEG)?.contentType).toBe('image/jpeg')
    expect(detectImageType(WEBP)?.contentType).toBe('image/webp')
  })

  it('拡張子から決めた種類を返さない（バイト列が正）', () => {
    expect(detectImageType(PNG)?.extension).toBe('png')
    expect(detectImageType(JPEG)?.extension).toBe('jpg')
    expect(detectImageType(WEBP)?.extension).toBe('webp')
  })

  it('SVG を画像として受け付けない（スクリプトを埋め込めるため）', () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    expect(detectImageType(svg)).toBeNull()
  })

  it('実体がスクリプトなら弾く（image/png を名乗っても無駄）', () => {
    const php = new TextEncoder().encode('<?php system($_GET["c"]); ?>')
    expect(detectImageType(php)).toBeNull()
  })

  it('RIFF だが WebP でないものを弾く（WAV など）', () => {
    const wav = new Uint8Array(32)
    wav.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
    wav.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
    expect(detectImageType(wav)).toBeNull()
  })

  it('先頭が途中まで一致するだけのものを弾く', () => {
    expect(detectImageType(new Uint8Array([0x89, 0x50]))).toBeNull()
  })
})

describe('validateImageUpload', () => {
  it('正しい画像を受理し、保存名を採番する', () => {
    const result = validateImageUpload(PNG)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.image.contentType).toBe('image/png')
    expect(result.storedName).toMatch(UPLOAD_NAME_PATTERN)
  })

  it('保存名は毎回異なる（元のファイル名を使わない）', () => {
    const a = validateImageUpload(PNG)
    const b = validateImageUpload(PNG)
    if (!a.ok || !b.ok) throw new Error('受理されるはず')
    expect(a.storedName).not.toBe(b.storedName)
  })

  it('空ファイルを拒否する', () => {
    const result = validateImageUpload(new Uint8Array(0))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('EMPTY')
  })

  it('上限を超える容量を拒否する', () => {
    const tooBig = new Uint8Array(MAX_IMAGE_BYTES + 1)
    tooBig.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)

    const result = validateImageUpload(tooBig)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('TOO_LARGE')
  })

  it('上限ちょうどは受理する', () => {
    const exact = new Uint8Array(MAX_IMAGE_BYTES)
    exact.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    expect(validateImageUpload(exact).ok).toBe(true)
  })
})

describe('UPLOAD_NAME_PATTERN', () => {
  it('採番した形だけを許す', () => {
    expect(UPLOAD_NAME_PATTERN.test('abcdefghijklmnop.png')).toBe(true)
    expect(UPLOAD_NAME_PATTERN.test('abcdefghijklmnop.jpg')).toBe(true)
    expect(UPLOAD_NAME_PATTERN.test('abcdefghijklmnop.webp')).toBe(true)
  })

  it('パス区切りや上位ディレクトリを含む名前を拒否する', () => {
    expect(UPLOAD_NAME_PATTERN.test('../../etc/passwd')).toBe(false)
    expect(UPLOAD_NAME_PATTERN.test('a/b.png')).toBe(false)
    expect(UPLOAD_NAME_PATTERN.test('..%2F..%2Fetc.png')).toBe(false)
  })

  it('許可していない拡張子を拒否する', () => {
    expect(UPLOAD_NAME_PATTERN.test('abcdefghijklmnop.svg')).toBe(false)
    expect(UPLOAD_NAME_PATTERN.test('abcdefghijklmnop.php')).toBe(false)
    expect(UPLOAD_NAME_PATTERN.test('abcdefghijklmnop.png.php')).toBe(false)
  })

  it('短すぎる名前を拒否する（総当たりを難しくする）', () => {
    expect(UPLOAD_NAME_PATTERN.test('a.png')).toBe(false)
  })
})

describe('imageSrc', () => {
  it('プレースホルダーキーは生成 API へ向ける', () => {
    expect(imageSrc('placeholder:SR:200:front')).toBe(
      '/api/placeholder/placeholder%3ASR%3A200%3Afront',
    )
  })

  it('アップロードキーは配信 API へ向ける', () => {
    expect(imageSrc('upload:abcdefghijklmnop.png')).toBe('/api/uploads/abcdefghijklmnop.png')
  })

  it('未知の形式はプレースホルダー側へ倒す（生成側が弾く）', () => {
    expect(imageSrc('mystery')).toBe('/api/placeholder/mystery')
  })

  it('キーの種別を判定できる', () => {
    expect(isUploadKey(toUploadKey('abcdefghijklmnop.png'))).toBe(true)
    expect(isUploadKey('placeholder:SR:200:front')).toBe(false)
  })
})

describe('limits.ts（クライアントからも読む定数）', () => {
  it('検証本体が使う上限と同じ値である', () => {
    // 2 か所に別々の数字が書かれると、画面の案内とサーバーの拒否がずれる
    expect(LIMIT_MAX_BYTES).toBe(MAX_IMAGE_BYTES)
  })

  it('メガバイト表記が上限と整合する', () => {
    expect(maxImageMegabytes() * 1024 * 1024).toBe(MAX_IMAGE_BYTES)
  })

  it('許可する形式は判定できる 3 種と一致する', () => {
    const detectable = [PNG, JPEG, WEBP].map((bytes) => detectImageType(bytes)?.contentType)
    expect([...ALLOWED_IMAGE_TYPES].sort()).toEqual(detectable.sort())
  })

  it('SVG は許可一覧に無い', () => {
    expect([...ALLOWED_IMAGE_TYPES]).not.toContain('image/svg+xml')
  })
})
