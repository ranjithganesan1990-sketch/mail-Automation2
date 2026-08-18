import { Router } from 'express'
import { z } from 'zod'
import { StepKind } from '@prisma/client'
import { prisma, logActivity } from '../db.js'
import { asyncHandler, badRequest, notFound } from '../lib/errors.js'
import { requireAuth, requireOrg } from '../middleware/auth.js'
import { assertWithinLimit } from '../middleware/plan.js'
import { labelForKind, queueRun, syncThreadsForCampaign } from '../services/runner.js'

export const campaignRouter = Router()
campaignRouter.use(requireAuth, requireOrg)

const STEP_KINDS: StepKind[] = ['NEW', 'FOLLOWUP_1', 'FOLLOWUP_2', 'FOLLOWUP_3']

campaignRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status as string | undefined
    const search = (req.query.search as string | undefined)?.trim()

    const campaigns = await prisma.campaign.findMany({
      where: {
        orgId: req.orgId!,
        ...(status && status !== 'ALL' ? { status: status as never } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      include: {
        mailAccount: { select: { id: true, email: true, status: true } },
        attachment: { select: { id: true, filename: true } },
        steps: {
          include: { template: { select: { id: true, name: true } } },
          orderBy: { kind: 'asc' },
        },
        _count: { select: { contacts: true } },
      },
      orderBy: { updatedAt: 'desc' },
    })

    // Contact counts by status, fetched in one grouped query rather than per row.
    const grouped = await prisma.contact.groupBy({
      by: ['campaignId', 'status'],
      where: { campaign: { orgId: req.orgId! } },
      _count: { _all: true },
    })

    const statusMap = new Map<string, Record<string, number>>()
    for (const row of grouped) {
      const entry = statusMap.get(row.campaignId) ?? {}
      entry[row.status] = row._count._all
      statusMap.set(row.campaignId, entry)
    }

    res.json({
      campaigns: campaigns.map((c) => ({
        ...c,
        contactStats: statusMap.get(c.id) ?? {},
      })),
    })
  }),
)

campaignRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, orgId: req.orgId! },
      include: {
        mailAccount: { select: { id: true, email: true, status: true } },
        attachment: true,
        steps: {
          include: {
            template: { select: { id: true, name: true, subject: true } },
            attachment: { select: { id: true, filename: true } },
          },
          orderBy: { kind: 'asc' },
        },
        runs: { orderBy: { startedAt: 'desc' }, take: 10 },
      },
    })
    if (!campaign) throw notFound('Campaign not found')

    const grouped = await prisma.contact.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    })

    res.json({
      campaign,
      contactStats: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
    })
  }),
)

const createSchema = z.object({
  name: z.string().trim().min(1, 'Campaign name is required').max(120),
  description: z.string().trim().max(500).nullable().optional(),
  mailAccountId: z.string().nullable().optional(),
  deliveryMode: z.enum(['DRAFT', 'SEND']).optional(),
})

campaignRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body)

    await assertWithinLimit(req.orgId!, 'campaigns')

    if (body.mailAccountId) {
      const account = await prisma.mailAccount.findFirst({ where: { id: body.mailAccountId, orgId: req.orgId! } })
      if (!account) throw badRequest('Selected mailbox does not belong to this workspace.')
    }

    // Every campaign gets the same four steps the AutoProcess sheet had.
    const campaign = await prisma.campaign.create({
      data: {
        orgId: req.orgId!,
        name: body.name,
        description: body.description ?? null,
        mailAccountId: body.mailAccountId ?? null,
        deliveryMode: body.deliveryMode ?? 'DRAFT',
        steps: { create: STEP_KINDS.map((kind) => ({ kind })) },
      },
      include: { steps: true },
    })

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'campaign.created',
      message: `${req.user!.name} created campaign "${campaign.name}"`,
      meta: { campaignId: campaign.id },
    })

    res.status(201).json({ campaign })
  }),
)

const updateSchema = createSchema.partial().extend({
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']).optional(),
  attachmentId: z.string().nullable().optional(),
})

campaignRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body)

    const existing = await prisma.campaign.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!existing) throw notFound('Campaign not found')

    if (body.mailAccountId) {
      const account = await prisma.mailAccount.findFirst({ where: { id: body.mailAccountId, orgId: req.orgId! } })
      if (!account) throw badRequest('Selected mailbox does not belong to this workspace.')
    }
    if (body.attachmentId) {
      const attachment = await prisma.attachment.findFirst({ where: { id: body.attachmentId, orgId: req.orgId! } })
      if (!attachment) throw badRequest('Selected attachment does not belong to this workspace.')
    }

    const campaign = await prisma.campaign.update({
      where: { id: existing.id },
      data: body,
      include: { steps: { orderBy: { kind: 'asc' } } },
    })

    res.json({ campaign })
  }),
)

campaignRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!campaign) throw notFound('Campaign not found')

    const running = await prisma.run.count({
      where: { campaignId: campaign.id, status: { in: ['QUEUED', 'RUNNING'] } },
    })
    if (running > 0) throw badRequest('Stop the running job before deleting this campaign.')

    await prisma.campaign.delete({ where: { id: campaign.id } })

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'campaign.deleted',
      message: `${req.user!.name} deleted campaign "${campaign.name}"`,
    })

    res.json({ ok: true })
  }),
)

// ------------------------------- STEPS -------------------------------

const stepSchema = z.object({
  scheduledFor: z.string().datetime().nullable().optional(),
  templateId: z.string().nullable().optional(),
  attachmentId: z.string().nullable().optional(),
  status: z.enum(['PENDING', 'SCHEDULED', 'SKIPPED']).optional(),
})

/** One AutoProcess cell edit — schedule a date, pick a template, or skip. */
campaignRouter.patch(
  '/:id/steps/:kind',
  asyncHandler(async (req, res) => {
    const kind = req.params.kind.toUpperCase() as StepKind
    if (!STEP_KINDS.includes(kind)) throw badRequest('Unknown step')

    const body = stepSchema.parse(req.body)

    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!campaign) throw notFound('Campaign not found')

    if (body.templateId) {
      const template = await prisma.template.findFirst({ where: { id: body.templateId, orgId: req.orgId! } })
      if (!template) throw badRequest('Selected template does not belong to this workspace.')
    }
    if (body.attachmentId) {
      const attachment = await prisma.attachment.findFirst({ where: { id: body.attachmentId, orgId: req.orgId! } })
      if (!attachment) throw badRequest('Selected attachment does not belong to this workspace.')
    }

    const existing = await prisma.campaignStep.findUnique({
      where: { campaignId_kind: { campaignId: campaign.id, kind } },
    })
    if (!existing) throw notFound('Step not found')

    if (existing.status === 'PROCESSING') {
      throw badRequest('This step is currently running.')
    }

    const scheduledFor = body.scheduledFor === undefined ? undefined : body.scheduledFor ? new Date(body.scheduledFor) : null

    // Editing a completed step re-arms it so the scheduler will pick it up again.
    const nextStatus =
      body.status ??
      (scheduledFor !== undefined || body.templateId !== undefined
        ? scheduledFor
          ? 'SCHEDULED'
          : 'PENDING'
        : undefined)

    const step = await prisma.campaignStep.update({
      where: { id: existing.id },
      data: {
        ...(scheduledFor !== undefined ? { scheduledFor } : {}),
        ...(body.templateId !== undefined ? { templateId: body.templateId } : {}),
        ...(body.attachmentId !== undefined ? { attachmentId: body.attachmentId } : {}),
        ...(nextStatus ? { status: nextStatus, notes: null } : {}),
      },
      include: { template: { select: { id: true, name: true } } },
    })

    res.json({ step })
  }),
)

// -------------------------------- RUNS -------------------------------

const runSchema = z.object({
  kind: z.enum(['NEW', 'FOLLOWUP_1', 'FOLLOWUP_2', 'FOLLOWUP_3']),
  testOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(10_000).nullable().optional(),
})

/** Manual trigger — covers both "Test First Row" and "Create All Drafts". */
campaignRouter.post(
  '/:id/run',
  asyncHandler(async (req, res) => {
    const body = runSchema.parse(req.body)

    const run = await queueRun({
      orgId: req.orgId!,
      campaignId: req.params.id,
      kind: body.kind,
      trigger: body.testOnly ? 'TEST' : 'MANUAL',
      limitCount: body.testOnly ? 1 : body.limit ?? null,
      userId: req.user!.id,
    })

    res.status(202).json({ run, message: `${labelForKind(body.kind)} queued.` })
  }),
)

campaignRouter.get(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!campaign) throw notFound('Campaign not found')

    const runs = await prisma.run.findMany({
      where: { campaignId: campaign.id },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Number(req.query.limit ?? 25), 100),
    })

    res.json({ runs })
  }),
)

/**
 * Back-fills Gmail thread ids for contacts so follow-ups can reply into the
 * right conversation. Successor to fetchSentThreadIds().
 */
campaignRouter.post(
  '/:id/sync-threads',
  asyncHandler(async (req, res) => {
    const result = await syncThreadsForCampaign(req.orgId!, req.params.id)

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'campaign.threads_synced',
      message: `${req.user!.name} synced threads — ${result.matched}/${result.scanned} matched`,
      meta: { campaignId: req.params.id, ...result },
    })

    res.json(result)
  }),
)
