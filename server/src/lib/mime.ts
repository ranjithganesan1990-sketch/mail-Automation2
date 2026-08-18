import crypto from 'node:crypto'
import { htmlToText } from './merge.js'

// Gmail's API takes a fully-formed RFC 5322 message. The Apps Script version
// hand-rolled a few headers; here we build a proper multipart message so
// attachments, UTF-8 subjects and plain-text fallbacks all work.

export interface MimeAttachment {
  filename: string
  mimeType: string
  content: Buffer
}

export interface MimeMessage {
  to: string
  from?: string
  subject: string
  html: string
  text?: string
  inReplyTo?: string | null
  references?: string | null
  cc?: string
  bcc?: string
  attachments?: MimeAttachment[]
}

/** RFC 2047 encoded-word — required for non-ASCII subjects. */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function boundary(): string {
  return `----=_Part_${crypto.randomBytes(12).toString('hex')}`
}

function foldBase64(input: string): string {
  return input.replace(/(.{76})/g, '$1\r\n')
}

function encodeFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(filename)) return `"${filename.replace(/"/g, '')}"`
  return `"${encodeHeaderValue(filename)}"`
}

export function buildMimeMessage(message: MimeMessage): string {
  const text = message.text ?? htmlToText(message.html)
  const altBoundary = boundary()
  const mixedBoundary = boundary()
  const hasAttachments = Boolean(message.attachments?.length)

  const headers: string[] = ['MIME-Version: 1.0']
  if (message.from) headers.push(`From: ${encodeHeaderValue(message.from)}`)
  headers.push(`To: ${message.to}`)
  if (message.cc) headers.push(`Cc: ${message.cc}`)
  if (message.bcc) headers.push(`Bcc: ${message.bcc}`)
  headers.push(`Subject: ${encodeHeaderValue(message.subject)}`)

  // These two headers are what actually make Gmail treat the draft as a reply.
  if (message.inReplyTo) headers.push(`In-Reply-To: ${message.inReplyTo}`)
  if (message.references) headers.push(`References: ${message.references}`)

  const alternative = [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(text, 'utf8').toString('base64')),
    '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(Buffer.from(message.html, 'utf8').toString('base64')),
    '',
    `--${altBoundary}--`,
  ].join('\r\n')

  if (!hasAttachments) {
    return [...headers, alternative].join('\r\n')
  }

  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    `--${mixedBoundary}`,
    alternative,
    '',
  ]

  for (const attachment of message.attachments ?? []) {
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.mimeType}; name=${encodeFilename(attachment.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename=${encodeFilename(attachment.filename)}`,
      '',
      foldBase64(attachment.content.toString('base64')),
      '',
    )
  }

  parts.push(`--${mixedBoundary}--`)
  return parts.join('\r\n')
}

/** Gmail expects base64url with no padding. */
export function toRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url')
}
