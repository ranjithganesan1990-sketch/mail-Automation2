import fs from 'node:fs/promises'
import path from 'node:path'
import { env } from '../env.js'

const root = path.resolve(process.cwd(), env.uploadDir)

export async function ensureUploadDir(): Promise<string> {
  await fs.mkdir(root, { recursive: true })
  return root
}

export function resolveStoragePath(storageKey: string): string {
  // Keys are generated server-side, but normalize defensively so a crafted
  // key can never escape the upload directory.
  const safe = path.normalize(storageKey).replace(/^(\.\.[/\\])+/, '')
  const full = path.resolve(root, safe)
  if (!full.startsWith(root)) {
    throw new Error('Invalid storage key')
  }
  return full
}

export async function readAttachment(storageKey: string): Promise<Buffer> {
  return fs.readFile(resolveStoragePath(storageKey))
}

export async function deleteAttachment(storageKey: string): Promise<void> {
  try {
    await fs.unlink(resolveStoragePath(storageKey))
  } catch {
    // Already gone — nothing to clean up.
  }
}
