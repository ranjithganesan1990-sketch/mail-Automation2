import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Mail } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { ApiError } from '../lib/api'
import { Button, Field, Input } from '../components/ui'

export default function Login() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="hidden w-1/2 flex-col justify-between bg-brand-600 p-12 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15">
            <Mail className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold">Mail Automation</span>
        </div>

        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight">
            Outreach that follows up on its own.
          </h1>
          <p className="mt-4 text-brand-100">
            Schedule an initial email and three follow-ups per campaign. Every follow-up lands as a real reply inside the
            same Gmail thread — drafted for review or sent automatically.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-brand-50">
            {[
              'Native Gmail threading with trimmed quote chains',
              'Merge variables from your own contact columns',
              'Daily automation with a digest report',
              'Bounce detection straight from delivery notices',
            ].map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-200" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-brand-200">Your mailbox credentials are encrypted at rest.</p>
      </div>

      {/* Form panel */}
      <div className="flex w-full flex-col justify-center px-6 py-12 lg:w-1/2 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500 text-white">
              <Mail className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold text-ink-900">Mail Automation</span>
          </div>

          <h2 className="text-2xl font-semibold text-ink-900">Sign in</h2>
          <p className="mt-1 text-sm text-ink-500">Welcome back. Enter your details to continue.</p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
            )}

            <Field label="Email address">
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </Field>

            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>

            <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
              Sign in
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-ink-500">
            Don&apos;t have a workspace?{' '}
            <Link to="/register" className="font-medium text-brand-600 hover:text-brand-700">
              Create one
            </Link>
          </p>

          <div className="mt-8 rounded-lg border border-ink-200 bg-ink-50 px-4 py-3 text-xs text-ink-600">
            <p className="font-medium text-ink-700">Demo account</p>
            <p className="mt-1">
              After running <code className="rounded bg-white px-1 py-0.5">npm run seed</code>: demo@mailautomation.app /
              demo12345
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
