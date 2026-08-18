// =============================================================
//  INBOX & AI REPLY
//
//  Isolation model: every route resolves the mailbox through
//  resolveAccount(), which filters on req.orgId. A caller who supplies
//  another workspace's accountId gets a 404, and because every Gmail call is
//  then made with *that* account's own OAuth client, a thread or message id
//  belonging to someone else simply does not resolve. The frontend never
//  receives a token -- it only ever names an account by id.
// =============================================================

import { Router } from 'express'
import { z } from 'zod'
import type { MailAccount } from '@prisma/client'
import { prisma } from '../db.js'
import { asyncHandler, badRequest, notFound } from '../lib/errors.js'
import { requireAuth, requireOrg } from '../middleware/auth.js'
import {
  ALL_TONES,
  DEFAULT_TONES,
  generateSuggestions,
  isAiConfigured,
  suggestionToHtml,
  type Tone,
} from '../lib/ai.js'
import {
  countNewMessagesSince,
  createDraft,
  getCurrentHistoryId,
  getGmailClient,
  getThreadMessages,
  listInboxMessages,
  modifyMessageLabels,
  sendMessage,
} from '../lib/gmail.js'
import { buildTrimmedGmailChain, composeReplyBody, withRePrefix } from '../lib/quote.js'

export const inboxRouter = Router()
inboxRouter.use(requireAuth, requireOrg)

/**
 * The single ownership gate for this router. Nothing below touches Gmail
 * without going through it first.
 */
async function resolveAccount(orgId: string, accountId?: string): Promise<MailAccount> {
  const account = accountId
    ? await prisma.mailAccount.findFirst({ where: { id: accountId, orgId } })
    : await prisma.mailAccount.findFirst({
        where: { orgId, status: 'ACTIVE' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })

  if (!account) throw notFound('No connected mailbox. Connect Gmail under Mailboxes first.')
  if (account.status === 'NEEDS_REAUTH') {
    throw badRequest(`Your Gmail connection for ${account.email} has expired. Please reconnect that mailbox.`)
  }
  return account
}

/** Turns the UI filters into a single Gmail search string. */
function buildQuery(params: { search?: string; filter?: string }): string {
  const parts = ['in:inbox']
  if (params.filter === 'unread') parts.push('is:unread')
  if (params.filter === 'starred') parts.push('is:starred')
  if (params.search) {
    // Gmail treats the whole thing as a query; quoting keeps operators the
    // user typed working while stopping a stray quote from breaking it.
    parts.push(params.search.replace(/[\r\n]+/g, ' ').trim())
  }
  return parts.join(' ')
}

// ------------------------------ LIST ---------------------------------

inboxRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const account = await resolveAccount(req.orgId!, req.query.accountId as string | undefined)
    const gmail = await getGmailClient(account)

    const page = await listInboxMessages(gmail, {
      q: buildQuery({
        search: (req.query.search as string | undefined)?.trim(),
        filter: req.query.filter as string | undefined,
      }),
      pageToken: (req.query.pageToken as string | undefined) || undefined,
      maxResults: Number.parseInt((req.query.limit as string) ?? '25', 10) || 25,
    })

    res.json({
      account: { id: account.id, email: account.email, name: account.name },
      messages: page.messages,
      nextPageToken: page.nextPageToken,
      historyId: await getCurrentHistoryId(gmail),
      aiConfigured: isAiConfigured(),
    })
  }),
)

// -------------------------- NEW MAIL CHECK ----------------------------

inboxRouter.get(
  '/updates',
  asyncHandler(async (req, res) => {
    const account = await resolveAccount(req.orgId!, req.query.accountId as string | undefined)
    const gmail = await getGmailClient(account)

    const since = (req.query.historyId as string | undefined)?.trim()
    if (!since) {
      return res.json({ count: 0, historyId: await getCurrentHistoryId(gmail) })
    }

    const result = await countNewMessagesSince(gmail, since)
    res.json(result)
  }),
)

// ----------------------------- THREAD ---------------------------------

inboxRouter.get(
  '/threads/:threadId',
  asyncHandler(async (req, res) => {
    const account = await resolveAccount(req.orgId!, req.query.accountId as string | undefined)
    const gmail = await getGmailClient(account)

    const messages = await getThreadMessages(gmail, req.params.threadId)
    if (!messages.length) throw notFound('That conversation no longer exists in this mailbox.')

    res.json({
      threadId: req.params.threadId,
      subject: messages[messages.length - 1].subject,
      messages,
      account: { id: account.id, email: account.email, name: account.name },
      aiConfigured: isAiConfigured(),
    })
  }),
)

// --------------------------- READ / STAR ------------------------------

const flagsSchema = z.object({
  accountId: z.string().optional(),
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
})

