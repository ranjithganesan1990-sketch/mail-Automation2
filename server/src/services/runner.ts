import type { Campaign, Contact, MailAccount, Run, StepKind, Template } from '@prisma/client'
import type { gmail_v1 } from 'googleapis'
import { prisma, logActivity } from '../db.js'
import { env } from '../env.js'
import { AppError, badRequest } from '../lib/errors.js'
import { formatHtml, merge } from '../lib/merge.js'
import { buildTrimmedGmailChain, composeReplyBody, withRePrefix } from '../lib/quote.js'
import { readAttachment } from '../lib/storage.js'
import type { MimeAttachment } from '../lib/mime.js'
import {
  createDraft,
  findThreadForContact,
  flagAccountError,
  getGmailClient,
  getThreadMessages,
  sendMessage,
  type ParsedMessage,
} from '../lib/gmail.js'

// =============================================================
//  CAMPAIGN EXECUTION ENGINE
//  Replaces processDrafts / processNewEmailsAuto /
//  processFollowupEmailsAuto / dailyAutoProcess.
//
//  Apps Script had a hard 6-minute ceiling and checkpointed its
//  position in PropertiesService. Here a run is a database row
//  with a cursor: the worker processes a chunk, saves the cursor,
//  and picks the run back up on the next tick. Nothing is lost if
//  the process restarts mid-campaign.
// =============================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface QueueRunInput {
  orgId: string
  campaignId: string
  kind: StepKind
  trigger?: 'MANUAL' | 'SCHEDULED' | 'TEST'
  limitCount?: number | null
  userId?: string | null
}

export async function queueRun(input: QueueRunInput): Promise<Run> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: input.campaignId, orgId: input.orgId },
    include: { steps: true, mailAccount: true },
  })
  if (!campaign) throw new AppError(404, 'Campaign not found')

  const step = campaign.steps.find((s) => s.kind === input.kind)
  if (!step) throw badRequest(`Campaign has no ${input.kind} step configured.`)
  if (!step.templateId) throw badRequest(`Select a template for the ${labelForKind(input.kind)} step first.`)
  if (!campaign.mailAccountId) throw badRequest('Connect a Gmail account to this campaign first.')
  if (campaign.mailAccount?.status === 'NEEDS_REAUTH') {
    throw badRequest(`Mailbox ${campaign.mailAccount.email} needs to be reconnected.`)
  }

  const active = await prisma.run.findFirst({
    where: { campaignId: campaign.id, kind: input.kind, status: { in: ['QUEUED', 'RUNNING'] } },
  })
  if (active) throw new AppError(409, 'This step is already running.', 'run_in_progress')

  const total = await prisma.contact.count({ where: { campaignId: campaign.id, status: 'ACTIVE' } })
  if (total === 0) throw badRequest('This campaign has no active contacts.')

  const run = await prisma.run.create({
    data: {
      orgId: input.orgId,
      campaignId: campaign.id,
      stepId: step.id,
      kind: input.kind,
      trigger: input.trigger ?? 'MANUAL',
      mode: campaign.deliveryMode,
      status: 'QUEUED',
      total: input.limitCount ? Math.min(input.limitCount, total) : total,
      limitCount: input.limitCount ?? null,
    },
  })

  await prisma.campaignStep.update({ where: { id: step.id }, data: { status: 'PROCESSING', notes: null } })

  await logActivity({
    orgId: input.orgId,
    userId: input.userId,
    type: 'run.queued',
    message: `Queued ${labelForKind(input.kind)} for "${campaign.name}" (${run.total} contacts)`,
    meta: { runId: run.id, campaignId: campaign.id },
  })

  return run
}

export function labelForKind(kind: StepKind): string {
  switch (kind) {
    case 'NEW':
      return 'Initial email'
    case 'FOLLOWUP_1':
      return 'Follow-up 1'
    case 'FOLLOWUP_2':
      return 'Follow-up 2'
    case 'FOLLOWUP_3':
      return 'Follow-up 3'
  }
}

// ------------------------- CHUNKED PROCESSING -------------------------

interface RunContext {
  gmail: gmail_v1.Gmail
  campaign: Campaign & { mailAccount: MailAccount | null }
  template: Template
  attachments: MimeAttachment[]
  fromHeader: string
}

