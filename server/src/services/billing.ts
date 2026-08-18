import type Stripe from 'stripe'
import type { Organization } from '@prisma/client'
import { prisma, logActivity } from '../db.js'
import { ACTIVE_STATUSES, getPlan, limitsFor, planForPriceId, PLANS } from '../lib/plans.js'
import { getStripe } from '../lib/stripe.js'

// =============================================================
//  SUBSCRIPTION SYNC
//  Stripe is the source of truth for what a workspace has paid
//  for. Everything here reduces a Stripe object down to the four
//  numbers the rest of the app enforces.
// =============================================================

/** Finds or creates the Stripe customer backing a workspace. */
export async function ensureCustomer(org: Organization, email: string): Promise<string> {
  if (org.stripeCustomerId) return org.stripeCustomerId

  const stripe = getStripe()
  const customer = await stripe.customers.create({
    name: org.name,
    email,
    metadata: { orgId: org.id, slug: org.slug },
  })

  await prisma.organization.update({
    where: { id: org.id },
    data: { stripeCustomerId: customer.id },
  })

  return customer.id
}

function periodEndOf(subscription: Stripe.Subscription): Date | null {
  // Stripe moved current_period_end onto the subscription items; read either.
  const raw =
    (subscription as unknown as { current_period_end?: number }).current_period_end ??
    subscription.items?.data?.[0]?.current_period_end

  return typeof raw === 'number' ? new Date(raw * 1000) : null
}

/**
 * Writes a Stripe subscription onto the workspace, including the plan limits
 * the rest of the app enforces. Downgrades to free when the subscription is
 * no longer in a paying state.
 */
export async function applySubscription(orgId: string, subscription: Stripe.Subscription) {
  const priceId = subscription.items.data[0]?.price?.id ?? ''
  const matched = planForPriceId(priceId)
  const active = ACTIVE_STATUSES.has(subscription.status)

  // An unknown price means Stripe has a product we don't recognise — keep the
  // workspace on free rather than silently granting unlimited access.
  const plan = active && matched ? matched : PLANS.free

  await prisma.organization.update({
    where: { id: orgId },
    data: {
      planId: plan.id,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      currentPeriodEnd: periodEndOf(subscription),
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      ...limitsFor(plan),
    },
  })

  await logActivity({
    orgId,
    type: 'billing.subscription_updated',
    message: `Subscription ${subscription.status} — now on the ${plan.name} plan`,
    meta: { plan: plan.id, status: subscription.status, priceId },
  })
}

/** Cancellation or deletion — return the workspace to the free tier. */
export async function revertToFree(orgId: string, reason: string) {
  const free = PLANS.free

  await prisma.organization.update({
    where: { id: orgId },
    data: {
      planId: free.id,
      stripeSubscriptionId: null,
      subscriptionStatus: 'canceled',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      ...limitsFor(free),
    },
  })

  await logActivity({
    orgId,
    type: 'billing.reverted_to_free',
    message: `Subscription ended (${reason}) — workspace moved to the Free plan`,
  })
}

/** Resolves which workspace a Stripe object belongs to. */
export async function resolveOrgId(params: {
  orgId?: string | null
  customerId?: string | null
}): Promise<string | null> {
  if (params.orgId) {
    const byId = await prisma.organization.findUnique({ where: { id: params.orgId } })
    if (byId) return byId.id
  }
  if (params.customerId) {
    const byCustomer = await prisma.organization.findUnique({
      where: { stripeCustomerId: params.customerId },
    })
    if (byCustomer) return byCustomer.id
  }
  return null
}

export interface UsageSnapshot {
  contacts: number
  campaigns: number
  mailAccounts: number
  draftsToday: number
}

export async function collectUsage(orgId: string): Promise<UsageSnapshot> {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [contacts, campaigns, mailAccounts, draftsToday] = await Promise.all([
    prisma.contact.count({ where: { campaign: { orgId } } }),
    prisma.campaign.count({ where: { orgId, status: { not: 'ARCHIVED' } } }),
    prisma.mailAccount.count({ where: { orgId } }),
    prisma.runItem.count({ where: { status: 'SUCCESS', createdAt: { gte: todayStart }, run: { orgId } } }),
  ])

  return { contacts, campaigns, mailAccounts, draftsToday }
}

/** Everything the billing page needs in one call. */
export async function billingSummary(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })
  const usage = await collectUsage(orgId)
  const plan = getPlan(org.planId)

  return {
    plan,
    subscription: {
      status: org.subscriptionStatus,
      currentPeriodEnd: org.currentPeriodEnd,
      cancelAtPeriodEnd: org.cancelAtPeriodEnd,
      hasSubscription: Boolean(org.stripeSubscriptionId),
    },
    limits: {
      maxContacts: org.maxContacts,
      maxDailyDrafts: org.maxDailyDrafts,
      maxMailAccounts: org.maxMailAccounts,
      maxCampaigns: org.maxCampaigns,
    },
    usage,
  }
}
