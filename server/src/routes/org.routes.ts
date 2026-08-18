import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { Role } from '@prisma/client'
import { prisma, logActivity } from '../db.js'
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js'
import { requireAuth, requireOrg, requireRole } from '../middleware/auth.js'
import { provisionWorkspace } from './auth.routes.js'
import { randomToken } from '../lib/crypto.js'
import { getPlan } from '../lib/plans.js'

export const orgRouter = Router()
orgRouter.use(requireAuth)

/** Creating an additional workspace is available to any signed-in user. */
orgRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body)
    const org = await provisionWorkspace(req.user!.id, body.name)
    res.status(201).json({ org: { id: org.id, name: org.name, slug: org.slug, role: 'OWNER' } })
  }),
)

orgRouter.use(requireOrg)

orgRouter.get(
  '/current',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.orgId! } })
    const [campaigns, contacts, templates, mailAccounts] = await Promise.all([
      prisma.campaign.count({ where: { orgId: org.id } }),
      prisma.contact.count({ where: { campaign: { orgId: org.id } } }),
      prisma.template.count({ where: { orgId: org.id, isArchived: false } }),
      prisma.mailAccount.count({ where: { orgId: org.id } }),
    ])

    res.json({
      org,
      role: req.role,
      usage: { campaigns, contacts, templates, mailAccounts },
    })
  }),
)

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  dailyRunHour: z.number().int().min(0).max(23).optional(),
  dailyRunMinute: z.number().int().min(0).max(59).optional(),
  automationOn: z.boolean().optional(),
  sendDailyDigest: z.boolean().optional(),
  digestEmail: z.string().trim().email().nullable().optional(),
  autoCleanBounce: z.boolean().optional(),
  // Users may lower their daily ceiling for safety, never raise it past the plan.
  maxDailyDrafts: z.number().int().min(1).max(20_000).optional(),
})

orgRouter.patch(
  '/current',
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => {
    const body = settingsSchema.parse(req.body)

    // Validate the timezone before storing it — an invalid zone would silently
    // break the daily scheduler for this workspace.
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }).format(new Date())
      } catch {
        throw badRequest(`"${body.timezone}" is not a valid IANA timezone.`)
      }
    }

    // The daily ceiling may be lowered for safety, but never raised above the
    // paid plan — otherwise the limit would be self-serve.
    if (body.maxDailyDrafts !== undefined) {
      const current = await prisma.organization.findUniqueOrThrow({ where: { id: req.orgId! } })
      const planCap = getPlan(current.planId).maxDailyDrafts
      if (body.maxDailyDrafts > planCap) {
        throw badRequest(
          `Your ${getPlan(current.planId).name} plan allows up to ${planCap.toLocaleString()} emails per day. Upgrade to raise this limit.`,
        )
      }
    }

    const org = await prisma.organization.update({ where: { id: req.orgId! }, data: body })

    await logActivity({
      orgId: org.id,
      userId: req.user!.id,
      type: 'workspace.updated',
      message: `${req.user!.name} updated workspace settings`,
      meta: body as Record<string, unknown>,
    })

    res.json({ org })
  }),
)

// ------------------------------ MEMBERS ------------------------------

orgRouter.get(
  '/members',
  asyncHandler(async (req, res) => {
    const members = await prisma.membership.findMany({
      where: { orgId: req.orgId! },
      include: { user: { select: { id: true, name: true, email: true, avatarColor: true, createdAt: true } } },
      orderBy: { createdAt: 'asc' },
    })
    res.json({ members })
  }),
)

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(80).optional(),
  role: z.nativeEnum(Role).default(Role.MEMBER),
})

/**
 * Adds a teammate. If they have no account yet one is created with a
 * generated password, returned once so the admin can hand it over.
 */
orgRouter.post(
  '/members',
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => {
    const body = inviteSchema.parse(req.body)
    if (body.role === Role.OWNER && req.role !== Role.OWNER) {
      throw badRequest('Only an owner can grant the owner role.')
    }

    let user = await prisma.user.findUnique({ where: { email: body.email } })
    let temporaryPassword: string | null = null

    if (!user) {
      temporaryPassword = randomToken(9)
      user = await prisma.user.create({
        data: {
          email: body.email,
          name: body.name || body.email.split('@')[0],
          passwordHash: await bcrypt.hash(temporaryPassword, 12),
        },
      })
    }

    const existing = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: req.orgId! } },
    })
    if (existing) throw conflict('This person is already a member of the workspace.')

    const membership = await prisma.membership.create({
      data: { userId: user.id, orgId: req.orgId!, role: body.role },
      include: { user: { select: { id: true, name: true, email: true, avatarColor: true } } },
    })

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'member.added',
      message: `${req.user!.name} added ${user.email} as ${body.role}`,
    })

    res.status(201).json({ member: membership, temporaryPassword })
  }),
)

orgRouter.patch(
  '/members/:id',
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => {
    const body = z.object({ role: z.nativeEnum(Role) }).parse(req.body)

    const membership = await prisma.membership.findFirst({
      where: { id: req.params.id, orgId: req.orgId! },
    })
    if (!membership) throw notFound('Member not found')

    if ((membership.role === Role.OWNER || body.role === Role.OWNER) && req.role !== Role.OWNER) {
      throw badRequest('Only an owner can change owner roles.')
    }

    // Never let the last owner demote themselves out of the workspace.
    if (membership.role === Role.OWNER && body.role !== Role.OWNER) {
      const owners = await prisma.membership.count({ where: { orgId: req.orgId!, role: Role.OWNER } })
      if (owners <= 1) throw badRequest('The workspace must keep at least one owner.')
    }

    const updated = await prisma.membership.update({ where: { id: membership.id }, data: { role: body.role } })
    res.json({ member: updated })
  }),
)

orgRouter.delete(
  '/members/:id',
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => {
    const membership = await prisma.membership.findFirst({
      where: { id: req.params.id, orgId: req.orgId! },
      include: { user: { select: { email: true } } },
    })
    if (!membership) throw notFound('Member not found')

    if (membership.role === Role.OWNER) {
      const owners = await prisma.membership.count({ where: { orgId: req.orgId!, role: Role.OWNER } })
      if (owners <= 1) throw badRequest('The workspace must keep at least one owner.')
    }

    await prisma.membership.delete({ where: { id: membership.id } })

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'member.removed',
      message: `${req.user!.name} removed ${membership.user.email}`,
    })

    res.json({ ok: true })
  }),
)

// ----------------------------- ACTIVITY ------------------------------

orgRouter.get(
  '/activity',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200)
    const activity = await prisma.activityLog.findMany({
      where: { orgId: req.orgId! },
      include: { user: { select: { name: true, avatarColor: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    res.json({ activity })
  }),
)
