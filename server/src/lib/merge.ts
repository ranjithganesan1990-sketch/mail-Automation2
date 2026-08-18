// Direct successor to mergeTemplateWithRow / formatHtml from the Apps Script,
// with a few upgrades: case-insensitive field matching, {{Field|fallback}}
// defaults, and HTML-escaping of merged values.

const TOKEN_RE = /\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

export type MergeFields = Record<string, unknown>

/** Builds a lookup that tolerates "Company Name" / "companyName" / "company_name". */
function buildLookup(fields: MergeFields): Map<string, string> {
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(fields)) {
    if (key === null || key === undefined || key.trim() === '') continue
    const str = value === null || value === undefined ? '' : String(value)
    map.set(normalizeKey(key), str)
  }
  return map
}

export interface MergeResult {
  output: string
  missing: string[]
}

export function mergeTemplate(template: string, fields: MergeFields, opts: { escape?: boolean } = {}): MergeResult {
  const lookup = buildLookup(fields)
  const missing = new Set<string>()
  const escape = opts.escape !== false

  const output = String(template ?? '').replace(TOKEN_RE, (_match, rawKey: string, fallback?: string) => {
    const value = lookup.get(normalizeKey(rawKey))
    if (value === undefined || value === '') {
      if (fallback !== undefined) return escape ? escapeHtml(fallback) : fallback
      missing.add(rawKey.trim())
      return ''
    }
    return escape ? escapeHtml(value) : value
  })

  return { output, missing: [...missing] }
}

/** Convenience wrapper when the caller only wants the string. */
export function merge(template: string, fields: MergeFields, opts?: { escape?: boolean }): string {
  return mergeTemplate(template, fields, opts).output
}

/** Lists every {{token}} in a template — powers the editor's variable picker. */
export function extractVariables(...templates: string[]): string[] {
  const found = new Set<string>()
  for (const tpl of templates) {
    for (const match of String(tpl ?? '').matchAll(TOKEN_RE)) {
      found.add(match[1].trim())
    }
  }
  return [...found]
}

/**
 * Wraps the merged body in the outer font shell and expands **bold** markers,
 * matching formatHtml() from the original script.
 */
export function formatHtml(html: string): string {
  const withBold = String(html ?? '').replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
  return `<div style="font-family:Verdana,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.6;color:#202124;">${withBold}</div>`
}

/** Strips tags for the plain-text MIME alternative. */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  • ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(String(email ?? '').trim())
}

/** Finds the email column in an imported sheet, mirroring /email/i header matching. */
export function findEmailKey(headers: string[]): string | null {
  const exact = headers.find((h) => normalizeKey(h) === 'email')
  if (exact) return exact
  const loose = headers.find((h) => /e-?mail/i.test(h))
  return loose ?? null
}
