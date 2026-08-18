import { google, type gmail_v1 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import type { MailAccount } from '@prisma/client'
import { prisma } from '../db.js'
import { getGoogleConfig, type GoogleConfig } from './appconfig.js'
import { decrypt, encrypt } from './crypto.js'
import { AppError } from './errors.js'
import { buildMimeMessage, toRaw, type MimeAttachment } from './mime.js'

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

/**
 * Resolves the instance's Google credentials, or fails with a 503 the
 * dashboard knows how to turn into a "configure it here" prompt.
 */
export async function requireGoogleConfig(): Promise<GoogleConfig> {
  const config = await getGoogleConfig()
  if (!config.clientId || !config.clientSecret) {
    throw new AppError(
      503,
      'Google OAuth is not configured. Add a Client ID and Client Secret under Settings → Google OAuth.',
      'google_not_configured',
    )
  }
  return config
}

export async function createOAuthClient(): Promise<OAuth2Client> {
  const config = await requireGoogleConfig()
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri)
}

export async function buildAuthUrl(state: string): Promise<string> {
  const client = await createOAuthClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on re-connect
    scope: GMAIL_SCOPES,
    state,
    include_granted_scopes: true,
  })
}

export async function exchangeCodeForTokens(code: string) {
  const client = await createOAuthClient()
  const { tokens } = await client.getToken(code)
  client.setCredentials(tokens)

  const oauth2 = google.oauth2({ version: 'v2', auth: client })
  const profile = await oauth2.userinfo.get()

  return {
    tokens,
    email: profile.data.email ?? '',
    name: profile.data.name ?? null,
  }
}

/**
 * Returns an authorized Gmail client for a stored account, transparently
 * refreshing (and re-persisting) the access token when it has expired.
 */
export async function getGmailClient(account: MailAccount): Promise<gmail_v1.Gmail> {
  const client = await createOAuthClient()

  const refreshToken = decrypt(account.refreshToken)
  const accessToken = decrypt(account.accessToken)

  if (!refreshToken && !accessToken) {
    throw new AppError(400, `Mailbox ${account.email} is not connected. Reconnect it in Settings.`, 'needs_reauth')
  }

  client.setCredentials({
    refresh_token: refreshToken ?? undefined,
    access_token: accessToken ?? undefined,
    expiry_date: account.expiresAt ? account.expiresAt.getTime() : undefined,
  })

  // google-auth-library emits this whenever it silently refreshes.
  client.on('tokens', (tokens) => {
    void prisma.mailAccount
      .update({
        where: { id: account.id },
        data: {
          accessToken: tokens.access_token ? encrypt(tokens.access_token) : undefined,
          refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
          status: 'ACTIVE',
          lastError: null,
        },
      })
      .catch((err) => console.error('[gmail] token persist failed:', err))
  })

  return google.gmail({ version: 'v1', auth: client })
}

/** Marks an account as needing re-auth so the dashboard can prompt the user. */
export async function flagAccountError(accountId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const needsReauth = /invalid_grant|unauthorized|invalid credentials|Token has been expired/i.test(message)
  await prisma.mailAccount.update({
    where: { id: accountId },
    data: { lastError: message.slice(0, 1000), status: needsReauth ? 'NEEDS_REAUTH' : undefined },
  })
}

// ----------------------------- READ SIDE -----------------------------

export interface ParsedMessage {
  id: string
  threadId: string
  rfcMessageId: string | null
  from: string
  to: string
  subject: string
  date: Date
  html: string
  snippet: string
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const found = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
  return found?.value ?? ''
}

function decodeBody(data?: string | null): string {
  if (!data) return ''
  return Buffer.from(data, 'base64url').toString('utf8')
}

/** Depth-first search for the richest body part available. */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return ''

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBody(payload.body.data)
  }

  if (payload.parts?.length) {
    for (const part of payload.parts) {
      const html = extractBody(part)
      if (html) return html
    }
  }

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    const text = decodeBody(payload.body.data)
    return `<div>${text.replace(/\n/g, '<br>')}</div>`
  }

  return ''
}

export function parseMessage(message: gmail_v1.Schema$Message): ParsedMessage {
  const headers = message.payload?.headers ?? undefined
  let rfcId = header(headers, 'Message-ID') || null
  if (rfcId && !rfcId.startsWith('<')) rfcId = `<${rfcId}>`

  const rawDate = header(headers, 'Date')
  const parsedDate = rawDate ? new Date(rawDate) : new Date(Number(message.internalDate ?? Date.now()))

  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    rfcMessageId: rfcId,
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    subject: header(headers, 'Subject'),
    date: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
    html: extractBody(message.payload ?? undefined),
    snippet: message.snippet ?? '',
  }
}