async function buildContext(run: Run): Promise<RunContext> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: run.campaignId },
    include: { mailAccount: true, attachment: true },
  })

  const step = run.stepId
    ? await prisma.campaignStep.findUnique({ where: { id: run.stepId }, include: { template: true, attachment: true } })
    : null

  const template = step?.template
  if (!template) throw new Error('Step template is missing.')
  if (!campaign.mailAccount) throw new Error('Campaign has no connected mailbox.')

  const gmail = await getGmailClient(campaign.mailAccount)

  // Step-level attachment overrides the campaign default.
  const attachmentRecord = step?.attachment ?? campaign.attachment
  const attachments: MimeAttachment[] = []
  if (attachmentRecord) {
    attachments.push({
      filename: attachmentRecord.filename,
      mimeType: attachmentRecord.mimeType,
      content: await readAttachment(attachmentRecord.storageKey),
    })
  }

  const accountName = campaign.mailAccount.name
  const fromHeader = accountName
    ? `${accountName} <${campaign.mailAccount.email}>`
    : campaign.mailAccount.email

  return { gmail, campaign, template, attachments, fromHeader }
}

/** Enforces the workspace's daily send ceiling before a chunk starts. */
async function remainingDailyQuota(orgId: string): Promise<number> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
  const since = new Date()
  since.setHours(0, 0, 0, 0)

  const usedToday = await prisma.runItem.count({
    where: { status: 'SUCCESS', createdAt: { gte: since }, run: { orgId } },
  })

  return Math.max(0, org.maxDailyDrafts - usedToday)
}

export async function processRunChunk(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({ where: { id: runId } })
  if (!run || (run.status !== 'QUEUED' && run.status !== 'RUNNING')) return

  let context: RunContext
  try {
    context = await buildContext(run)
  } catch (err) {
    await failRun(run, err)
    return
  }

  await prisma.run.update({ where: { id: run.id }, data: { status: 'RUNNING' } })

  const deadline = Date.now() + env.worker.chunkBudgetMs
  let quota = await remainingDailyQuota(run.orgId)

  if (quota <= 0) {
    await prisma.run.update({
      where: { id: run.id },
      data: { status: 'PAUSED', error: 'Daily sending limit reached. The run resumes automatically tomorrow.' },
    })
    return
  }

  let cursor = run.cursor
  let processed = run.processed
  let succeeded = run.succeeded
  let failed = run.failed
  let skipped = run.skipped

  while (Date.now() < deadline) {
    if (run.limitCount && processed >= run.limitCount) break
    if (quota <= 0) {
      await prisma.run.update({
        where: { id: run.id },
        data: { processed, succeeded, failed, skipped, cursor, status: 'PAUSED', error: 'Daily sending limit reached.' },
      })
      return
    }

    const batch = await prisma.contact.findMany({
      where: { campaignId: run.campaignId, status: 'ACTIVE' },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: 10,
    })

    if (batch.length === 0) {
      await completeRun(run.id, { processed, succeeded, failed, skipped })
      return
    }

    for (const contact of batch) {
      if (Date.now() >= deadline) break
      if (run.limitCount && processed >= run.limitCount) break

      cursor = contact.id
      processed += 1

      try {
        const result = await deliverToContact(run, context, contact)
        if (result.status === 'SUCCESS') {
          succeeded += 1
          quota -= 1
        } else if (result.status === 'SKIPPED') {
          skipped += 1
        } else {
          failed += 1
        }
      } catch (err) {
        failed += 1
        const message = err instanceof Error ? err.message : String(err)
        await prisma.runItem.create({
          data: {
            runId: run.id,
            contactId: contact.id,
            email: contact.email,
            status: 'FAILED',
            error: message.slice(0, 1000),
          },
        })
        if (/invalid_grant|unauthorized|invalid credentials/i.test(message) && context.campaign.mailAccountId) {
          await flagAccountError(context.campaign.mailAccountId, err)
          await prisma.run.update({
            where: { id: run.id },
            data: { processed, succeeded, failed, skipped, cursor, status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date() },
          })
          return
        }
      }

      // Gentle pacing so we stay well under Gmail's per-user rate limits.
      await sleep(env.worker.perMessageDelayMs)
    }

    await prisma.run.update({
      where: { id: run.id },
      data: { processed, succeeded, failed, skipped, cursor },
    })
  }

  // Out of time for this tick — the next one resumes from the saved cursor.
  const more = await prisma.contact.count({
    where: { campaignId: run.campaignId, status: 'ACTIVE', ...(cursor ? { id: { gt: cursor } } : {}) },
  })
  const hitLimit = Boolean(run.limitCount && processed >= run.limitCount)

  if (more === 0 || hitLimit) {
    await completeRun(run.id, { processed, succeeded, failed, skipped })
  } else {
    await prisma.run.update({
      where: { id: run.id },
      data: { processed, succeeded, failed, skipped, cursor, status: 'RUNNING' },
    })
  }
}

