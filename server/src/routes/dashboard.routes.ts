import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { asyncHandler } from '../lib/errors.js'
import { requireAuth, requireOrg } from '../middleware/auth.js'

export const dashboardRouter = Router()
dashboardRouter.use(requireAuth, requireOrg)

// Successor to updateDashboard() — computed live from run history instead of
// being rewritten into a sheet on every edit.

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const orgId = req.orgId!

    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)

    const weekAgo = new Date(todayStart)
    weekAgo.setDate(weekAgo.getDate() - 6)

    const trendStart = new Date(todayStart)
    trendStart.setDate(trendStart.getDate() - 13)

    const nextWeek = new Date(todayStart)
    nextWeek.setDate(nextWeek.getDate() + 7)

    const [
      campaignsTotal,
      campaignsActive,
      contactsByStatus,
      templatesCount,
      mailAccounts,
      draftsToday,
      draftsWeek,
      failedWeek,
      activeRuns,
      recentRuns,
      upcomingSteps,
      recentActivity,
    ] = await Promise.all([
      prisma.campaign.count({ where: { orgId } }),
      prisma.campaign.count({ where: { orgId, status: 'ACTIVE' } }),
      prisma.contact.groupBy({
        by: ['status'],
        where: { campaign: { orgId } },
        _count: { _all: true },
      }),
      prisma.template.count({ where: { orgId, isArchived: false } }),
      prisma.mailAccount.findMany({
        where: { orgId },
        select: { id: true, email: true, status: true, isDefault: true },
      }),
      prisma.runItem.count({ where: { status: 'SUCCESS', createdAt: { gte: todayStart }, run: { orgId } } }),
      prisma.runItem.count({ where: { status: 'SUCCESS', createdAt: { gte: weekAgo }, run: { orgId } } }),
      prisma.runItem.count({ where: { status: 'FAILED', createdAt: { gte: weekAgo }, run: { orgId } } }),
      prisma.run.count({ where: { orgId, status: { in: ['QUEUED', 'RUNNING'] } } }),
      prisma.run.findMany({
        where: { orgId },
        include: { campaign: { select: { id: true, name: true } } },
        orderBy: { startedAt: 'desc' },
        take: 8,
      }),
      prisma.campaignStep.findMany({
        where: {
          campaign: { orgId, status: { in: ['ACTIVE', 'DRAFT'] } },
          scheduledFor: { gte: todayStart, lte: nextWeek },
          status: { in: ['PENDING', 'SCHEDULED'] },
        },
        include: {
          campaign: { select: { id: true, name: true, status: true } },
          template: { select: { id: true, name: true } },
        },
        orderBy: { scheduledFor: 'asc' },
        take: 20,
      }),
      prisma.activityLog.findMany({
        where: { orgId },
        include: { user: { select: { name: true, avatarColor: true } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ])

    // 14-day activity trend, bucketed in the database.
    const trend = await prisma.$queryRaw<{ day: Date; status: string; count: number }[]>(
      Prisma.sql`
        SELECT date_trunc('day', ri."createdAt") AS day,
               ri."status"::text AS status,
               COUNT(*)::int AS count
        FROM "RunItem" ri
        JOIN "Run" r ON r."id" = ri."runId"
        WHERE r."orgId" = ${orgId} AND ri."createdAt" >= ${trendStart}
        GROUP BY 1, 2
        ORDER BY 1 ASC
      `,
    )

    const trendMap = new Map<string, { date: string; success: number; failed: number; skipped: number }>()
    for (let i = 0; i < 14; i++) {
      const day = new Date(trendStart)
      day.setDate(day.getDate() + i)
      const key = day.toISOString().slice(0, 10)
      trendMap.set(key, { date: key, success: 0, failed: 0, skipped: 0 })
    }
    for (const row of trend) {
      const key = new Date(row.day).toISOString().slice(0, 10)
      const bucket = trendMap.get(key)
      if (!bucket) continue
      if (row.status === 'SUCCESS') bucket.success += row.count
      else if (row.status === 'FAILED') bucket.failed += row.count
      else bucket.skipped += row.count
    }

    // Per-step totals across the workspace (the follow-up funnel).
    const stepTotals = await prisma.run.groupBy({
      by: ['kind'],
      where: { orgId },
      _sum: { succeeded: true, failed: true, skipped: true },
    })

    // Per-campaign summary — the old Dashboard sheet, one row per campaign.
    const campaigns = await prisma.campaign.findMany({
      where: { orgId, status: { not: 'ARCHIVED' } },
      include: {
        steps: {
          include: { template: { select: { name: true } } },
          orderBy: { kind: 'asc' },
        },
        _count: { select: { contacts: true } },
        runs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
      take: 25,
    })

    const contactStats = Object.fromEntries(contactsByStatus.map((c) => [c.status, c._count._all]))
    const totalContacts = contactsByStatus.reduce((sum, c) => sum + c._count._all, 0)

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })

    res.json({
      summary: {
        campaignsTotal,
        campaignsActive,
        totalContacts,
        activeContacts: contactStats.ACTIVE ?? 0,
        bouncedContacts: contactStats.BOUNCED ?? 0,
        unsubscribedContacts: contactStats.UNSUBSCRIBED ?? 0,
        templatesCount,
        draftsToday,
        draftsWeek,
        failedWeek,
        activeRuns,
        dailyQuota: org.maxDailyDrafts,
        quotaRemaining: Math.max(0, org.maxDailyDrafts - draftsToday),
        automationOn: org.automationOn,
        dailyRunTime: `${String(org.dailyRunHour).padStart(2, '0')}:${String(org.dailyRunMinute).padStart(2, '0')}`,
        timezone: org.timezone,
      },
      mailAccounts,
      trend: [...trendMap.values()],
      funnel: ['NEW', 'FOLLOWUP_1', 'FOLLOWUP_2', 'FOLLOWUP_3'].map((kind) => {
        const row = stepTotals.find((s) => s.kind === kind)
        return {
          kind,
          succeeded: row?._sum.succeeded ?? 0,
          failed: row?._sum.failed ?? 0,
          skipped: row?._sum.skipped ?? 0,
        }
      }),
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        contacts: c._count.contacts,
        deliveryMode: c.deliveryMode,
        lastRun: c.runs[0] ?? null,
        steps: c.steps.map((s) => ({
          kind: s.kind,
          status: s.status,
          scheduledFor: s.scheduledFor,
          templateName: s.template?.name ?? null,
          sentCount: s.sentCount,
        })),
      })),
      upcoming: upcomingSteps,
      recentRuns,
      recentActivity,
    })
  }),
)
