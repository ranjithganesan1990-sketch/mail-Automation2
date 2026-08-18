import { prisma } from '../db.js'
import { env } from '../env.js'
import { decrypt, encrypt } from './crypto.js'

// Instance-wide settings resolve DB-first, environment-second.
//
// The .env values are kept as a fallback so an existing deployment keeps
// working untouched, and so a fresh install can still be configured purely
// from a file if that is preferred (or if the dashboard is unreachable).
//
// Reads are cached briefly: getGoogleConfig() sits in the hot path of every
// campaign send, and this saves a query per message without making a
// credential change feel stale.

export type ConfigSource = 'database' | 'env' | 'none'

export interface GoogleConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  source: ConfigSource
}

const DEFAULT_REDIRECT_URI = 'http://localhost:4000/api/mail-accounts/oauth/callback'
const CACHE_TTL_MS = 30_000

let cache: { value: GoogleConfig; at: number } | null = null

/** Call after any write so the next read reflects it immediately. */
export function invalidateAppConfigCache(): void {
  cache = null
}

function fromEnv(): GoogleConfig {
  const clientId = env.google.clientId.trim()
  const clientSecret = env.google.clientSecret.trim()
  return {
    clientId,
    clientSecret,
    redirectUri: env.google.redirectUri.trim() || DEFAULT_REDIRECT_URI,
    source: clientId && clientSecret ? 'env' : 'none',
  }
}

export async function getGoogleConfig(): Promise<GoogleConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value

  let resolved = fromEnv()

  try {
    const row = await prisma.appSetting.findUnique({ where: { id: 'global' } })
    const clientId = row?.googleClientId?.trim() ?? ''
    // decrypt() returns null when the ciphertext cannot be opened with the
    // current ENCRYPTION_KEY — treat that as "not configured" rather than
    // handing Google an empty secret and getting an opaque 401 later.
    const clientSecret = (row?.googleClientSecret ? decrypt(row.googleClientSecret) : null)?.trim() ?? ''

    if (clientId && clientSecret) {
      resolved = {
        clientId,
        clientSecret,
        redirectUri: row?.googleRedirectUri?.trim() || fromEnv().redirectUri,
        source: 'database',
      }
    }
  } catch (err) {
    // A missing table (before db:push) or an unreachable database must not
    // take down mail sending that .env can still satisfy.
    console.error('[appconfig] could not read settings, falling back to .env:', (err as Error).message)
  }

  cache = { value: resolved, at: Date.now() }
  return resolved
}

export async function isGoogleConfigured(): Promise<boolean> {
  const config = await getGoogleConfig()
  return Boolean(config.clientId && config.clientSecret)
}

export interface GoogleConfigInput {
  clientId: string
  /** Omit to leave the stored secret untouched. */
  clientSecret?: string
  redirectUri?: string
}

export async function saveGoogleConfig(
  input: GoogleConfigInput,
  actor: { id: string; email: string },
): Promise<void> {
  const data = {
    googleClientId: input.clientId.trim() || null,
    googleRedirectUri: input.redirectUri?.trim() || null,
    updatedById: actor.id,
    updatedByEmail: actor.email,
    // Only overwrite the secret when a new one was actually supplied, so
    // saving the form without retyping it does not wipe the credential.
    ...(input.clientSecret !== undefined
      ? { googleClientSecret: encrypt(input.clientSecret.trim()) }
      : {}),
  }

  await prisma.appSetting.upsert({
    where: { id: 'global' },
    create: { id: 'global', ...data },
    update: data,
  })

  invalidateAppConfigCache()
}

export async function clearGoogleConfig(actor: { id: string; email: string }): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: 'global' },
    create: { id: 'global', updatedById: actor.id, updatedByEmail: actor.email },
    update: {
      googleClientId: null,
      googleClientSecret: null,
      googleRedirectUri: null,
      updatedById: actor.id,
      updatedByEmail: actor.email,
    },
  })

  invalidateAppConfigCache()
}

/** True when a stored secret exists, without revealing it. */
export async function hasStoredGoogleSecret(): Promise<boolean> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { id: 'global' } })
    return Boolean(row?.googleClientSecret)
  } catch {
    return false
  }
}
