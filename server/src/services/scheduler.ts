import cron from 'node-cron'
import { prisma, logActivity } from '../db.js'
import { env } from '../env.js'
import { processRunChunk, queueRun } from './runner.js'
import { cleanBouncedContacts } from './bounce.js'
import { sendDailyDigest } from './digest.js'
import { dayBounds, localParts } from '../lib/day.js'

// =============================================================
//  AUTOMATION SCHEDULER
//  - Worker tick: drains QUEUED/RUNNING runs in bounded chunks
//    (replaces the Apps Script 6-minute timeout + resume trigger)
//  - Minute tick: fires each workspace's daily automation at its
//    own local time (replaces the fixed 6:30 AM project trigger)
// =============================================================

let workerBusy = false
let started = false

// Day-key helpers live in lib/day.ts so the digest writer and this
// scheduler cannot drift apart again — see the note there.

/** How many times a day's digest may be attempted before giving up. */
const DIGEST_MAX_ATTEMPTS = 3
/** Spacing between retries of a failed digest. */
const DIGEST_RETRY_BACKOFF_MS = 30 * 60 * 1000

// ------------------------- DAILY DISPATCH ---------------------------

export interface DispatchResult {
  queued: number
  noTemplate: number
  errors: string[]
}

/**
 * Finds every campaign step scheduled for today and queues a run for it.
 * Direct successor to dailyAutoProcess() + processScheduledEmails().
 */
export async function dispatchDueSteps(orgId: string, now = new Date()): Promise<DispatchResult> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
  const { start, end } = dayBounds(org.timezone, now)

  const dueSteps = await prisma.campaignStep.findMany({
    where: {
      campaign: { orgId, status: 'ACTIVE' },
      scheduledFor: { gte: start, lte: end },
      status: { in: ['PENDING', 'SCHEDULED'] },
    },
    include: { campaign: { select: { id: true, name: true } } },
    orderBy: { kind: 'asc' },
  })

  const result: DispatchResult = { queued: 0, noTemplate: 0, errors: [] }

  for (const step of dueSteps) {
    if (!step.templateId) {
      await prisma.campaignStep.update({
        where: { id: step.id },
        data: { status: 'NO_TEMPLATE', notes: 'No template selected for this step.' },
      })
      result.noTemplate += 1
      continue
    }

    try {
      await queueRun({
        orgId,
        campaignId: step.campaignId,
        kind: step.kind,
        trigger: 'SCHEDULED',
      })
      result.queued += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`${step.campaign.name} — ${step.kind}: ${message}`)
      await prisma.campaignStep.update({
        where: { id: step.id },
        data: { status: 'FAILED', notes: message.slice(0, 500) },
      })
    }
  }

  return result
}

/** The full daily job for one workspace. */
export async function runDailyAutomation(orgId: string, now = new Date()) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })

  const dispatch = await dispatchDueSteps(orgId, now)

  let bounced = 0
  if (org.autoCleanBounce) {
    try {
      const result = await cleanBouncedContacts(orgId)
      bounced = result.markedBounced
    } catch (err) {
      dispatch.errors.push(`Bounce cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await logActivity({
    orgId,
    type: 'automation.daily',
    message: `Daily automation: ${dispatch.queued} step(s) queued, ${bounced} bounce(s) cleaned`,
    meta: { ...dispatch, bounced },
  })

  return { ...dispatch, bounced }
}

// ---------------------------- TICKERS -------------------------------

async function workerTick() {
  if (workerBusy) return
  workerBusy = true
  try {
    const run = await prisma.run.findFirst({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { startedAt: 'asc' },
    })
    if (run) {
      await processRunChunk(run.id)
      return
    }

    // No active work — see if any workspace is waiting on its digest.
    await flushPendingDigests()
  } catch (err) {
    console.error('[worker] tick failed:', err)
  } finally {
    workerBusy = false
  }
}

/** Sends a workspace's digest once its runs for the day have all settled. */
async function flushPendingDigests() {
  const orgs = await prisma.organization.findMany({ where: { sendDailyDigest: true } })

  for (const org of orgs) {
    const { start, end, date } = dayBounds(org.timezone)
    const local = localParts(org.timezone)

    // Only consider sending after the daily run time has passed.
    if (local.hour * 60 + local.minute < org.dailyRunHour * 60 + org.dailyRunMinute) continue

    const pending = await prisma.run.count({
      where: { orgId: org.id, status: { in: ['QUEUED', 'RUNNING'] } },
    })
    if (pending > 0) continue

    const ranToday = await prisma.run.count({
      where: { orgId: org.id, startedAt: { gte: start, lte: end } },
    })
    if (ranToday === 0) continue

    const [y, m, d] = date.split('-').map(Number)
    const forDate = new Date(Date.UTC(y, m - 1, d))

    const existing = await prisma.digest.findUnique({
      where: { orgId_forDate: { orgId: org.id, forDate } },
    })
    if (existing?.sentAt) continue

    try {
      await sendDailyDigest(org.id, forDate)
    } catch (err) {
      console.error(`[digest] failed for org ${org.id}:`, err)
    }
  }
}

async function minuteTick() {
  try {
    const orgs = await prisma.organization.findMany({ where: { automationOn: true } })
    const now = new Date()

    for (const org of orgs) {
      const local = localParts(org.timezone, now)
      if (local.hour !== org.dailyRunHour || local.minute !== org.dailyRunMinute) continue

      // Guard against double-firing inside the same local minute.
      const [y, m, d] = local.date.split('-').map(Number)
      const dayStart = new Date(Date.UTC(y, m - 1, d))
      const alreadyRan = await prisma.activityLog.findFirst({
        where: { orgId: org.id, type: 'automation.daily', createdAt: { gte: dayStart } },
      })
      if (alreadyRan) continue

      console.log(`[automation] running daily job for ${org.name} (${local.date} ${local.hour}:${local.minute})`)
      await runDailyAutomation(org.id, now)
    }
  } catch (err) {
    console.error('[scheduler] minute tick failed:', err)
  }
}

export function startScheduler() {
  if (started) return
  started = true

  setInterval(() => void workerTick(), env.worker.tickMs)
  cron.schedule('* * * * *', () => void minuteTick())

  console.log(`[scheduler] worker every ${env.worker.tickMs}ms, automation check every minute`)
}

/** Re-queues runs that were mid-flight when the process restarted. */
export async function recoverInterruptedRuns() {
  const stuck = await prisma.run.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'QUEUED' },
  })
  if (stuck.count > 0) {
    console.log(`[scheduler] recovered ${stuck.count} interrupted run(s)`)
  }
}
