import 'dotenv/config'
import crypto from 'node:crypto'

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy server/.env.example to server/.env and fill it in.`,
    )
  }
  return value
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

const isProd = process.env.NODE_ENV === 'production'

// A stable dev-only fallback so the app boots before secrets are configured.
// In production both secrets are mandatory.
const devSecret = crypto.createHash('sha256').update('mail-automation-dev-secret').digest('hex')

// Render publishes the service's public https URL here. Used as the default
// for APP_URL/API_URL so a deploy needs no hand-copied hostname.
const renderUrl = (process.env.RENDER_EXTERNAL_URL ?? '').replace(/\/+$/, '')

export const env = {
  isProd,
  port: int('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),

  jwtSecret: isProd ? required('JWT_SECRET') : optional('JWT_SECRET', devSecret),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '7d'),

  // 32-byte key (hex or utf8) used for AES-256-GCM encryption of OAuth tokens.
  encryptionKey: isProd ? required('ENCRYPTION_KEY') : optional('ENCRYPTION_KEY', devSecret),

  // On a single-service host (Render, Fly, Railway) the dashboard and the API
  // share one origin, so the platform's own external URL is the right default
  // for both. RENDER_EXTERNAL_URL is injected by Render automatically.
  appUrl: optional('APP_URL', renderUrl || 'http://localhost:5173'),
  apiUrl: optional('API_URL', renderUrl || 'http://localhost:4000'),

  // Fallback only. The live values are resolved by lib/appconfig.ts, which
  // prefers what an instance admin saved under Settings → Google OAuth.
  google: {
    clientId: optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
    redirectUri: optional(
      'GOOGLE_REDIRECT_URI',
      `${renderUrl || 'http://localhost:4000'}/api/mail-accounts/oauth/callback`,
    ),
  },

  stripe: {
    secretKey: optional('STRIPE_SECRET_KEY'),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET'),
  },

  uploadDir: optional('UPLOAD_DIR', 'uploads'),
  maxUploadBytes: int('MAX_UPLOAD_BYTES', 15 * 1024 * 1024),

  // Worker tuning — the SaaS equivalent of MAX_EXECUTION_TIME_MS chunking.
  worker: {
    tickMs: int('WORKER_TICK_MS', 5000),
    chunkBudgetMs: int('WORKER_CHUNK_BUDGET_MS', 25_000),
    perMessageDelayMs: int('WORKER_MESSAGE_DELAY_MS', 60),
  },
}

// NOTE: there is deliberately no `googleConfigured` constant here any more.
// Credentials are now editable at runtime, so a value captured at boot would
// go stale the moment an admin saved a change. Use
// `isGoogleConfigured()` from lib/appconfig.ts instead.
