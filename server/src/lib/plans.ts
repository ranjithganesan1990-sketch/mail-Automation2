// =============================================================
//  PLAN CATALOG
//  The single source of truth for what each tier allows. Limits
//  are copied onto the Organization when a subscription changes,
//  so an enterprise deal can be overridden per-workspace without
//  editing this file.
// =============================================================

export type PlanId = 'free' | 'starter' | 'pro' | 'business'

export interface PlanLimits {
  maxContacts: number
  maxDailyDrafts: number
  maxMailAccounts: number
  maxCampaigns: number
}

export interface Plan extends PlanLimits {
  id: PlanId
  name: string
  description: string
  /** Monthly price in the smallest currency unit (paise/cents). */
  amount: number
  currency: string
  /** Stripe Price ID — set per environment. Empty means "not purchasable yet". */
  priceIdEnv: string
  features: string[]
  popular?: boolean
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    description: 'Try the full workflow on a small list.',
    amount: 0,
    currency: 'usd',
    priceIdEnv: '',
    maxContacts: 500,
    maxDailyDrafts: 100,
    maxMailAccounts: 1,
    maxCampaigns: 3,
    features: [
      '3 campaigns',
      '500 contacts',
      '100 emails per day',
      '1 connected mailbox',
      'Full 3-level follow-up sequence',
      'Templates with version history',
    ],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    description: 'For a single person running steady outreach.',
    amount: 2900,
    currency: 'usd',
    priceIdEnv: 'STRIPE_PRICE_STARTER',
    maxContacts: 5_000,
    maxDailyDrafts: 500,
    maxMailAccounts: 3,
    maxCampaigns: 25,
    features: [
      '25 campaigns',
      '5,000 contacts',
      '500 emails per day',
      '3 connected mailboxes',
      'Daily automation & digest',
      'Bounce detection',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    description: 'For a team running several campaigns at once.',
    amount: 7900,
    currency: 'usd',
    priceIdEnv: 'STRIPE_PRICE_PRO',
    maxContacts: 25_000,
    maxDailyDrafts: 2_000,
    maxMailAccounts: 10,
    maxCampaigns: 200,
    popular: true,
    features: [
      '200 campaigns',
      '25,000 contacts',
      '2,000 emails per day',
      '10 connected mailboxes',
      'Unlimited team members',
      'Priority support',
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    description: 'High volume across many mailboxes.',
    amount: 19900,
    currency: 'usd',
    priceIdEnv: 'STRIPE_PRICE_BUSINESS',
    maxContacts: 100_000,
    maxDailyDrafts: 5_000,
    maxMailAccounts: 50,
    maxCampaigns: 1_000,
    features: [
      '1,000 campaigns',
      '100,000 contacts',
      '5,000 emails per day',
      '50 connected mailboxes',
      'Unlimited team members',
      'Priority support',
    ],
  },
}

export const PLAN_ORDER: PlanId[] = ['free', 'starter', 'pro', 'business']

export function isPlanId(value: string): value is PlanId {
  return value in PLANS
}

export function getPlan(id: string): Plan {
  return isPlanId(id) ? PLANS[id] : PLANS.free
}

/** Resolves the configured Stripe Price ID for a plan, if any. */
export function priceIdFor(plan: Plan): string | null {
  if (!plan.priceIdEnv) return null
  return process.env[plan.priceIdEnv] || null
}

/** Reverse lookup used by the webhook to map a Stripe price back to a plan. */
export function planForPriceId(priceId: string): Plan | null {
  for (const id of PLAN_ORDER) {
    const plan = PLANS[id]
    if (plan.priceIdEnv && process.env[plan.priceIdEnv] === priceId) return plan
  }
  return null
}

export function limitsFor(plan: Plan): PlanLimits {
  return {
    maxContacts: plan.maxContacts,
    maxDailyDrafts: plan.maxDailyDrafts,
    maxMailAccounts: plan.maxMailAccounts,
    maxCampaigns: plan.maxCampaigns,
  }
}

/** Subscription states that still grant paid access. */
export const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due'])