export async function getThreadMessages(gmail: gmail_v1.Gmail, threadId: string): Promise<ParsedMessage[]> {
  const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' })
  return (res.data.messages ?? []).map(parseMessage)
}

/** Escapes a subject for use inside a Gmail search operator. */
function quoteForSearch(value: string): string {
  return String(value ?? '').replace(/["\\]/g, ' ').trim()
}

/**
 * Locates the existing conversation with a contact — the replacement for
 * getLatestThreadInfo() / fetchSentThreadIds().
 */
export async function findThreadForContact(
  gmail: gmail_v1.Gmail,
  email: string,
  subject?: string | null,
): Promise<{ threadId: string; messages: ParsedMessage[] } | null> {
  const queries: string[] = []
  const cleanSubject = subject ? quoteForSearch(subject) : ''

  if (cleanSubject) {
    queries.push(`(to:${email} OR from:${email}) subject:"${cleanSubject}"`)
  }
  queries.push(`(to:${email} OR from:${email})`)

  for (const q of queries) {
    const res = await gmail.users.threads.list({ userId: 'me', q, maxResults: 5 })
    const thread = res.data.threads?.[0]
    if (thread?.id) {
      const messages = await getThreadMessages(gmail, thread.id)
      if (messages.length) return { threadId: thread.id, messages }
    }
  }

  return null
}

// ---------------------------- WRITE SIDE -----------------------------

export interface OutgoingMessage {
  to: string
  from?: string
  subject: string
  html: string
  attachments?: MimeAttachment[]
  threadId?: string | null
  inReplyTo?: string | null
  references?: string | null
}

export interface DeliveryResult {
  draftId?: string
  messageId?: string
  threadId?: string
}

export async function createDraft(gmail: gmail_v1.Gmail, message: OutgoingMessage): Promise<DeliveryResult> {
  const raw = toRaw(buildMimeMessage(message))
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        ...(message.threadId ? { threadId: message.threadId } : {}),
      },
    },
  })
  return {
    draftId: res.data.id ?? undefined,
    messageId: res.data.message?.id ?? undefined,
    threadId: res.data.message?.threadId ?? undefined,
  }
}

export async function sendMessage(gmail: gmail_v1.Gmail, message: OutgoingMessage): Promise<DeliveryResult> {
  const raw = toRaw(buildMimeMessage(message))
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      ...(message.threadId ? { threadId: message.threadId } : {}),
    },
  })
  return {
    messageId: res.data.id ?? undefined,
    threadId: res.data.threadId ?? undefined,
  }
}

export async function getProfileEmail(gmail: gmail_v1.Gmail): Promise<string> {
  const res = await gmail.users.getProfile({ userId: 'me' })
  return res.data.emailAddress ?? ''
}

// ------------------------- BOUNCE DETECTION --------------------------

const BOUNCE_QUERY =
  'from:(mailer-daemon OR postmaster OR "Mail Delivery Subsystem" OR "Mail Delivery System") newer_than:30d'

const ADDRESS_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g

/**
 * Reads real delivery-failure notices from the mailbox and returns the
 * addresses that actually bounced. The Apps Script guessed from substrings
 * like "noreply"; this asks Gmail what genuinely failed.
 */
export async function fetchBouncedAddresses(gmail: gmail_v1.Gmail, ownEmail: string): Promise<Map<string, string>> {
  const bounced = new Map<string, string>()

  const res = await gmail.users.messages.list({ userId: 'me', q: BOUNCE_QUERY, maxResults: 100 })
  const messages = res.data.messages ?? []

  for (const stub of messages) {
    if (!stub.id) continue
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: stub.id, format: 'full' })
      const parsed = parseMessage(full.data)
      const haystack = `${parsed.snippet}\n${parsed.html}`
      const reason = parsed.snippet.slice(0, 240) || 'Delivery failed'

      for (const match of haystack.matchAll(ADDRESS_RE)) {
        const address = match[0].toLowerCase()
        if (address === ownEmail.toLowerCase()) continue
        if (/mailer-daemon|postmaster|googlemail\.com|google\.com/i.test(address)) continue
        if (!bounced.has(address)) bounced.set(address, reason)
      }
    } catch {
      // A single unreadable bounce notice should not stop the sweep.
    }
  }

  return bounced
}
