// Rebuilds Gmail's own "trimmed thread" markup so replies look native in the
// recipient's client. Port of buildTrimmedGmailChain() from the Apps Script.

export interface QuotedMessage {
  from: string
  date: Date
  html: string
}

function stripDocumentTags(html: string): string {
  return String(html ?? '').replace(/<\/?(html|body|head|!DOCTYPE)[^>]*>/gi, '')
}

function formatQuoteDate(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function escapeAttr(value: string): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The newest message is quoted visibly; everything older is nested inside a
 * gmail_extra block so clients collapse it behind the "..." toggle.
 */
export function buildTrimmedGmailChain(messages: QuotedMessage[]): string {
  if (!messages || messages.length === 0) return ''

  const blocks = messages.map((message) => {
    const attribution = `On ${formatQuoteDate(message.date)}, ${escapeAttr(message.from)} wrote:`
    return (
      `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">` +
      `<div class="gmail_attr">${attribution}</div>` +
      stripDocumentTags(message.html) +
      `</blockquote>`
    )
  })

  const visible = blocks[blocks.length - 1]
  const older = blocks.slice(0, -1).reverse().join('')

  return older ? `${visible}<div class="gmail_extra">${older}</div>` : visible
}

/** Assembles the final reply body: new content, separator, then quoted history. */
export function composeReplyBody(newHtml: string, chain: string): string {
  if (!chain) return newHtml
  return `${newHtml}<br><br><div class="gmail_quote">${chain}</div>`
}

/** Ensures a subject carries exactly one "Re:" prefix. */
export function withRePrefix(subject: string): string {
  const clean = String(subject ?? '').trim() || 'No Subject'
  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`
}
