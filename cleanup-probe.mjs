// One-off cleanup: removes the `probe-diag` workspace and its user, which were
// created while diagnosing a registration failure on 2026-08-18. That workspace
// is the oldest on the Render instance, so requireInstanceAdmin() treats it as
// the instance root and every other account gets a 403 on Settings -> Google
// OAuth. Deleting it hands instance-admin back to the oldest remaining
// workspace. Safe to delete this file afterwards.
//
//   $env:DATABASE_URL = "<External Database URL from Render>?sslmode=require"
//   node cleanup-probe.mjs

import { PrismaClient } from '@prisma/client'

const PROBE_SLUG = 'probe-diag'
const PROBE_EMAIL = 'probe-diag-9f3a@example.com'

// NOTE: importing @prisma/client above loads server/.env via dotenv, so
// DATABASE_URL is never empty here -- it falls back to the local dev database.
// dotenv does not overwrite a value already in the environment, so an
// explicitly exported DATABASE_URL still wins. The localhost guard below is
// what actually stops this from running against the wrong database.
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Set it to the Render EXTERNAL database URL first.')
  process.exit(1)
}

const host = new URL(url).host
if (/localhost|127\.0\.0\.1/.test(host) && process.env.ALLOW_LOCAL !== 'yes') {
  console.error(`Refusing to run against a local database (${host}).`)
  console.error('This script is meant for the Render database. Set ALLOW_LOCAL=yes to override.')
  process.exit(1)
}

console.log(`Target database host: ${host}`)
console.log('')

const prisma = new PrismaClient()

try {
  const before = await prisma.organization.findMany({
    orderBy: { createdAt: 'asc' },
    select: { name: true, slug: true, createdAt: true },
  })
  console.log('Workspaces, oldest first (the first one holds instance-admin):')
  for (const o of before) {
    console.log(`  ${o.createdAt.toISOString()}  ${o.slug.padEnd(20)} ${o.name}`)
  }
  console.log('')

  // Organization has onDelete: Cascade from memberships, templates, campaigns
  // and activity logs, so one delete takes the whole workspace with it.
  const org = await prisma.organization.deleteMany({ where: { slug: PROBE_SLUG } })
  console.log(`Deleted ${org.count} workspace(s) with slug "${PROBE_SLUG}"`)

  const user = await prisma.user.deleteMany({ where: { email: PROBE_EMAIL } })
  console.log(`Deleted ${user.count} user(s) with email "${PROBE_EMAIL}"`)
  console.log('')

  const after = await prisma.organization.findFirst({
    orderBy: { createdAt: 'asc' },
    include: { members: { include: { user: { select: { email: true } } } } },
  })
  if (!after) {
    console.log('No workspaces left -- the next account registered becomes the instance admin.')
  } else {
    console.log(`Instance admin is now anyone in "${after.name}":`)
    for (const m of after.members) {
      console.log(`  ${m.user.email}  (${m.role})`)
    }
  }
} catch (err) {
  // Prisma dumps its whole bundled runtime into the stack on a connection
  // failure, which buries the one line that matters.
  const first = String(err && err.message ? err.message : err).split(/\r?\n/).find((l) => l.trim())
  console.error('')
  console.error(`Failed: ${first}`)
  if (err && err.name === 'PrismaClientInitializationError') {
    console.error('')
    console.error('Could not reach the database. Check that you used the EXTERNAL Database')
    console.error('URL from Render (not the Internal one) and kept ?sslmode=require on the end.')
  }
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
