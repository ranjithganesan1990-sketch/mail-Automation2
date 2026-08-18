import { Router } from 'express'
import { z } from 'zod'
import { logActivity } from '../db.js'
import { env } from '../env.js'
import { asyncHandler, badRequest } from '../lib/errors.js'
import { requireAuth, requireInstanceAdmin } from '../middleware/auth.js'
import {
  clearGoogleConfig,
  getGoogleConfig,
  hasStoredGoogleSecret,
  saveGoogleConfig,
} from '../lib/appconfig.js'

// Server-wide settings. Scoped to the instance owner rather than a workspace
// role — see requireInstanceAdmin for why.
export const settingsRouter = Router()
settingsRouter.use(requireAuth, requireInstanceAdmin)

/** The redirect URI that must be registered in Google Cloud, verbatim. */
function expectedRedirectUri(): string {
  return `${env.apiUrl.replace(/\/+$/, '')}/api/mail-accounts/oauth/callback`
}

settingsRouter.get(
  '/google',
  asyncHandler(async (_req, res) => {
    const config = await getGoogleConfig()

    res.json({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      // The secret is never sent back to the browser — only whether one exists.
      secretSet: Boolean(config.clientSecret),
      secretInDatabase: await hasStoredGoogleSecret(),
      source: config.source,
      envFallbackPresent: Boolean(env.google.clientId && env.google.clientSecret),
      expectedRedirectUri: expectedRedirectUri(),
    })
  }),
)

const googleSchema = z.object({
  clientId: z.string().trim().min(1, 'Client ID is required').max(400),
  // Omitted (not empty-string) means "keep the secret already stored".
  clientSecret: z.string().trim().min(1).max(400).optional(),
  redirectUri: z.string().trim().url('Redirect URI must be a full URL').max(500).optional(),
})

settingsRouter.put(
  '/google',
  asyncHandler(async (req, res) => {
    const body = googleSchema.parse(req.body)

    // Catching a wrong paste here is far kinder than an opaque failure on
    // Google's consent screen half a flow later.
    if (!body.clientId.includes('apps.googleusercontent.com')) {
      throw badRequest(
        'That does not look like a Google OAuth client ID — they end with ".apps.googleusercontent.com". Copy the Client ID, not the project ID or the secret.',
      )
    }

    // A first-time save has nothing stored to fall back on.
    if (body.clientSecret === undefined && !(await hasStoredGoogleSecret())) {
      throw badRequest('A Client Secret is required the first time you save.')
    }

    await saveGoogleConfig(body, { id: req.user!.id, email: req.user!.email })

    await logActivity({
      orgId: req.instanceOrgId!,
      userId: req.user!.id,
      type: 'settings.google.updated',
      message: `${req.user!.name} updated the Google OAuth credentials`,
      // Deliberately no secret, and no full client ID, in the audit trail.
      meta: { clientIdSuffix: body.clientId.slice(-30), secretChanged: body.clientSecret !== undefined },
    })

    const config = await getGoogleConfig()
    res.json({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      secretSet: Boolean(config.clientSecret),
      secretInDatabase: await hasStoredGoogleSecret(),
      source: config.source,
      envFallbackPresent: Boolean(env.google.clientId && env.google.clientSecret),
      expectedRedirectUri: expectedRedirectUri(),
    })
  }),
)

settingsRouter.delete(
  '/google',
  asyncHandler(async (req, res) => {
    await clearGoogleConfig({ id: req.user!.id, email: req.user!.email })

    await logActivity({
      orgId: req.instanceOrgId!,
      userId: req.user!.id,
      type: 'settings.google.cleared',
      message: `${req.user!.name} removed the Google OAuth credentials`,
    })

    // Clearing the stored values falls back to .env, if that is populated.
    const config = await getGoogleConfig()
    res.json({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      secretSet: Boolean(config.clientSecret),
      secretInDatabase: false,
      source: config.source,
      envFallbackPresent: Boolean(env.google.clientId && env.google.clientSecret),
      expectedRedirectUri: expectedRedirectUri(),
    })
  }),
)
