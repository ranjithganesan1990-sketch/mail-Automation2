import { prisma } from '../db.js'
import { getGmailClient } from '../lib/gmail.js'
import { buildMimeMessage, toRaw } from '../lib/mime.js'

// Port of sendCampaignCompletionEmail() — same executive digest, now driven
// from real run records instead of in-memory counters.

export interface DigestStats {
  date: string
  totalProcessed: number
  newCount: number
  fu1Count: number
  fu2Count: number
  fu3Count: number
  failedCount: number
  skippedCount: number
  bouncedCount: number
  errors: string[]
  paused: boolean
}

export async function collectDigestStats(orgId: string, forDate: Date): Promise<DigestStats> {
  const start = new Date(forDate)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)

  const runs = await prisma.run.findMany({
    where: { orgId, startedAt: { gte: start, lt: end } },
    include: { campaign: { select: { name: true } } },
  })

  const stats: DigestStats = {
    date: start.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' }),
    totalProcessed: 0,
    newCount: 0,
    fu1Count: 0,
    fu2Count: 0,
    fu3Count: 0,
    failedCount: 0,
    skippedCount: 0,
    bouncedCount: 0,
    errors: [],
    paused: false,
  }

  for (const run of runs) {
    stats.totalProcessed += run.succeeded
    stats.failedCount += run.failed
    stats.skippedCount += run.skipped
    if (run.kind === 'NEW') stats.newCount += run.succeeded
    if (run.kind === 'FOLLOWUP_1') stats.fu1Count += run.succeeded
    if (run.kind === 'FOLLOWUP_2') stats.fu2Count += run.succeeded
    if (run.kind === 'FOLLOWUP_3') stats.fu3Count += run.succeeded
    if (run.status === 'PAUSED') stats.paused = true
    if (run.error) stats.errors.push(`${run.campaign.name}: ${run.error}`)
  }

  stats.bouncedCount = await prisma.contact.count({
    where: { campaign: { orgId }, status: 'BOUNCED', updatedAt: { gte: start, lt: end } },
  })

  const failedSteps = await prisma.campaignStep.findMany({
    where: { campaign: { orgId }, status: { in: ['NO_TEMPLATE', 'FAILED'] }, updatedAt: { gte: start, lt: end } },
    include: { campaign: { select: { name: true } } },
  })
  for (const step of failedSteps) {
    stats.errors.push(`${step.campaign.name} — ${step.kind}: ${step.notes ?? step.status}`)
  }

  return stats
}

