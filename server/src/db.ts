import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
})

export async function logActivity(params: {
  orgId: string
  userId?: string | null
  type: string
  message: string
  meta?: Record<string, unknown>
}) {
  try {
    await prisma.activityLog.create({
      data: {
        orgId: params.orgId,
        userId: params.userId ?? null,
        type: params.type,
        message: params.message,
        meta: (params.meta ?? {}) as object,
      },
    })
  } catch (err) {
    // Activity logging must never break the request it is describing.
    console.error('[activity] failed to write log:', err)
  }
}
