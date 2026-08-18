import { Router } from 'express'
import { prisma, logActivity } from '../db.js'
import { asyncHandler, badRequest, notFound } from '../lib/errors.js'
import { requireAuth, requireOrg } from '../middleware/auth.js'
import { dispatchDueSteps, runDailyAutomation } from '../services/scheduler.js'
import { sendDailyDigest } from '../services/digest.js'

export const runRouter = Router()
runRouter.use(requireAuth, requireOrg)

runRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status as string | undefined
    const limit = Math.min(Number(req.query.limit ?? 50), 200)

    const runs = await prisma.run.findMany({
      where: {
        orgId: req.orgId!,
        ...(status && status !== 'ALL' ? { status: status as never } : {}),
      },
      include: { campaign: { select: { id: true, name: true } } },
      orderBy: { startedAt: 'desc' },
      take: limit,
    })

    res.json({ runs })
  }),
)

runRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const run = await prisma.run.findFirst({
      where: { id: req.params.id, orgId: req.orgId! },
      include: {
        campaign: { select: { id: true, name: true } },
        items: { orderBy: { createdAt: 'desc' }, take: 500 },
      },
    })
    if (!run) throw notFound('Run not found')

    res.json({ run })
  }),
)

runRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const run = await prisma.run.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!run) throw notFound('Run not found')
    if (!['QUEUED', 'RUNNING', 'PAUSED'].includes(run.status)) {
      throw badRequest('This run has already finished.')
    }

    await prisma.run.update({
      where: { id: run.id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    })

    if (run.stepId) {
      await prisma.campaignStep.update({
        where: { id: run.stepId },
        data: { status: 'PENDING', notes: 'Run cancelled manually.' },
      })
    }

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'run.cancelled',
      message: `${req.user!.name} cancelled a run`,
      meta: { runId: run.id },
    })

    res.json({ ok: true })
  }),
)

/** Re-queues a paused or failed run; it resumes from its saved cursor. */
runRouter.post(
  '/:id/resume',
  asyncHandler(async (req, res) => {
    const run = await prisma.run.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!run) throw notFound('Run not found')
    if (!['PAUSED', 'FAILED', 'CANCELLED'].includes(run.status)) {
      throw badRequest('Only paused, failed or cancelled runs can be resumed.')
    }

    const updated = await prisma.run.update({
      where: { id: run.id },
      data: { status: 'QUEUED', error: null, finishedAt: null },
    })

    res.json({ run: updated })
  }),
)

/** "Run Daily Process Now" — fires the whole scheduled sweep on demand. */
runRouter.post(
  '/automation/run-now',
  asyncHandler(async (req, res) => {
    const result = await runDailyAutomation(req.orgId!)
    res.json(result)
  }),
)

runRouter.post(
  '/automation/dispatch',
  asyncHandler(async (req, res) => {
    const result = await dispatchDueSteps(req.orgId!)
    res.json(result)
  }),
)

runRouter.post(
  '/automation/digest',
  asyncHandler(async (req, res) => {
    const stats = await sendDailyDigest(req.orgId!)
    res.json({ stats })
  }),
)