interface DeliveryOutcome {
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED'
}

async function deliverToContact(run: Run, ctx: RunContext, contact: Contact): Promise<DeliveryOutcome> {
  const fields = (contact.fields ?? {}) as Record<string, unknown>
  const mergeData = { ...fields, Email: contact.email, email: contact.email }

  const mergedSubject = merge(ctx.template.subject, mergeData, { escape: false }).trim() || 'No Subject'
  const mergedBody = formatHtml(merge(ctx.template.html, mergeData))

  const isFollowUp = run.kind !== 'NEW'

  let threadId: string | null = null
  let inReplyTo: string | null = null
  let references: string | null = null
  let subject = mergedSubject
  let html = mergedBody

  if (isFollowUp) {
    const thread = await resolveThread(ctx.gmail, contact, mergedSubject)

    if (!thread) {
      await prisma.runItem.create({
        data: {
          runId: run.id,
          contactId: contact.id,
          email: contact.email,
          status: 'SKIPPED',
          error: 'No existing conversation found to reply to.',
        },
      })
      await prisma.contact.update({
        where: { id: contact.id },
        data: { lastStatus: 'NO_THREAD' },
      })
      return { status: 'SKIPPED' }
    }

    const messages = thread.messages
    const last = messages[messages.length - 1]

    threadId = thread.threadId
    inReplyTo = last.rfcMessageId
    references = messages
      .map((m) => m.rfcMessageId)
      .filter((id): id is string => Boolean(id))
      .join(' ')

    subject = withRePrefix(last.subject || mergedSubject)
    html = composeReplyBody(mergedBody, buildTrimmedGmailChain(messages))

    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        threadId: thread.threadId,
        rfcMessageId: last.rfcMessageId,
        lastMessageHtml: last.html?.slice(0, 200_000) ?? null,
      },
    })
  }

  const outgoing = {
    to: contact.email,
    from: ctx.fromHeader,
    subject,
    html,
    attachments: ctx.attachments,
    threadId,
    inReplyTo,
    references,
  }

  const result =
    run.mode === 'SEND' ? await sendMessage(ctx.gmail, outgoing) : await createDraft(ctx.gmail, outgoing)

  await prisma.runItem.create({
    data: {
      runId: run.id,
      contactId: contact.id,
      email: contact.email,
      status: 'SUCCESS',
      subject,
      gmailDraftId: result.draftId ?? null,
      gmailMessageId: result.messageId ?? null,
      threadId: result.threadId ?? threadId,
    },
  })

  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      threadId: result.threadId ?? threadId ?? contact.threadId,
      lastTemplateId: ctx.template.id,
      lastStatus: run.mode === 'SEND' ? 'SENT' : 'DRAFTED',
    },
  })

  return { status: 'SUCCESS' }
}

/** Uses the stored thread id when we have one, otherwise searches the mailbox. */
async function resolveThread(
  gmail: gmail_v1.Gmail,
  contact: Contact,
  subject: string,
): Promise<{ threadId: string; messages: ParsedMessage[] } | null> {
  if (contact.threadId) {
    try {
      const messages = await getThreadMessages(gmail, contact.threadId)
      if (messages.length) return { threadId: contact.threadId, messages }
    } catch {
      // Thread was deleted or belongs to another mailbox — fall through to search.
    }
  }
  return findThreadForContact(gmail, contact.email, subject)
}

