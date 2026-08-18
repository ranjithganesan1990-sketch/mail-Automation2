import { Router } from 'express'
import { z } from 'zod'
import { prisma, logActivity } from '../db.js'
import { asyncHandler, badRequest, notFound } from '../lib/errors.js'
import { extractVariables, formatHtml, merge } from '../lib/merge.js'
import { requireAuth, requireOrg } from '../middleware/auth.js'
import { renderPreview } from '../services/runner.js'

export const templateRouter = Router()
templateRouter.use(requireAuth, requireOrg)

templateRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const includeArchived = req.query.archived === 'true'
    const search = (req.query.search as string | undefined)?.trim()

    const templates = await prisma.template.findMany({
      where: {
        orgId: req.orgId!,
        ...(includeArchived ? {} : { isArchived: false }),
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        subject: true,
        version: true,
        isArchived: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { steps: true, versions: true } },
      },
    })

    res.json({ templates })
  }),
)

templateRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const template = await prisma.template.findFirst({
      where: { id: req.params.id, orgId: req.orgId! },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 20 },
        steps: { include: { campaign: { select: { id: true, name: true } } } },
      },
    })
    if (!template) throw notFound('Template not found')

    res.json({
      template,
      variables: extractVariables(template.subject, template.html),
      usedBy: template.steps.map((s) => ({ campaignId: s.campaign.id, campaignName: s.campaign.name, kind: s.kind })),
    })
  }),
)

const upsertSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(300).nullable().optional(),
  subject: z.string().trim().min(1, 'Subject is required').max(500),
  html: z.string().min(1, 'Template body cannot be empty'),
})

templateRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = upsertSchema.parse(req.body)

    const template = await prisma.template.create({
      data: {
        orgId: req.orgId!,
        name: body.name,
        description: body.description ?? null,
        subject: body.subject,
        html: body.html,
        createdById: req.user!.id,
        versions: { create: { version: 1, subject: body.subject, html: body.html, note: 'Initial version' } },
      },
    })

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'template.created',
      message: `${req.user!.name} created template "${template.name}"`,
      meta: { templateId: template.id },
    })

    res.status(201).json({ template })
  }),
)

templateRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = upsertSchema.partial().extend({ isArchived: z.boolean().optional() }).parse(req.body)

    const existing = await prisma.template.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!existing) throw notFound('Template not found')

    // Snapshot the previous content whenever the message itself changes, so a
    // bad edit is always one click away from being restored.
    const contentChanged =
      (body.subject !== undefined && body.subject !== existing.subject) ||
      (body.html !== undefined && body.html !== existing.html)

    const template = await prisma.template.update({
      where: { id: existing.id },
      data: {
        ...body,
        ...(contentChanged
          ? {
              version: { increment: 1 },
              versions: {
                create: {
                  version: existing.version + 1,
                  subject: body.subject ?? existing.subject,
                  html: body.html ?? existing.html,
                },
              },
            }
          : {}),
      },
    })

    res.json({ template })
  }),
)

templateRouter.post(
  '/:id/duplicate',
  asyncHandler(async (req, res) => {
    const source = await prisma.template.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!source) throw notFound('Template not found')

    let name = `${source.name} (copy)`
    let n = 1
    while (await prisma.template.findFirst({ where: { orgId: req.orgId!, name } })) {
      name = `${source.name} (copy ${++n})`
    }

    const template = await prisma.template.create({
      data: {
        orgId: req.orgId!,
        name,
        description: source.description,
        subject: source.subject,
        html: source.html,
        createdById: req.user!.id,
        versions: { create: { version: 1, subject: source.subject, html: source.html, note: `Copied from ${source.name}` } },
      },
    })

    res.status(201).json({ template })
  }),
)

templateRouter.post(
  '/:id/restore/:version',
  asyncHandler(async (req, res) => {
    const template = await prisma.template.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!template) throw notFound('Template not found')

    const version = await prisma.templateVersion.findFirst({
      where: { templateId: template.id, version: Number(req.params.version) },
    })
    if (!version) throw notFound('Version not found')

    const updated = await prisma.template.update({
      where: { id: template.id },
      data: {
        subject: version.subject,
        html: version.html,
        version: { increment: 1 },
        versions: {
          create: {
            version: template.version + 1,
            subject: version.subject,
            html: version.html,
            note: `Restored from v${version.version}`,
          },
        },
      },
    })

    res.json({ template: updated })
  }),
)

templateRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const template = await prisma.template.findFirst({
      where: { id: req.params.id, orgId: req.orgId! },
      include: { _count: { select: { steps: true } } },
    })
    if (!template) throw notFound('Template not found')

    // Steps reference templates; archive rather than orphan a live campaign.
    if (template._count.steps > 0) {
      const archived = await prisma.template.update({ where: { id: template.id }, data: { isArchived: true } })
      return res.json({ template: archived, archived: true })
    }

    await prisma.template.delete({ where: { id: template.id } })
    res.json({ ok: true, archived: false })
  }),
)

// ------------------------------ PREVIEW ------------------------------

const previewSchema = z.object({
  templateId: z.string().optional(),
  subject: z.string().optional(),
  html: z.string().optional(),
  contactId: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
})

/**
 * Renders either a saved template or unsaved editor content against a real
 * contact — the successor to previewSelectedTemplate().
 */
templateRouter.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const body = previewSchema.parse(req.body)

    if (body.templateId && body.html === undefined) {
      const result = await renderPreview({
        orgId: req.orgId!,
        templateId: body.templateId,
        contactId: body.contactId,
        campaignId: body.campaignId,
      })
      return res.json(result)
    }

    if (body.html === undefined || body.subject === undefined) {
      throw badRequest('Provide either a templateId or both subject and html.')
    }

    let contact = null
    if (body.contactId) {
      contact = await prisma.contact.findFirst({
        where: { id: body.contactId, campaign: { orgId: req.orgId! } },
      })
    } else if (body.campaignId) {
      contact = await prisma.contact.findFirst({
        where: { campaignId: body.campaignId, campaign: { orgId: req.orgId! } },
        orderBy: { createdAt: 'asc' },
      })
    }

    const fields = contact ? { ...((contact.fields ?? {}) as Record<string, unknown>), Email: contact.email } : {}

    res.json({
      subject: merge(body.subject, fields, { escape: false }).trim() || 'No Subject',
      html: formatHtml(merge(body.html, fields)),
      contact: contact ? { id: contact.id, email: contact.email, fields: contact.fields } : null,
    })
  }),
)

/** Lists every merge variable available across the workspace's contacts. */
templateRouter.get(
  '/meta/variables',
  asyncHandler(async (req, res) => {
    const campaignId = req.query.campaignId as string | undefined

    const contacts = await prisma.contact.findMany({
      where: { campaign: { orgId: req.orgId! }, ...(campaignId ? { campaignId } : {}) },
      select: { fields: true },
      take: 200,
      orderBy: { createdAt: 'desc' },
    })

    const keys = new Set<string>(['Email'])
    for (const contact of contacts) {
      for (const key of Object.keys((contact.fields ?? {}) as Record<string, unknown>)) keys.add(key)
    }

    res.json({ variables: [...keys].sort() })
  }),
)
