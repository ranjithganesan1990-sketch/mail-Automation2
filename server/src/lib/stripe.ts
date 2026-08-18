import Stripe from 'stripe'
import { AppError } from './errors.js'

// Billing is optional: without STRIPE_SECRET_KEY the app runs entirely on the
// free plan and the billing routes report that it is not configured, rather
// than crashing at boot.

const secretKey = process.env.STRIPE_SECRET_KEY ?? ''

export const stripeConfigured = Boolean(secretKey)

let client: Stripe | null = null

export function getStripe(): Stripe {
  if (!secretKey) {
    throw new AppError(
      503,
      'Billing is not configured. Set STRIPE_SECRET_KEY in server/.env to enable subscriptions.',
      'stripe_not_configured',
    )
  }
  if (!client) client = new Stripe(secretKey)
  return client
}

export const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? ''
