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
import { PASSWORD_MIN_LENGTH } from '@/modules/auth/password-policy.ts'
import { signupSchema, type SignupInput } from '@/modules/auth/schema.ts'

/**
 * 新規会員登録フォーム。
 *
 * 同じ Zod スキーマをサーバー（Route Handler）とクライアントの両方で使う。
 * クライアント検証は利便性のためであり、**サーバー側の検証が本体**。
 */
export function SignupForm() {
  const router = useRouter()
  const [formError, setFormError] = useState<string | undefined>()

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      email: '',
      password: '',
      displayName: '',
      acceptedTerms: false as unknown as true,
    },
  })

  async function onSubmit(values: SignupInput) {
    setFormError(undefined)

    const response = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })

    const body: unknown = await response.json()

    if (!response.ok) {
      const message =
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof (body as { error: { message?: unknown } }).error?.message === 'string'
          ? (body as { error: { message: string } }).error.message
          : '登録に失敗しました。時間をおいて再度お試しください'
      setFormError(message)
      return
    }

    // 登録に成功したらそのままログインする
    const result = await signIn('credentials', {
      email: values.email,
      password: values.password,
      redirect: false,
    })

    if (!result || result.error) {
      // 登録自体は成功しているので、ログイン画面へ案内する
      router.push('/login')
      return
    }

    router.push('/mypage')
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">新規会員登録</h1>

      <Alert tone="warning">
        テスト環境です。現金決済は行われず、ポイントはすべてテスト用です。
      </Alert>

      {formError ? <Alert tone="error">{formError}</Alert> : null}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field id="displayName" label="表示名" required error={errors.displayName?.message}>
          <Input
            id="displayName"
            autoComplete="nickname"
            aria-invalid={errors.displayName ? true : undefined}
            {...register('displayName')}
          />
        </Field>

        <Field id="email" label="メールアドレス" required error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={errors.email ? true : undefined}
            {...register('email')}
          />
        </Field>

        <Field
          id="password"
          label="パスワード"
          required
          hint={`${PASSWORD_MIN_LENGTH} 文字以上で入力してください`}
          error={errors.password?.message}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password ? true : undefined}
            {...register('password')}
          />
        </Field>

        <div className="space-y-1.5">
          <label className="text-base-100 flex items-start gap-2 text-sm">
            <input
              id="acceptedTerms"
              type="checkbox"
              className="mt-1 size-4 shrink-0"
              aria-invalid={errors.acceptedTerms ? true : undefined}
              {...register('acceptedTerms')}
            />
            <span>利用規約とプライバシーポリシーに同意します</span>
          </label>
          {errors.acceptedTerms ? (
            <p role="alert" className="text-sm text-red-400">
              {errors.acceptedTerms.message}
            </p>
          ) : null}
        </div>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? '登録中…' : '登録する'}
        </Button>
      </form>

      <p className="text-base-100 text-center text-sm">
        すでにアカウントをお持ちの方は{' '}
        <Link href="/login" className="text-accent-400 font-bold underline">
          ログイン
        </Link>
      </p>
    </div>
  )
}
