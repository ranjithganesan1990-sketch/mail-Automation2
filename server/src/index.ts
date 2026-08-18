import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'
import { prisma } from './db.js'
import { errorMiddleware } from './lib/errors.js'
import { ensureUploadDir } from './lib/storage.js'
import { authRouter } from './routes/auth.routes.js'
import { orgRouter } from './routes/org.routes.js'
import { settingsRouter } from './routes/settings.routes.js'
import { mailAccountRouter } from './routes/mailaccount.routes.js'
import { templateRouter } from './routes/template.routes.js'
import { campaignRouter } from './routes/campaign.routes.js'
import { contactRouter } from './routes/contact.routes.js'
import { attachmentRouter } from './routes/attachment.routes.js'
import { runRouter } from './routes/run.routes.js'
import { dashboardRouter } from './routes/dashboard.routes.js'
import { billingRouter } from './routes/billing.routes.js'
import { webhookRouter } from './routes/webhook.routes.js'
import { recoverInterruptedRuns, startScheduler } from './services/scheduler.js'

const app = express()

app.set('trust proxy', 1)
app.use(
  cors({
    origin: env.appUrl,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id'],
  }),
)
// Must precede express.json(): Stripe signature verification needs the raw body.
app.use('/api/webhooks', webhookRouter)

app.use(express.json({ limit: '25mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ ok: true, database: 'connected', time: new Date().toISOString() })
  } catch (err) {
    res.status(503).json({ ok: false, database: 'unreachable', error: (err as Error).message })
  }
})

app.use('/api/auth', authRouter)
app.use('/api/orgs', orgRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/mail-accounts', mailAccountRouter)
app.use('/api/templates', templateRouter)
app.use('/api/campaigns', campaignRouter)
app.use('/api/contacts', contactRouter)
app.use('/api/attachments', attachmentRouter)
app.use('/api/runs', runRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/billing', billingRouter)

app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found', code: 'not_found' }))

// ------------------------- STATIC DASHBOARD -------------------------
// In a single-service deploy (Render, Fly, a VPS) the API also serves the
// built React app, so the browser talks to one origin and the relative
// `/api/...` calls in web/src/lib/api.ts work with no CORS at all.
// In local dev the Vite server owns :5173 and web/dist may not exist —
// this block is simply skipped then.
const webDist = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist')

if (fs.existsSync(path.join(webDist, 'index.html'))) {
  // Hashed asset filenames are safe to cache hard; index.html must not be.
  app.use(express.static(webDist, { index: false, maxAge: '1y' }))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'), { maxAge: 0 })
  })
  console.log(`[web] serving dashboard from ${webDist}`)
} else {
  console.log('[web] no web/dist build found — API only (run `npm run build` to bundle the dashboard)')
}

app.use(errorMiddleware)

async function main() {
  await ensureUploadDir()

  try {
    await prisma.$connect()
    console.log('[db] connected')
    await recoverInterruptedRuns()
    startScheduler()
  } catch (err) {
    // The API still boots so /api/health can report the problem clearly.
    console.error('[db] connection failed — automation is disabled until the database is reachable.')
    console.error((err as Error).message)
  }

  const server = app.listen(env.port, () => {
    console.log(`\n  Mail Automation API`)
    console.log(`  → http://localhost:${env.port}/api/health`)
    console.log(`  → dashboard origin: ${env.appUrl}\n`)
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[server] Port ${env.port} is already in use.`)
      console.error('         Stop the other process, or set PORT in server/.env to a free port.\n')
      process.exit(1)
    }
    throw err
  })
}

void main()

async function shutdown(signal: string) {
  console.log(`\n[server] ${signal} received, shutting down`)
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
