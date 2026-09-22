'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'

import { Alert } from '@/components/ui/alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Field } from '@/components/ui/field.tsx'
import { Input } from '@/components/ui/input.tsx'
import { loginSchema, type LoginInput } from '@/modules/auth/schema.ts'

/**
 * ログインフォーム。
 *
 * 失敗理由は「メールアドレスまたはパスワードが正しくありません」に統一する。
 * どちらが間違っているかを伝えると、アカウントの存在を推測されてしまうため
 * （停止中の場合も同じメッセージにする）。
 */
export function LoginForm({
  callbackUrl,
  initialError,
}: {
  callbackUrl: string
  initialError?: string | undefined
}) {
  const router = useRouter()
  const [formError, setFormError] = useState<string | undefined>(initialError)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  async function onSubmit(values: LoginInput) {
    setFormError(undefined)

    const result = await signIn('credentials', {
      email: values.email,
      password: values.password,
      redirect: false,
    })

    if (!result || result.error) {
      setFormError('メールアドレスまたはパスワードが正しくありません')
      return
    }

    // 認証後の遷移先はサーバーが決めた既定値のみを使う。
    // 外部 URL へのオープンリダイレクトを避けるため、相対パス以外は受け付けない。
    const safeCallback = callbackUrl.startsWith('/') ? callbackUrl : '/mypage'
    router.push(safeCallback)
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">ログイン</h1>

      {formError ? <Alert tone="error">{formError}</Alert> : null}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field id="email" label="メールアドレス" required error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={errors.email ? true : undefined}
            {...register('email')}
          />
        </Field>

        <Field id="password" label="パスワード" required error={errors.password?.message}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            {...register('password')}
          />
        </Field>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'ログイン中…' : 'ログイン'}
        </Button>
      </form>

      <p className="text-base-100 text-center text-sm">
        アカウントをお持ちでない方は{' '}
        <Link href="/signup" className="text-accent-400 font-bold underline">
          新規会員登録
        </Link>
      </p>
    </div>
  )
}
