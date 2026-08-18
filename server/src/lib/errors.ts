import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'

export class AppError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, 'bad_request', details)
export const unauthorized = (msg = 'Not authenticated') => new AppError(401, msg, 'unauthorized')
export const forbidden = (msg = 'You do not have access to this resource') => new AppError(403, msg, 'forbidden')
export const notFound = (msg = 'Not found') => new AppError(404, msg, 'not_found')
export const conflict = (msg: string) => new AppError(409, msg, 'conflict')

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown

/** Wraps an async route so rejected promises reach the error middleware. */
export function asyncHandler(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'validation_error',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    })
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details })
  }

  const anyErr = err as { code?: string; meta?: { target?: string[] } }

  // Prisma unique-constraint violation
  if (anyErr?.code === 'P2002') {
    const target = anyErr.meta?.target?.join(', ') ?? 'field'
    return res.status(409).json({ error: `A record with this ${target} already exists.`, code: 'conflict' })
  }
  if (anyErr?.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found.', code: 'not_found' })
  }

  console.error('[error]', err)
  return res.status(500).json({ error: 'Internal server error', code: 'internal_error' })
}
