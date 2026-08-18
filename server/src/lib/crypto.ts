import crypto from 'node:crypto'
import { env } from '../env.js'

// OAuth refresh tokens are long-lived credentials for a user's mailbox.
// They are encrypted at rest with AES-256-GCM so a database dump alone
// is not enough to send mail as the customer.

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const PREFIX = 'v1'

function deriveKey(): Buffer {
  const raw = env.encryptionKey
  // Accept either a 64-char hex key or any passphrase (hashed to 32 bytes).
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  return crypto.createHash('sha256').update(raw).digest()
}

const key = deriveKey()

export function encrypt(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':')
}

export function decrypt(payload: string | null | undefined): string | null {
  if (!payload) return null
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    // Value was stored before encryption was enabled — return as-is.
    return payload
  }
  try {
    const [, ivB64, tagB64, dataB64] = parts
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()])
    return dec.toString('utf8')
  } catch {
    // Wrong key or tampered ciphertext.
    return null
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}
