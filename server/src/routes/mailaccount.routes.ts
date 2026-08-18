import { Router } from 'express'
import { z } from 'zod'
import { Role } from '@prisma/client'
import { prisma, logActivity } from '../db.js'
import { env } from '../env.js'
import { asyncHandler, badRequest, notFound } from '../lib/errors.js'
import { signState, verifyState } from '../lib/jwt.js'
import { encrypt } from '../lib/crypto.js'
import { requireAuth, requireOrg, requireRole } from '../middleware/auth.js'
import { assertWithinLimit } from '../middleware/plan.js'
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  getGmailClient,
  getProfileEmail,
  requireGoogleConfig,
} from '../lib/gmail.js'
import { isGoogleConfigured } from '../lib/appconfig.js'

export const mailAccountRouter = Router()

// ---------------------- PUBLIC OAUTH CALLBACK ------------------------
// Google redirects the browser here, so this route cannot require a
// bearer token. Trust comes from the signed `state` we issued ourselves.

mailAccountRouter.get(
  '/oauth/callback',
  asyncHandler(async (req, res) => {
    const redirect = (params: Record<string, string>) => {
      const url = new URL('/settings/mailboxes', env.appUrl)
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
      return res.redirect(url.toString())
    }

    const error = req.query.error as string | undefined
    if (error) return redirect({ error })

    const code = req.query.code as string | undefined
    const state = req.query.state as string | undefined
    if (!code || !state) return redirect({ error: 'missing_code' })

    const parsed = verifyState<{ orgId: string; userId: string }>(state)
    if (!parsed) return redirect({ error: 'expired_state' })

    // Re-verify membership: the state proves who started the flow, not that
    // they still have access.
    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: parsed.userId, orgId: parsed.orgId } },
    })
    if (!membership) return redirect({ error: 'forbidden' })

    try {
      const { tokens, email, name } = await exchangeCodeForTokens(code)
      if (!email) return redirect({ error: 'no_email' })

      const existing = await prisma.mailAccount.findUnique({
        where: { orgId_email: { orgId: parsed.orgId, email } },
      })

      const accountCount = await prisma.mailAccount.count({ where: { orgId: parsed.orgId } })

      // Reconnecting an existing mailbox is always allowed; adding a new one
      // has to fit the plan.
      if (!existing) {
        const org = await prisma.organization.findUniqueOrThrow({ where: { id: parsed.orgId } })
        if (accountCount >= org.maxMailAccounts) return redirect({ error: 'plan_limit' })
      }

      await prisma.mailAccount.upsert({
        where: { orgId_email: { orgId: parsed.orgId, email } },
        create: {
          orgId: parsed.orgId,
          email,
          name,
          accessToken: encrypt(tokens.access_token ?? null),
          refreshToken: encrypt(tokens.refresh_token ?? null),
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          scope: tokens.scope ?? null,
          status: 'ACTIVE',
          isDefault: accountCount === 0,
        },
        update: {
          name,
          accessToken: encrypt(tokens.access_token ?? null),
          // Google only returns a refresh token on first consent; keep the old
          // one if this grant did not include a new one.
          ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          scope: tokens.scope ?? null,
          status: 'ACTIVE',
          lastError: null,
        },
      })

      await logActivity({
        orgId: parsed.orgId,
        userId: parsed.userId,
        type: 'mailbox.connected',
        message: `${existing ? 'Reconnected' : 'Connected'} mailbox ${email}`,
      })

      return redirect({ connected: email })
    } catch (err) {
      console.error('[oauth] callback failed:', err)
      return redirect({ error: 'exchange_failed' })
    }
  }),
)

// -------------------------- AUTHENTICATED ---------------------------

mailAccountRouter.use(requireAuth, requireOrg)

mailAccountRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const accounts = await prisma.mailAccount.findMany({
      where: { orgId: req.orgId! },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        email: true,
        name: true,
        provider: true,
        status: true,
        isDefault: true,
        lastError: true,
        createdAt: true,
        expiresAt: true,
        _count: { select: { campaigns: true } },
      },
    })

    res.json({ accounts, googleConfigured: await isGoogleConfigured() })
  }),
)

/** Returns the Google consent URL for the browser to open. */
mailAccountRouter.get(
  '/oauth/url',
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => {
    await requireGoogleConfig()

    // Fail before sending the user to Google if they have no room left.
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.orgId! } })
    const count = await prisma.mailAccount.count({ where: { orgId: req.orgId! } })
    if (count >= org.maxMailAccounts) {
      await assertWithinLimit(req.orgId!, 'mailAccounts')
    }

    const state = signState({ orgId: req.orgId!, userId: req.user!.id })
    res.json({ url: await buildAuthUrl(state) })
  }),
)

mailAccountRouter.post(
  '/:id/default',
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => {
    const account = await prisma.mailAccount.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!account) throw notFound('Mailbox not found')

    await prisma.$transaction([
      prisma.mailAccount.updateMany({ where: { orgId: req.orgId! }, data: { isDefault: false } }),
      prisma.mailAccount.update({ where: { id: account.id }, data: { isDefault: true } }),
    ])

    res.json({ ok: true })
  }),
)

/** Round-trips to Gmail to confirm the stored credentials still work. */
mailAccountRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const account = await prisma.mailAccount.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!account) throw notFound('Mailbox not found')

    try {
      const gmail = await getGmailClient(account)
      const email = await getProfileEmail(gmail)
      await prisma.mailAccount.update({
        where: { id: account.id },
        data: { status: 'ACTIVE', lastError: null },
      })
      res.json({ ok: true, email })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await prisma.mailAccount.update({
        where: { id: account.id },
        data: { status: 'NEEDS_REAUTH', lastError: message.slice(0, 1000) },
      })
      throw badRequest(`Connection test failed: ${message}`)
    }
  }),
)

mailAccountRouter.patch(
  '/:id',
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().max(120).nullable().optional(),
        status: z.enum(['ACTIVE', 'DISABLED']).optional(),
      })
      .parse(req.body)

    const account = await prisma.mailAccount.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!account) throw notFound('Mailbox not found')

    const updated = await prisma.mailAccount.update({ where: { id: account.id }, data: body })
    res.json({ account: { id: updated.id, email: updated.email, name: updated.name, status: updated.status } })
  }),
)

mailAccountRouter.delete(
  '/:id',
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => {
    const account = await prisma.mailAccount.findFirst({
      where: { id: req.params.id, orgId: req.orgId! },
      include: { _count: { select: { campaigns: true } } },
    })
    if (!account) throw notFound('Mailbox not found')

    if (account._count.campaigns > 0) {
      throw badRequest(
        `${account.email} is used by ${account._count.campaigns} campaign(s). Reassign them before disconnecting.`,
      )
    }

    await prisma.mailAccount.delete({ where: { id: account.id } })

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'mailbox.disconnected',
      message: `${req.user!.name} disconnected ${account.email}`,
    })

    res.json({ ok: true })
  }),
)
