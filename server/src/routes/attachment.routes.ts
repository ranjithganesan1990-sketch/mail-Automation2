import { Router } from 'express'
import multer from 'multer'
import crypto from 'node:crypto'
import path from 'node:path'
import { prisma, logActivity } from '../db.js'
import { env } from '../env.js'
import { asyncHandler, badRequest, notFound } from '../lib/errors.js'
import { requireAuth, requireOrg } from '../middleware/auth.js'
import { deleteAttachment, ensureUploadDir, resolveStoragePath } from '../lib/storage.js'

export const attachmentRouter = Router()
attachmentRouter.use(requireAuth, requireOrg)

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadDir()
      .then((dir) => cb(null, dir))
      .catch((err) => cb(err, ''))
  },
  filename: (_req, file, cb) => {
    // Never trust the client filename on disk — keep the original only in the DB.
    const ext = path.extname(file.originalname).slice(0, 12)
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: env.maxUploadBytes, files: 1 },
})

attachmentRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const attachments = await prisma.attachment.findMany({
      where: { orgId: req.orgId! },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        size: true,
        createdAt: true,
        _count: { select: { campaigns: true, steps: true } },
      },
    })
    res.json({ attachments })
  }),
)

attachmentRouter.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file was uploaded.')

    // Multer writes UTF-8 filenames as latin1; restore the real name.
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8')

    const attachment = await prisma.attachment.create({
      data: {
        orgId: req.orgId!,
        filename: originalName.slice(0, 200),
        mimeType: req.file.mimetype || 'application/octet-stream',
        size: req.file.size,
        storageKey: req.file.filename,
      },
    })

    await logActivity({
      orgId: req.orgId!,
      userId: req.user!.id,
      type: 'attachment.uploaded',
      message: `${req.user!.name} uploaded "${attachment.filename}"`,
      meta: { attachmentId: attachment.id, size: attachment.size },
    })

    res.status(201).json({ attachment })
  }),
)

attachmentRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const attachment = await prisma.attachment.findFirst({ where: { id: req.params.id, orgId: req.orgId! } })
    if (!attachment) throw notFound('Attachment not found')

    res.download(resolveStoragePath(attachment.storageKey), attachment.filename)
  }),
)

attachmentRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const attachment = await prisma.attachment.findFirst({
      where: { id: req.params.id, orgId: req.orgId! },
      include: { _count: { select: { campaigns: true, steps: true } } },
    })
    if (!attachment) throw notFound('Attachment not found')

    const inUse = attachment._count.campaigns + attachment._count.steps
    if (inUse > 0) {
      throw badRequest(`"${attachment.filename}" is attached to ${inUse} campaign step(s). Detach it first.`)
    }

    await prisma.attachment.delete({ where: { id: attachment.id } })
    await deleteAttachment(attachment.storageKey)

    res.json({ ok: true })
  }),
)
