import express, { Router } from 'express'
import type Stripe from 'stripe'
import { prisma } from '../db.js'
import { getStripe, stripeConfigured, webhookSecret } from '../lib/stripe.js'
import { applySubscription, resolveOrgId, revertToFree } from '../services/billing.js'

// =============================================================
//  STRIPE WEBHOOK
//  Mounted BEFORE express.json() so the raw body survives for
//  signature verification. This endpoint is public by design —
//  the Stripe signature is the authentication.
// =============================================================

export const webhookRouter = Router()

webhookRouter.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeConfigured || !webhookSecret) {
    return res.status(503).json({ error: 'Billing is not configured.' })
  }

  const signature = req.headers['stripe-signature']
  if (!signature || typeof signature !== 'string') {
    return res.status(400).json({ error: 'Missing stripe-signature header.' })
  }

  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(req.body as Buffer, signature, webhookSecret)
  } catch (err) {
    // An unverifiable payload is either misconfiguration or a forgery.
    console.error('[stripe] signature verification failed:', (err as Error).message)
    return res.status(400).json({ error: 'Invalid signature.' })
  }

  // Stripe retries on any non-2xx, so replays must be harmless.
  const alreadyProcessed = await prisma.billingEvent.findUnique({ where: { stripeEventId: event.id } })
  if (alreadyProcessed) return res.json({ received: true, duplicate: true })

  let orgId: string | null = null

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        orgId = await resolveOrgId({
          orgId: session.client_reference_id ?? session.metadata?.orgId,
          customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
        })

        if (orgId && session.subscription) {
          const subscriptionId =
            typeof session.subscription === 'string' ? session.subscription : session.subscription.id
          const subscription = await getStripe().subscriptions.retrieve(subscriptionId)
          await applySubscription(orgId, subscription)
        }
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.resumed': {
        const subscription = event.data.object as Stripe.Subscription
        orgId = await resolveOrgId({
          orgId: subscription.metadata?.orgId,
          customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
        })
        if (orgId) await applySubscription(orgId, subscription)
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        orgId = await resolveOrgId({
          orgId: subscription.metadata?.orgId,
          customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
        })
        if (orgId) await revertToFree(orgId, 'subscription deleted')
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        orgId = await resolveOrgId({
          customerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id,
        })
        if (orgId) {
          // Keep access during Stripe's retry window; the subscription.updated
          // event moves the workspace off the plan if it ultimately fails.
          await prisma.organization.update({
            where: { id: orgId },
            data: { subscriptionStatus: 'past_due' },
          })
          await prisma.activityLog.create({
            data: {
              orgId,
              type: 'billing.payment_failed',
              message: 'A subscription payment failed. Update the payment method to avoid interruption.',
              meta: { invoiceId: invoice.id ?? null },
            },
          })
        }
        break
      }

      default:
        // Unhandled types are still recorded so the log shows what Stripe sent.
        break
    }

    await prisma.billingEvent.create({
      data: {
        orgId,
        stripeEventId: event.id,
        type: event.type,
        payload: { id: event.id, type: event.type } as object,
      },
    })

    res.json({ received: true })
  } catch (err) {
    // Returning 500 makes Stripe retry, which is what we want for a transient
    // database problem.
    console.error(`[stripe] failed to process ${event.type}:`, err)
    res.status(500).json({ error: 'Webhook processing failed.' })
  }
})
