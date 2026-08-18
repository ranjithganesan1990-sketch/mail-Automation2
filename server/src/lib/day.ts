// =============================================================
//  DAY BOUNDARIES — single source of truth
//
//  Every "which calendar day is this?" decision has to agree across the
//  app, because Digest is keyed on (orgId, forDate) and CampaignStep dates
//  are stored as UTC midnight of the intended day.
//
//  This module exists because that agreement was previously implicit: the
//  scheduler derived the digest key as UTC midnight while the digest writer
//  derived it as *server-local* midnight. On any server not running in UTC
//  the two never matched, the "already sent today" guard silently stopped
//  working, and the digest re-sent on every worker tick. Derive day keys
//  here and nowhere else.
// =============================================================

export interface LocalParts {
  /** YYYY-MM-DD in the target timezone. */
  date: string
  hour: number
  minute: number
}

/** The wall-clock date and time in a given IANA timezone. */
export function localParts(timezone: string, now = new Date()): LocalParts {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour),
      minute: Number(parts.minute),
    }
  } catch {
    // An invalid timezone must not take the scheduler down.
    return {
      date: now.toISOString().slice(0, 10),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
    }
  }
}

/** UTC midnight of a YYYY-MM-DD calendar day. */
export function utcMidnightOf(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/**
 * Normalises any instant to UTC midnight of its UTC calendar day.
 * Idempotent, so it is safe to apply to a value that is already a day key.
 */
export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

/**
 * The canonical Digest.forDate key for an organisation's current local day.
 * Both the scheduler's de-duplication check and the digest writer must use
 * this, or duplicates come back.
 */
export function digestDayKey(timezone: string, now = new Date()): Date {
  return utcMidnightOf(localParts(timezone, now).date)
}

/** Local-day bounds for a timezone, expressed as UTC instants. */
export function dayBounds(timezone: string, now = new Date()) {
  const { date } = localParts(timezone, now)
  const start = utcMidnightOf(date)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { start, end, date }
}
