import { Router } from 'express'
import { z } from 'zod'
import { Role } from '@prisma/client'
import { prisma, logActivity } from '../db.js'
import { env } from '../env.js'
import { asyncHandler, badRequest } from '../lib/errors.js'
import { getPlan, isPlanId, PLAN_ORDER, PLANS, priceIdFor } from '../lib/plans.js'
import { getStripe, stripeConfigured } from '../lib/stripe.js'
import { requireAuth, requireOrg, requireRole } from '../middleware/auth.js'
import { billingSummary, ensureCustomer } from '../services/billing.js'

export const billingRouter = Router()
billingRouter.use(requireAuth, requireOrg)

/** Plan catalog plus this workspace's current subscription and usage. */
billingRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const summary = await billingSummary(req.orgId!)

    res.json({
      ...summary,
      stripeConfigured,
      plans: PLAN_ORDER.map((id) => {
        const plan = PLANS[id]
        return {
          id: plan.id,
          name: plan.name,
          description: plan.description,
          amount: plan.amount,
          currency: plan.currency,
          features: plan.features,
          popular: plan.popular ?? false,
          maxContacts: plan.maxContacts,
          maxDailyDrafts: plan.maxDailyDrafts,
          maxMailAccounts: plan.maxMailAccounts,
          maxCampaigns: plan.maxCampaigns,
          // A plan with no configured Stripe price cannot be checked out yet.
          available: plan.id === 'free' || Boolean(priceIdFor(plan)),
        }
      }),
    })
  }),
)

const checkoutSchema = z.object({ planId: z.string() })

/**
 * Starts a Stripe Checkout session. Payment details are entered on Stripe's
 * own hosted page — no card data ever reaches this server.
 */
billingRouter.post(
  '/checkout',
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    const body = checkoutSchema.parse(req.body)
    if (!isPlanId(body.planId)) throw badRequest('Unknown plan.')
    if (body.planId === 'free') throw badRequest('The Free plan does not require checkout. Cancel your subscription instead.')

    const plan = PLANS[body.planId]
    const priceId = priceIdFor(plan)
    if (!priceId) {
      throw badRequest(`The ${plan.name} plan has no Stripe price configured. Set ${plan.priceIdEnv} in server/.env.`)
    }

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.orgId! } })
    const customerId = await ensureCustomer(org, req.user!.email)

    const stripe = getStripe()
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${env.appUrl}/settings/billing?checkout=success`,
      cancel_url: `${env.appUrl}/settings/billing?checkout=cancelled`,
      client_reference_id: org.id,
      subscription_data: { metadata: { orgId: org.id, planId: plan.id } },
      metadata: { orgId: org.id, planId: plan.id },
      allow_promotion_codes: true,
    })

    await logActivity({
      orgId: org.id,
      userId: req.user!.id,
      type: 'billing.checkout_started',
      message: `${req.user!.name} started checkout for the ${plan.name} plan`,
      meta: { planId: plan.id },
    })

    res.json({ url: session.url })
  }),
)

/** Opens Stripe's billing portal for card changes, invoices and cancellation. */
billingRouter.post(
  '/portal',
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.orgId! } })
    if (!org.stripeCustomerId) throw badRequest('This workspace has no billing account yet.')

    const stripe = getStripe()
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${env.appUrl}/settings/billing`,
    })

    res.json({ url: session.url })
  }),
)

billingRouter.get(
  '/invoices',
  requireRole(Role.ADMIN),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.orgId! } })
    if (!org.stripeCustomerId || !stripeConfigured) return res.json({ invoices: [] })

    const stripe = getStripe()
    const invoices = await stripe.invoices.list({ customer: org.stripeCustomerId, limit: 12 })

    res.json({
      invoices: invoices.data.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        total: invoice.total,
        currency: invoice.currency,
        created: new Date(invoice.created * 1000).toISOString(),
        pdf: invoice.invoice_pdf,
        hostedUrl: invoice.hosted_invoice_url,
      })),
    })
  }),
)

/** Current plan snapshot for the sidebar/upgrade prompts. */
billingRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const summary = await billingSummary(req.orgId!)
    res.json({ plan: getPlan(summary.plan.id), limits: summary.limits, usage: summary.usage })
  }),
)
