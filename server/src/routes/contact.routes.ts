import { Router } from 'express'
import { z } from 'zod'
import Papa from 'papaparse'
import { prisma, logActivity } from '../db.js'
import { asyncHandler, badRequest, notFound } from '../lib/errors.js'
import { findEmailKey, isValidEmail } from '../lib/merge.js'
import { requireAuth, requireOrg } from '../middleware/auth.js'
import { assertWithinLimit } from '../middleware/plan.js'
import { cleanBouncedContacts, setContactStatus } from '../services/bounce.js'

export const contactRouter = Router()
contactRouter.use(requireAuth, requireOrg)

contactRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const campaignId = req.query.campaignId as string | undefined
    const status = req.query.status as string | undefined
    const search = (req.query.search as string | undefined)?.trim()
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)))

    const where = {
      campaign: { orgId: req.orgId! },
      ...(campaignId ? { campaignId } : {}),
      ...(status && status !== 'ALL' ? { status: status as never } : {}),
      ...(search ? { email: { contains: search, mode: 'insensitive' as const } } : {}),
    }

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { campaign: { select: { id: true, name: true } } },
      }),
      prisma.contact.count({ where }),
    ])

    // Union of every field key present, so the table can render dynamic columns.
    const columns = new Set<string>()
    for (const contact of contacts) {
      for (const key of Object.keys((contact.fields ?? {}) as Record<string, unknown>)) columns.add(key)
    }

    res.json({
      contacts,
      columns: [...columns],
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    })
  }),
)

const contactSchema = z.object({
  campaignId: z.string(),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  fields: z.record(z.unknown()).optional(),
})

contactRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = contactSchema.parse(req.body)

    const campaign = await prisma.campaign.findFirst({ where: { id: body.campaignId, orgId: req.orgId! } })
    if (!campaign) throw notFound('Campaign not found')

    await assertContactQuota(req.orgId!, 1)

    const contact = await prisma.contact.create({
      data: { campaignId: campaign.id, email: body.email, fields: (body.fields ?? {}) as object },
    })

    res.status(201).json({ contact })
  }),
)

const importSchema = z.object({
  campaignId: z.string(),
  rows: z.array(z.record(z.unknown())).min(1, 'No rows to import').max(20_000),
  emailKey: z.string().optional(),
  updateExisting: z.boolean().optional(),
})

/**
 * Bulk import — the replacement for pasting rows into a Main sheet. Column
 * headers become merge variables verbatim, so {{Company Name}} keeps working.
 */
contactRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const body = importSchema.parse(req.body)

    const campaign = await prisma.campaign.findFirst({ where: { id: body.campaignId, orgId: req.orgId! } })
    if (!campaign) throw notFound('Campaign not found')

    const headers = Object.keys(body.rows[0] ?? {})
    const emailKey = body.emailKey ?? findEmailKey(headers)
    if (!emailKey) {
      throw badRequest('Could not find an email column. Make sure one column is named "Email".')
    }

    const seen = new Set<string>()
    const valid: { email: string; fields: Record<string, unknown> }[] = []
    const invalid: { row: number; email: string; reason: string }[] = []

    body.rows.forEach((row, index) => {
      const rawEmail = String(row[emailKey] ?? '').trim().toLowerCase()

      if (!rawEmail) {
        invalid.push({ row: index + 1, email: '', reason: 'Missing email' })
        return
      }
      if (!isValidEmail(rawEmail)) {
        invalid.push({ row: index + 1, email: rawEmail, reason: 'Invalid email format' })
        return
      }
      if (seen.has(rawEmail)) {
        invalid.push({ row: index + 1, email: rawEmail, reason: 'Duplicate within file' })
        return
      }

      seen.add(rawEmail)

      const fields: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) {
        if (key === emailKey) continue
        if (key.trim() === '') continue
        fields[key.trim()] = value ?? ''
      }

      valid.push({ email: rawEmail, fields })
    })

    if (valid.length === 0) {
      throw badRequest('No valid rows found in the file.', { invalid: invalid.slice(0, 20) })
    }

    await assertContactQuota(req.orgId!, valid.length)

    const existing = await prisma.contact.findMany({
      where: { campaignId: campaign.id, email: { in: valid.map((v) => v.email) } },
      select: { id: true, email: true },
    })
    const existingByEmail = new Map(existing.map((c) => [c.email, c.id]))

    const toCreate = valid.filter((v) => !existingByEmail.has(v.email))
    const toUpdate = body.updateExisting ? valid.filter((v) => existingByEmail.has(v.email)) : []

    if (toCreate.length > 0) {
      await prisma.contact.createMany({
        data: toCreate.map((v) => ({ campaignId: campaign.id, email: v.email, fields: v.fields as object })),
        skipDuplicates: true,
      })
    }

    for (const row of toUpdate) {
      await prisma.contact.update({
        where: { id: existingByEmail.get(row.email)! },
        data: { fields: row.fields as object },
      })
    }

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'contacts.imported',
      message: `${req.user!.name} imported ${toCreate.length} contact(s) into "${campaign.name}"`,
      meta: { campaignId: campaign.id, created: toCreate.length, updated: toUpdate.length, rejected: invalid.length },
    })

    res.status(201).json({
      created: toCreate.length,
      updated: toUpdate.length,
      skipped: valid.length - toCreate.length - toUpdate.length,
      rejected: invalid.length,
      invalid: invalid.slice(0, 50),
      columns: headers.filter((h) => h !== emailKey),
    })
  }),
)

contactRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        email: z.string().trim().toLowerCase().email().optional(),
        fields: z.record(z.unknown()).optional(),
        status: z.enum(['ACTIVE', 'BOUNCED', 'UNSUBSCRIBED', 'COMPLETED']).optional(),
      })
      .parse(req.body)

    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, campaign: { orgId: req.orgId! } },
    })
    if (!contact) throw notFound('Contact not found')

    const updated = await prisma.contact.update({
      where: { id: contact.id },
      data: {
        ...(body.email ? { email: body.email } : {}),
        ...(body.fields ? { fields: body.fields as object } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    })

    res.json({ contact: updated })
  }),
)

contactRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, campaign: { orgId: req.orgId! } },
    })
    if (!contact) throw notFound('Contact not found')

    await prisma.contact.delete({ where: { id: contact.id } })
    res.json({ ok: true })
  }),
)

contactRouter.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        ids: z.array(z.string()).min(1).max(5000),
        action: z.enum(['delete', 'activate', 'unsubscribe', 'bounce']),
      })
      .parse(req.body)

    // Scope the ids to this workspace before acting on any of them.
    const owned = await prisma.contact.findMany({
      where: { id: { in: body.ids }, campaign: { orgId: req.orgId! } },
      select: { id: true },
    })
    const ids = owned.map((c) => c.id)
    if (ids.length === 0) throw badRequest('No matching contacts found.')

    if (body.action === 'delete') {
      await prisma.contact.deleteMany({ where: { id: { in: ids } } })
    } else {
      const status = body.action === 'activate' ? 'ACTIVE' : body.action === 'unsubscribe' ? 'UNSUBSCRIBED' : 'BOUNCED'
      await prisma.contact.updateMany({ where: { id: { in: ids } }, data: { status } })
    }

    res.json({ ok: true, affected: ids.length })
  }),
)

contactRouter.post(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(['ACTIVE', 'UNSUBSCRIBED', 'BOUNCED']) }).parse(req.body)
    const contact = await setContactStatus(req.orgId!, req.params.id, body.status)
    if (!contact) throw notFound('Contact not found')
    res.json({ contact })
  }),
)

/** Reads real bounce notices from Gmail and suppresses those addresses. */
contactRouter.post(
  '/clean-bounces',
  asyncHandler(async (req, res) => {
    const result = await cleanBouncedContacts(req.orgId!, req.user!.id)
    res.json(result)
  }),
)

contactRouter.get(
  '/export',
  asyncHandler(async (req, res) => {
    const campaignId = req.query.campaignId as string | undefined

    const contacts = await prisma.contact.findMany({
      where: { campaign: { orgId: req.orgId! }, ...(campaignId ? { campaignId } : {}) },
      orderBy: { createdAt: 'asc' },
      include: { campaign: { select: { name: true } } },
    })

    const columns = new Set<string>()
    for (const contact of contacts) {
      for (const key of Object.keys((contact.fields ?? {}) as Record<string, unknown>)) columns.add(key)
    }

    const rows = contacts.map((contact) => ({
      Email: contact.email,
      Campaign: contact.campaign.name,
      Status: contact.status,
      ThreadId: contact.threadId ?? '',
      LastStatus: contact.lastStatus ?? '',
      ...Object.fromEntries(
        [...columns].map((key) => [key, String(((contact.fields ?? {}) as Record<string, unknown>)[key] ?? '')]),
      ),
    }))

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"')
    res.send(Papa.unparse(rows))
  }),
)

/** Guards the workspace's contact ceiling before an insert. */
async function assertContactQuota(orgId: string, incoming: number) {
  await assertWithinLimit(orgId, 'contacts', incoming)
}
