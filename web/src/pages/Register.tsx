import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Mail } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { ApiError } from '../lib/api'
import { Button, Field, Input } from '../components/ui'

export default function Register() {
  const { register } = useAuth()
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)

    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setLoading(true)
    try {
      await register({
        name: form.name,
        email: form.email,
        password: form.password,
        workspaceName: form.workspaceName || undefined,
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create your account. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500 text-white">
            <Mail className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold text-ink-900">Mail Automation</span>
        </div>

        <div className="card p-6 sm:p-8">
          <h1 className="text-xl font-semibold text-ink-900">Create your workspace</h1>
          <p className="mt-1 text-sm text-ink-500">
            You&apos;ll be the owner. Teammates can be invited once you&apos;re in.
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
            )}

            <Field label="Your name" required>
              <Input required value={form.name} onChange={set('name')} placeholder="Jordan Patel" autoComplete="name" />
            </Field>

            <Field label="Work email" required>
              <Input
                type="email"
                required
                value={form.email}
                onChange={set('email')}
                placeholder="you@company.com"
                autoComplete="email"
              />
            </Field>

            <Field label="Password" required hint="At least 8 characters.">
              <Input
                type="password"
                required
                value={form.password}
                onChange={set('password')}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </Field>

            <Field label="Workspace name" hint="Defaults to your name if left blank.">
              <Input value={form.workspaceName} onChange={set('workspaceName')} placeholder="Acme Sales" />
            </Field>

            <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
              Create workspace
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-ink-500">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
