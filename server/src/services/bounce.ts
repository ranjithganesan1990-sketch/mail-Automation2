import { prisma, logActivity } from '../db.js'
import { fetchBouncedAddresses, flagAccountError, getGmailClient } from '../lib/gmail.js'

// Replacement for cleanBouncedEmails(). The Apps Script deleted rows whose
// address merely *contained* "bounce"/"noreply", which silently destroyed
// legitimate contacts. This reads the actual delivery-failure notices in the
// mailbox and marks only those contacts BOUNCED — nothing is deleted, so the
// history stays auditable.

export interface BounceResult {
  scanned: number
  markedBounced: number
  addresses: string[]
}

export async function cleanBouncedContacts(orgId: string, userId?: string | null): Promise<BounceResult> {
  const accounts = await prisma.mailAccount.findMany({ where: { orgId, status: 'ACTIVE' } })

  const allBounced = new Map<string, string>()

  for (const account of accounts) {
    try {
      const gmail = await getGmailClient(account)
      const found = await fetchBouncedAddresses(gmail, account.email)
      for (const [address, reason] of found) allBounced.set(address, reason)
    } catch (err) {
      await flagAccountError(account.id, err)
    }
  }

  if (allBounced.size === 0) {
    return { scanned: accounts.length, markedBounced: 0, addresses: [] }
  }

  const addresses = [...allBounced.keys()]

  const contacts = await prisma.contact.findMany({
    where: {
      campaign: { orgId },
      status: 'ACTIVE',
      email: { in: addresses, mode: 'insensitive' },
    },
    select: { id: true, email: true },
  })

  for (const contact of contacts) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        status: 'BOUNCED',
        bounceReason: allBounced.get(contact.email.toLowerCase()) ?? 'Delivery failed',
      },
    })
  }

  if (contacts.length > 0) {
    await logActivity({
      orgId,
      userId,
      type: 'bounce.cleanup',
      message: `Marked ${contacts.length} contact(s) as bounced`,
      meta: { addresses: contacts.map((c) => c.email).slice(0, 50) },
    })
  }

  return {
    scanned: accounts.length,
    markedBounced: contacts.length,
    addresses: contacts.map((c) => c.email),
  }
}

/** Manual unsubscribe/suppression toggle used by the contacts table. */
export async function setContactStatus(orgId: string, contactId: string, status: 'ACTIVE' | 'UNSUBSCRIBED' | 'BOUNCED') {
  const contact = await prisma.contact.findFirst({ where: { id: contactId, campaign: { orgId } } })
  if (!contact) return null
  return prisma.contact.update({
    where: { id: contactId },
    data: { status, bounceReason: status === 'ACTIVE' ? null : contact.bounceReason },
  })
}
