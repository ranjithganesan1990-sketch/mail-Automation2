import { prisma } from '../db.js'
import { AppError } from '../lib/errors.js'
import { getPlan } from '../lib/plans.js'

// Plan enforcement lives on the server, not in the UI. The dashboard hides
// buttons past a limit as a courtesy; these checks are what actually hold.

type Resource = 'contacts' | 'campaigns' | 'mailAccounts'

const LABELS: Record<Resource, string> = {
  contacts: 'contacts',
  campaigns: 'campaigns',
  mailAccounts: 'connected mailboxes',
}

export class PlanLimitError extends AppError {
  constructor(message: string, meta: Record<string, unknown>) {
    super(402, message, 'plan_limit_reached', meta)
  }
}

/**
 * Throws 402 when adding `incoming` more of a resource would break the plan.
 * 402 is what the dashboard listens for to show the upgrade prompt.
 */
export async function assertWithinLimit(orgId: string, resource: Resource, incoming = 1): Promise<void> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })

  const limit =
    resource === 'contacts' ? org.maxContacts : resource === 'campaigns' ? org.maxCampaigns : org.maxMailAccounts

  const current =
    resource === 'contacts'
      ? await prisma.contact.count({ where: { campaign: { orgId } } })
      : resource === 'campaigns'
        ? await prisma.campaign.count({ where: { orgId, status: { not: 'ARCHIVED' } } })
        : await prisma.mailAccount.count({ where: { orgId } })

  if (current + incoming <= limit) return

  const plan = getPlan(org.planId)
  const noun = LABELS[resource]

  throw new PlanLimitError(
    incoming === 1
      ? `Your ${plan.name} plan allows ${limit.toLocaleString()} ${noun} and you already have ${current.toLocaleString()}. Upgrade to add more.`
      : `Importing ${incoming.toLocaleString()} would exceed your ${plan.name} plan limit of ${limit.toLocaleString()} ${noun} (currently ${current.toLocaleString()}). Upgrade to add more.`,
    { resource, limit, current, incoming, plan: plan.id },
  )
}
