import jwt from 'jsonwebtoken'
import { env } from '../env.js'

export interface TokenPayload {
  userId: string
  email: string
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions)
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, env.jwtSecret) as TokenPayload
  } catch {
    return null
  }
}

/** Short-lived signed state for the Google OAuth round trip. */
export function signState(payload: Record<string, unknown>): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: '10m' })
}

export function verifyState<T = Record<string, unknown>>(token: string): T | null {
  try {
    return jwt.verify(token, env.jwtSecret) as T
  } catch {
    return null
  }
}