export function renderDigestHtml(orgName: string, stats: DigestStats): string {
  const errorBlock =
    stats.errors.length > 0
      ? `<div style="background-color:#FFEBEE;border-left:4px solid #E53935;padding:15px;margin-top:20px;border-radius:4px;">
           <h3 style="color:#C62828;margin-top:0;font-size:16px;">⚠️ Attention Required (${stats.errors.length})</h3>
           <ul style="color:#B71C1C;margin:0;padding-left:20px;font-size:13px;">
             ${stats.errors.slice(0, 20).map((e) => `<li style="margin-bottom:5px;">${escape(e)}</li>`).join('')}
           </ul>
         </div>`
      : `<div style="background-color:#E8F5E9;border-left:4px solid #43A047;padding:15px;margin-top:20px;border-radius:4px;">
           <h3 style="color:#2E7D32;margin:0;font-size:16px;">✅ All Systems Operational</h3>
           <p style="color:#388E3C;margin:5px 0 0 0;font-size:14px;">No errors encountered during today's processing.</p>
         </div>`

  const pauseNote = stats.paused
    ? `<p style="color:#FB8C00;font-weight:bold;text-align:center;margin-bottom:20px;">⏸️ A run was paused to respect sending limits. It resumes automatically.</p>`
    : ''

  const row = (label: string, value: number, shaded: boolean) => `
    <tr style="background-color:${shaded ? '#FAFAFA' : '#FFFFFF'};">
      <td style="padding:10px;border-bottom:1px solid #E0E0E0;font-weight:600;">${label}</td>
      <td style="padding:10px;border-bottom:1px solid #E0E0E0;text-align:right;font-weight:bold;">${value}</td>
    </tr>`

  return `
  <div style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#333333;">
    <div style="background-color:#1E88E5;padding:25px;border-radius:8px 8px 0 0;text-align:center;">
      <h1 style="color:#FFFFFF;margin:0;font-size:24px;font-weight:600;">📧 Campaign Automation Digest</h1>
      <p style="color:#E3F2FD;margin:10px 0 0 0;font-size:14px;">${escape(orgName)} • ${stats.date}</p>
    </div>
    <div style="background-color:#FFFFFF;padding:30px;border:1px solid #E0E0E0;border-top:none;border-radius:0 0 8px 8px;">
      ${pauseNote}
      <h2 style="color:#1E88E5;margin-top:0;font-size:18px;border-bottom:2px solid #E3F2FD;padding-bottom:10px;">Daily Execution Summary</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:25px;">
        <tr>
          <td style="padding:12px;background-color:#F5F5F5;border-radius:4px;width:50%;">
            <div style="font-size:12px;color:#757575;text-transform:uppercase;letter-spacing:1px;">Emails Processed</div>
            <div style="font-size:28px;font-weight:bold;color:#1E88E5;margin-top:5px;">${stats.totalProcessed}</div>
          </td>
          <td style="padding:12px;background-color:#F5F5F5;border-radius:4px;width:50%;">
            <div style="font-size:12px;color:#757575;text-transform:uppercase;letter-spacing:1px;">Bounced Cleaned</div>
            <div style="font-size:28px;font-weight:bold;color:#FB8C00;margin-top:5px;">${stats.bouncedCount}</div>
          </td>
        </tr>
      </table>
      <table style="width:100%;border-collapse:collapse;margin-bottom:25px;font-size:14px;">
        ${row('🆕 Initial emails', stats.newCount, true)}
        ${row('🔄 Follow-up 1', stats.fu1Count, false)}
        ${row('🔄 Follow-up 2', stats.fu2Count, true)}
        ${row('🔄 Follow-up 3', stats.fu3Count, false)}
        ${row('⚠️ Failed', stats.failedCount, true)}
        ${row('⏭️ Skipped (no thread)', stats.skippedCount, false)}
      </table>
      ${errorBlock}
      <div style="margin-top:30px;padding-top:20px;border-top:1px solid #E0E0E0;text-align:center;">
        <p style="color:#9E9E9E;font-size:12px;margin:0;">Automated message from your Mail Automation workspace.</p>
      </div>
    </div>
  </div>`
}

function escape(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Builds and delivers the digest through the workspace's default mailbox. */
export async function sendDailyDigest(orgId: string, forDate = new Date()): Promise<DigestStats | null> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } })
  if (!org || !org.sendDailyDigest) return null

  const stats = await collectDigestStats(orgId, forDate)

  // Nothing happened and nothing broke — stay out of the inbox.
  if (stats.totalProcessed === 0 && stats.errors.length === 0 && stats.bouncedCount === 0) return stats

  const account =
    (await prisma.mailAccount.findFirst({ where: { orgId, status: 'ACTIVE', isDefault: true } })) ??
    (await prisma.mailAccount.findFirst({ where: { orgId, status: 'ACTIVE' } }))

  if (!account) return stats

  const recipient = org.digestEmail || account.email
  const day = new Date(forDate)
  day.setHours(0, 0, 0, 0)

  const digest = await prisma.digest.upsert({
    where: { orgId_forDate: { orgId, forDate: day } },
    create: { orgId, forDate: day, stats: stats as unknown as object, sentTo: recipient },
    update: { stats: stats as unknown as object, sentTo: recipient },
  })

  try {
    const gmail = await getGmailClient(account)
    const raw = toRaw(
      buildMimeMessage({
        to: recipient,
        from: `Mail Automation <${account.email}>`,
        subject: `📊 Daily Campaign Digest — ${stats.date}`,
        html: renderDigestHtml(org.name, stats),
      }),
    )
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
    await prisma.digest.update({ where: { id: digest.id }, data: { sentAt: new Date(), error: null } })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.digest.update({ where: { id: digest.id }, data: { error: message.slice(0, 1000) } })
  }

  return stats
}