async function completeRun(
  runId: string,
  totals: { processed: number; succeeded: number; failed: number; skipped: number },
) {
  const run = await prisma.run.update({
    where: { id: runId },
    data: { ...totals, status: 'COMPLETED', finishedAt: new Date(), error: null },
    include: { campaign: true },
  })

  if (run.stepId) {
    await prisma.campaignStep.update({
      where: { id: run.stepId },
      data: {
        status: totals.succeeded > 0 || totals.processed > 0 ? 'PROCESSED' : 'SKIPPED',
        processedAt: new Date(),
        sentCount: totals.succeeded,
        failedCount: totals.failed,
        notes: totals.failed > 0 ? `${totals.failed} failed, ${totals.skipped} skipped` : null,
      },
    })
  }

  await logActivity({
    orgId: run.orgId,
    type: 'run.completed',
    message: `${labelForKind(run.kind)} finished for "${run.campaign.name}" — ${totals.succeeded} created, ${totals.failed} failed, ${totals.skipped} skipped`,
    meta: { runId: run.id, ...totals },
  })
}

async function failRun(run: Run, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  await prisma.run.update({
    where: { id: run.id },
    data: { status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date() },
  })
  if (run.stepId) {
    await prisma.campaignStep.update({
      where: { id: run.stepId },
      data: { status: 'FAILED', notes: message.slice(0, 500) },
    })
  }
  await logActivity({
    orgId: run.orgId,
    type: 'run.failed',
    message: `Run failed: ${message}`,
    meta: { runId: run.id },
  })
}

// -------------------------- THREAD SYNC ------------------------------

export interface ThreadSyncResult {
  scanned: number
  matched: number
  unmatched: number
}

/**
 * Walks a campaign's contacts and records the Gmail thread each one belongs
 * to, so follow-ups reply into the existing conversation instead of starting
 * a new one. Successor to fetchSentThreadIds().
 */
export async function syncThreadsForCampaign(orgId: string, campaignId: string): Promise<ThreadSyncResult> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, orgId },
    include: { mailAccount: true, steps: { include: { template: true } } },
  })
  if (!campaign) throw new AppError(404, 'Campaign not found')
  if (!campaign.mailAccount) throw badRequest('Connect a Gmail account to this campaign first.')

  const gmail = await getGmailClient(campaign.mailAccount)
  const newStep = campaign.steps.find((s) => s.kind === 'NEW')
  const subjectTemplate = newStep?.template?.subject ?? ''

  const contacts = await prisma.contact.findMany({
    where: { campaignId, status: 'ACTIVE' },
    orderBy: { id: 'asc' },
  })

  const result: ThreadSyncResult = { scanned: contacts.length, matched: 0, unmatched: 0 }

  for (const contact of contacts) {
    const fields = { ...((contact.fields ?? {}) as Record<string, unknown>), Email: contact.email }
    const subject = subjectTemplate ? merge(subjectTemplate, fields, { escape: false }).trim() : ''

    try {
      const thread = await findThreadForContact(gmail, contact.email, subject || null)
      if (!thread) {
        result.unmatched += 1
        continue
      }

      const last = thread.messages[thread.messages.length - 1]
      await prisma.contact.update({
        where: { id: contact.id },
        data: {
          threadId: thread.threadId,
          rfcMessageId: last.rfcMessageId,
          lastMessageHtml: last.html?.slice(0, 200_000) ?? null,
        },
      })
      result.matched += 1
    } catch {
      result.unmatched += 1
    }

    await sleep(env.worker.perMessageDelayMs)
  }

  return result
}

// ----------------------------- PREVIEW -------------------------------

/** Renders a template against one contact without touching Gmail. */
export async function renderPreview(params: {
  orgId: string
  templateId: string
  contactId?: string | null
  campaignId?: string | null
}) {
  const template = await prisma.template.findFirst({
    where: { id: params.templateId, orgId: params.orgId },
  })
  if (!template) throw new AppError(404, 'Template not found')

  let contact: Contact | null = null
  if (params.contactId) {
    contact = await prisma.contact.findFirst({
      where: { id: params.contactId, campaign: { orgId: params.orgId } },
    })
  } else if (params.campaignId) {
    contact = await prisma.contact.findFirst({
      where: { campaignId: params.campaignId, campaign: { orgId: params.orgId } },
      orderBy: { createdAt: 'asc' },
    })
  }

  const fields = contact
    ? { ...((contact.fields ?? {}) as Record<string, unknown>), Email: contact.email }
    : {}

  const subjectResult = merge(template.subject, fields, { escape: false })
  const bodyResult = merge(template.html, fields)

  return {
    subject: subjectResult.trim() || 'No Subject',
    html: formatHtml(bodyResult),
    contact: contact ? { id: contact.id, email: contact.email, fields: contact.fields } : null,
  }
}
