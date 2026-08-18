import { format, formatDistanceToNow, isToday, isTomorrow, isValid, parseISO } from 'date-fns'

export function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const date = typeof value === 'string' ? parseISO(value) : value
  return isValid(date) ? date : null
}

export function formatDate(value: string | Date | null | undefined, fallback = '—'): string {
  const date = toDate(value)
  return date ? format(date, 'dd MMM yyyy') : fallback
}

export function formatDateTime(value: string | Date | null | undefined, fallback = '—'): string {
  const date = toDate(value)
  return date ? format(date, 'dd MMM yyyy, h:mm a') : fallback
}

export function formatRelative(value: string | Date | null | undefined, fallback = '—'): string {
  const date = toDate(value)
  return date ? formatDistanceToNow(date, { addSuffix: true }) : fallback
}

/** Friendly label for a scheduled date: "Today", "Tomorrow", or the date. */
export function formatSchedule(value: string | Date | null | undefined): string {
  const date = toDate(value)
  if (!date) return 'Not scheduled'
  if (isToday(date)) return 'Today'
  if (isTomorrow(date)) return 'Tomorrow'
  return format(date, 'dd MMM yyyy')
}

/** Converts a Date to the yyyy-MM-dd string an <input type="date"> expects. */
export function toDateInput(value: string | Date | null | undefined): string {
  const date = toDate(value)
  return date ? format(date, 'yyyy-MM-dd') : ''
}

/**
 * Turns a date input value into UTC midnight of that calendar day, which is
 * how the scheduler compares scheduled dates.
 */
export function fromDateInput(value: string): string | null {
  if (!value) return null
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(Date.UTC(y, m - 1, d)).toISOString()
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value ?? 0)
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`
}
