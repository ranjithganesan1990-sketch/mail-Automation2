import clsx from 'clsx'
import { Loader2, X } from 'lucide-react'
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// ------------------------------- BUTTON -------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
type ButtonSize = 'sm' | 'md' | 'lg'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700 shadow-sm disabled:bg-brand-300',
  secondary: 'bg-white text-ink-700 border border-ink-300 hover:bg-ink-50 active:bg-ink-100 disabled:text-ink-400',
  ghost: 'text-ink-600 hover:bg-ink-100 active:bg-ink-200 disabled:text-ink-400',
  danger: 'bg-danger text-white hover:bg-red-700 active:bg-red-800 shadow-sm disabled:bg-red-300',
  success: 'bg-success text-white hover:bg-green-700 active:bg-green-800 shadow-sm disabled:bg-green-300',
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

// -------------------------------- CARD --------------------------------

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('card', className)} {...props}>
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={clsx('flex items-start justify-between gap-4 border-b border-ink-200 px-5 py-4', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

// ------------------------------- BADGE --------------------------------

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'

const TONES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-600 ring-ink-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  success: 'bg-green-50 text-green-700 ring-green-200',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
}

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: Tone
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Maps every backend status string to a consistent colour. */
export function StatusBadge({ status }: { status: string }) {
  const tone: Tone =
    status === 'PROCESSED' || status === 'COMPLETED' || status === 'ACTIVE' || status === 'SUCCESS'
      ? 'success'
      : status === 'RUNNING' || status === 'PROCESSING' || status === 'QUEUED' || status === 'SCHEDULED'
        ? 'info'
        : status === 'FAILED' || status === 'BOUNCED' || status === 'NEEDS_REAUTH'
          ? 'danger'
          : status === 'PAUSED' || status === 'NO_TEMPLATE' || status === 'SKIPPED' || status === 'UNSUBSCRIBED'
            ? 'warning'
            : 'neutral'

  return <Badge tone={tone}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>
}

// ------------------------------- INPUTS -------------------------------

interface FieldProps {
  label?: string
  hint?: string
  error?: string
  required?: boolean
  children: ReactNode
  className?: string
}

export function Field({ label, hint, error, required, children, className }: FieldProps) {
  return (
    <div className={className}>
      {label && (
        <label className="label">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="mt-1 text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-ink-500">{hint}</p>
      ) : null}
    </div>
  )
}

export const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={clsx('input', props.className)} />
)

export const Textarea = (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={clsx('input', props.className)} />
)

export const Select = (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={clsx('input appearance-none pr-8', props.className)} />
)

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-ink-800">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-brand-500' : 'bg-ink-300',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  )
}

// ------------------------------- MODAL --------------------------------

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/40 p-4 backdrop-blur-sm sm:p-8">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={clsx(
          'relative z-10 my-auto w-full animate-fade-in rounded-xl bg-white shadow-pop',
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-200 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-ink-900">{title}</h3>
            {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-ink-400 transition hover:bg-ink-100 hover:text-ink-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-ink-200 px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------- MISC HELPERS ----------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-brand-500', className)} />
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-ink-500">
      <Spinner />
      {label}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="rounded-full bg-brand-50 p-3 text-brand-500">{icon}</div>}
      <div>
        <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
        {description && <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4">
      <p className="text-sm font-medium text-red-800">Something went wrong</p>
      <p className="mt-1 text-sm text-red-700">{message}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

export function Avatar({ name, color, size = 32 }: { name: string; color?: string; size?: number }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ backgroundColor: color ?? '#1E88E5', width: size, height: size, fontSize: size * 0.38 }}
    >
      {letters || '?'}
    </span>
  )
}

export function ProgressBar({ value, max, tone = 'brand' }: { value: number; max: number; tone?: Tone }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  const colors: Record<Tone, string> = {
    brand: 'bg-brand-500',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-sky-500',
    neutral: 'bg-ink-400',
  }
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-200">
      <div className={clsx('h-full rounded-full transition-all', colors[tone])} style={{ width: `${percent}%` }} />
    </div>
  )
}

// ------------------------------- TABS ---------------------------------

const TabsContext = createContext<{ value: string; onChange: (v: string) => void } | null>(null)

export function Tabs({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <TabsContext.Provider value={{ value, onChange }}>
      <div className="flex gap-1 border-b border-ink-200">{children}</div>
    </TabsContext.Provider>
  )
}

export function Tab({ id, children, count }: { id: string; children: ReactNode; count?: number }) {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('Tab must be used inside Tabs')
  const active = ctx.value === id

  return (
    <button
      type="button"
      onClick={() => ctx.onChange(id)}
      className={clsx(
        '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'border-brand-500 text-brand-600'
          : 'border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-700',
      )}
    >
      {children}
      {count !== undefined && (
        <span className={clsx('ml-2 rounded-full px-1.5 py-0.5 text-xs', active ? 'bg-brand-50 text-brand-600' : 'bg-ink-100 text-ink-500')}>
          {count}
        </span>
      )}
    </button>
  )
}
