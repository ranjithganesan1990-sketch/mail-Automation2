import type { NextFunction, Request, Response } from 'express'
import { Role } from '@prisma/client'
import { prisma } from '../db.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { verifyToken } from '../lib/jwt.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string }
      orgId?: string
      role?: Role
      /** Set by requireInstanceAdmin — the oldest workspace on this instance. */
      instanceOrgId?: string
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.token
  return cookie ?? null
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req)
  if (!token) return next(unauthorized())

  const payload = verifyToken(token)
  if (!payload) return next(unauthorized('Session expired. Please sign in again.'))

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, name: true },
  })
  if (!user) return next(unauthorized('Account no longer exists.'))

  req.user = user
  next()
}

/**
 * Resolves the active organization from the X-Org-Id header (or the user's
 * first membership) and asserts the caller belongs to it. Every tenant-scoped
 * query downstream filters on req.orgId, which is how data isolation is enforced.
 */
export async function requireOrg(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized())

  const requested = (req.headers['x-org-id'] as string | undefined) ?? (req.query.orgId as string | undefined)

  const membership = requested
    ? await prisma.membership.findUnique({
        where: { userId_orgId: { userId: req.user.id, orgId: requested } },
      })
    : await prisma.membership.findFirst({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'asc' },
      })

  if (!membership) {
    return next(forbidden('You are not a member of this workspace.'))
  }

  req.orgId = membership.orgId
  req.role = membership.role
  next()
}

/**
 * Guards settings that are server-wide rather than per-workspace.
 *
 * Roles are scoped to an organization, so "OWNER" on its own is too weak a
 * check here: on a multi-tenant deployment it would let the owner of any
 * workspace rewrite the Google OAuth client that every other workspace
 * authenticates through. The instance owner is defined as an OWNER of the
 * oldest workspace — on a self-hosted install, whoever registered first.
 */
export async function requireInstanceAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user) return next(unauthorized())

    const root = await prisma.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (!root) return next(forbidden('No workspace exists yet.'))

    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: req.user.id, orgId: root.id } },
    })
    if (!membership || membership.role !== Role.OWNER) {
      return next(forbidden('Only the instance owner can change server-wide settings.'))
    }

    req.instanceOrgId = root.id
    next()
  } catch (err) {
    next(err)
  }
}

const RANK: Record<Role, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 }

export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.role) return next(forbidden())
    if (RANK[req.role] < RANK[min]) {
      return next(forbidden(`This action requires the ${min.toLowerCase()} role.`))
    }
    next()
  }
}
