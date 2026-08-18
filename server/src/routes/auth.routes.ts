import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma, logActivity } from '../db.js'
import { asyncHandler, badRequest, conflict, unauthorized } from '../lib/errors.js'
import { signToken } from '../lib/jwt.js'
import { requireAuth } from '../middleware/auth.js'

export const authRouter = Router()

const AVATAR_COLORS = ['#1E88E5', '#7B1FA2', '#00897B', '#E64A19', '#5E35B1', '#00838F', '#C2185B']

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  )
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base)
  let candidate = root
  let n = 1
  while (await prisma.organization.findUnique({ where: { slug: candidate } })) {
    candidate = `${root}-${++n}`
  }
  return candidate
}

const STARTER_TEMPLATE_HTML = `
<p>Hi {{First Name|there}},</p>
<p>I came across {{Company Name}} and wanted to reach out.</p>
<p>We help teams like yours run their outbound email without the manual work — personalised first touches and automatic follow-ups, all from one dashboard.</p>
<p>Would a short call next week be useful?</p>
<p>Best regards,<br>{{Sender Name|The Team}}</p>
`.trim()

const FOLLOWUP_TEMPLATE_HTML = `
<p>Hi {{First Name|there}},</p>
<p>Just floating this back to the top of your inbox in case it got buried.</p>
<p>Happy to send over a short overview if that is easier than a call.</p>
<p>Best regards,<br>{{Sender Name|The Team}}</p>
`.trim()

/** Creates the workspace, the owner membership and two starter templates. */
export async function provisionWorkspace(userId: string, workspaceName: string) {
  const org = await prisma.organization.create({
    data: {
      name: workspaceName,
      slug: await uniqueSlug(workspaceName),
      members: { create: { userId, role: 'OWNER' } },
    },
  })

  await prisma.template.createMany({
    data: [
      {
        orgId: org.id,
        name: 'Initial Outreach',
        description: 'First touch — introduces you and asks for a call.',
        subject: '{{Company Name}}',
        html: STARTER_TEMPLATE_HTML,
        createdById: userId,
      },
      {
        orgId: org.id,
        name: 'Follow-up — Gentle Nudge',
        description: 'Short reply that lands in the same Gmail thread.',
        subject: '{{Company Name}}',
        html: FOLLOWUP_TEMPLATE_HTML,
        createdById: userId,
      },
    ],
  })

  return org
}

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  workspaceName: z.string().trim().min(1).max(80).optional(),
})

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body)

    const existing = await prisma.user.findUnique({ where: { email: body.email } })
    if (existing) throw conflict('An account with this email already exists.')

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 12),
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      },
    })

    const org = await provisionWorkspace(user.id, body.workspaceName || `${body.name}'s Workspace`)

    await logActivity({
      orgId: org.id,
      userId: user.id,
      type: 'workspace.created',
      message: `${user.name} created the workspace`,
    })

    res.status(201).json({
      token: signToken({ userId: user.id, email: user.email }),
      user: { id: user.id, name: user.name, email: user.email, avatarColor: user.avatarColor },
      org: { id: org.id, name: org.name, slug: org.slug, role: 'OWNER' },
    })
  }),
)

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
})

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body)

    const user = await prisma.user.findUnique({ where: { email: body.email } })
    // Same message either way so the endpoint cannot be used to enumerate accounts.
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      throw unauthorized('Incorrect email or password.')
    }

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id },
      include: { org: true },
      orderBy: { createdAt: 'asc' },
    })

    res.json({
      token: signToken({ userId: user.id, email: user.email }),
      user: { id: user.id, name: user.name, email: user.email, avatarColor: user.avatarColor },
      org: membership
        ? { id: membership.org.id, name: membership.org.name, slug: membership.org.slug, role: membership.role }
        : null,
    })
  }),
)

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.id },
      include: { org: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { id: true, name: true, email: true, avatarColor: true, createdAt: true },
    })

    res.json({
      user,
      orgs: memberships.map((m) => ({ ...m.org, role: m.role })),
    })
  }),
)

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
})

authRouter.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = passwordSchema.parse(req.body)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })

    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw badRequest('Current password is incorrect.')
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(body.newPassword, 12) },
    })

    res.json({ ok: true })
  }),
)

const profileSchema = z.object({ name: z.string().trim().min(1).max(80) })

authRouter.patch(
  '/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = profileSchema.parse(req.body)
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { name: body.name },
      select: { id: true, name: true, email: true, avatarColor: true },
    })
    res.json({ user })
  }),
)