inboxRouter.patch(
  '/messages/:messageId',
  asyncHandler(async (req, res) => {
    const body = flagsSchema.parse(req.body)
    const account = await resolveAccount(req.orgId!, body.accountId)
    const gmail = await getGmailClient(account)

    const add: string[] = []
    const remove: string[] = []
    if (body.read === true) remove.push('UNREAD')
    if (body.read === false) add.push('UNREAD')
    if (body.starred === true) add.push('STARRED')
    if (body.starred === false) remove.push('STARRED')

    if (!add.length && !remove.length) throw badRequest('Nothing to change.')

    await modifyMessageLabels(gmail, req.params.messageId, { add, remove })
    res.json({ ok: true })
  }),
)

// ------------------------------- AI -----------------------------------

const suggestSchema = z.object({
  accountId: z.string().optional(),
  tone: z.enum(ALL_TONES).optional(),
})

inboxRouter.post(
  '/threads/:threadId/suggest',
  asyncHandler(async (req, res) => {
    const body = suggestSchema.parse(req.body)
    const account = await resolveAccount(req.orgId!, body.accountId)
    const gmail = await getGmailClient(account)

    const messages = await getThreadMessages(gmail, req.params.threadId)
    if (!messages.length) throw notFound('That conversation no longer exists in this mailbox.')

    // One tone when regenerating, the standard three on first ask.
    const tones: Tone[] = body.tone ? [body.tone] : [...DEFAULT_TONES]

    const suggestions = await generateSuggestions({
      messages: messages.map((m) => ({ from: m.from, date: m.date, subject: m.subject, html: m.html })),
      tones,
      signature: account.name || null,
    })

    // Kept so regenerating a tone the user already saw costs nothing, and so
    // there is an audit trail of what the assistant proposed.
    await prisma.aiSuggestion.createMany({
      data: suggestions.map((s) => ({
        orgId: req.orgId!,
        accountId: account.id,
        threadId: req.params.threadId,
        tone: s.tone,
        body: s.body,
        createdById: req.user!.id,
      })),
    })

    res.json({
      suggestions: suggestions.map((s) => ({ tone: s.tone, body: s.body, html: suggestionToHtml(s.body) })),
    })
  }),
)

// -------------------------- DRAFT / REPLY ------------------------------

const replySchema = z.object({
  accountId: z.string().optional(),
  html: z.string().trim().min(1, 'Write a reply before sending.').max(200_000),
})

/**
 * Builds the reply so Gmail files it inside the original conversation:
 * threadId puts it in the right thread, In-Reply-To/References make other
 * mail clients agree, and the quoted chain matches what Gmail itself sends.
 */
async function buildReply(account: MailAccount, threadId: string, html: string) {
  const gmail = await getGmailClient(account)
  const messages = await getThreadMessages(gmail, threadId)
  if (!messages.length) throw notFound('That conversation no longer exists in this mailbox.')

  const latest = messages[messages.length - 1]

  // Reply to whoever sent the last message, unless that was us.
  const ownAddress = account.email.toLowerCase()
  const target = latest.from.toLowerCase().includes(ownAddress) ? latest.to : latest.from
  if (!target) throw badRequest('Could not work out who to reply to in this conversation.')

  const chain = buildTrimmedGmailChain(
    messages.map((m) => ({ from: m.from, date: m.date, html: m.html })),
  )

  const references = messages
    .map((m) => m.rfcMessageId)
    .filter((id): id is string => Boolean(id))
    .join(' ')

  return {
    gmail,
    message: {
      to: target,
      from: account.name ? `${account.name} <${account.email}>` : account.email,
      subject: withRePrefix(latest.subject),
      html: composeReplyBody(html, chain),
      threadId,
      inReplyTo: latest.rfcMessageId,
      references: references || latest.rfcMessageId,
    },
  }
}

inboxRouter.post(
  '/threads/:threadId/draft',
  asyncHandler(async (req, res) => {
    const body = replySchema.parse(req.body)
    const account = await resolveAccount(req.orgId!, body.accountId)
    const { gmail, message } = await buildReply(account, req.params.threadId, body.html)

    const result = await createDraft(gmail, message)
    res.status(201).json({ draftId: result.draftId, threadId: result.threadId })
  }),
)

inboxRouter.post(
  '/threads/:threadId/reply',
  asyncHandler(async (req, res) => {
    const body = replySchema.parse(req.body)
    const account = await resolveAccount(req.orgId!, body.accountId)
    const { gmail, message } = await buildReply(account, req.params.threadId, body.html)

    const result = await sendMessage(gmail, message)
    res.status(201).json({ messageId: result.messageId, threadId: result.threadId })
  }),
)
