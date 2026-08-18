import bcrypt from 'bcryptjs'
import { prisma } from './db.js'

// Creates a demo workspace so the dashboard has something to show before any
// mailbox is connected. Safe to re-run — it upserts.

const DEMO_EMAIL = 'demo@mailautomation.app'
const DEMO_PASSWORD = 'demo12345'

const CONTACTS = [
  { email: 'priya@northwindlogistics.com', fields: { 'Company Name': 'Northwind Logistics', 'First Name': 'Priya', City: 'Pune', Industry: 'Logistics' } },
  { email: 'arjun@vertexmedical.in', fields: { 'Company Name': 'Vertex Medical', 'First Name': 'Arjun', City: 'Chennai', Industry: 'Healthcare' } },
  { email: 'sara@bluepeakstudio.com', fields: { 'Company Name': 'Bluepeak Studio', 'First Name': 'Sara', City: 'Bengaluru', Industry: 'Design' } },
  { email: 'contact@meridianfoods.co', fields: { 'Company Name': 'Meridian Foods', 'First Name': 'Rahul', City: 'Mumbai', Industry: 'FMCG' } },
  { email: 'hello@orbitalsystems.io', fields: { 'Company Name': 'Orbital Systems', 'First Name': 'Neha', City: 'Hyderabad', Industry: 'SaaS' } },
  { email: 'info@granitebuild.in', fields: { 'Company Name': 'Granite Build', 'First Name': 'Vikram', City: 'Ahmedabad', Industry: 'Construction' } },
  { email: 'team@lumenanalytics.com', fields: { 'Company Name': 'Lumen Analytics', 'First Name': 'Divya', City: 'Gurugram', Industry: 'Analytics' } },
  { email: 'sales@harborretail.com', fields: { 'Company Name': 'Harbor Retail', 'First Name': 'Karan', City: 'Kolkata', Industry: 'Retail' } },
]

async function main() {
  console.log('Seeding demo workspace...')

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      name: 'Demo Admin',
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12),
    },
  })

  let org = await prisma.organization.findUnique({ where: { slug: 'demo-workspace' } })
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'Demo Workspace',
        slug: 'demo-workspace',
        timezone: 'Asia/Kolkata',
        members: { create: { userId: user.id, role: 'OWNER' } },
      },
    })
  }

  const templates = [
    {
      name: 'Initial Outreach',
      description: 'First touch — introduces you and asks for a call.',
      subject: '{{Company Name}}',
      html: `<p>Hi {{First Name|there}},</p>
<p>I came across {{Company Name}} while looking at {{Industry|your sector}} teams in {{City}}, and wanted to reach out.</p>
<p>We help companies run outbound email without the manual work — personalised first touches and automatic follow-ups, all from one dashboard.</p>
<p>Would a short call next week be useful?</p>
<p>Best regards,<br>Demo Admin</p>`,
    },
    {
      name: 'Follow-up 1 — Gentle Nudge',
      description: 'Replies inside the original thread after a few days.',
      subject: '{{Company Name}}',
      html: `<p>Hi {{First Name|there}},</p>
<p>Floating this back to the top of your inbox in case it got buried.</p>
<p>Happy to send a one-page overview instead if that is easier.</p>
<p>Best regards,<br>Demo Admin</p>`,
    },
    {
      name: 'Follow-up 2 — Case Study',
      description: 'Adds proof and a specific result.',
      subject: '{{Company Name}}',
      html: `<p>Hi {{First Name|there}},</p>
<p>One quick data point: a {{Industry|similar}} team cut their outreach admin from six hours a week to about twenty minutes using this setup.</p>
<p>Worth a fifteen-minute look?</p>
<p>Best regards,<br>Demo Admin</p>`,
    },
    {
      name: 'Follow-up 3 — Closing the Loop',
      description: 'Polite final message in the sequence.',
      subject: '{{Company Name}}',
      html: `<p>Hi {{First Name|there}},</p>
<p>I do not want to keep cluttering your inbox, so this is my last note on this.</p>
<p>If the timing is wrong, just say the word and I will close the loop.</p>
<p>Best regards,<br>Demo Admin</p>`,
    },
  ]

  const created = []
  for (const tpl of templates) {
    const template = await prisma.template.upsert({
      where: { orgId_name: { orgId: org.id, name: tpl.name } },
      update: { subject: tpl.subject, html: tpl.html, description: tpl.description },
      create: { orgId: org.id, createdById: user.id, ...tpl },
    })
    created.push(template)
  }

  const campaign = await prisma.campaign.upsert({
    where: { orgId_name: { orgId: org.id, name: 'Q3 Enterprise Outreach' } },
    update: {},
    create: {
      orgId: org.id,
      name: 'Q3 Enterprise Outreach',
      description: 'Demo campaign showing the full four-step sequence.',
      status: 'DRAFT',
      steps: {
        create: [
          { kind: 'NEW', templateId: created[0].id },
          { kind: 'FOLLOWUP_1', templateId: created[1].id },
          { kind: 'FOLLOWUP_2', templateId: created[2].id },
          { kind: 'FOLLOWUP_3', templateId: created[3].id },
        ],
      },
    },
  })

  for (const contact of CONTACTS) {
    await prisma.contact.upsert({
      where: { campaignId_email: { campaignId: campaign.id, email: contact.email } },
      update: { fields: contact.fields },
      create: { campaignId: campaign.id, email: contact.email, fields: contact.fields },
    })
  }

  console.log(`
Demo workspace ready.

  Sign in with
    email:    ${DEMO_EMAIL}
    password: ${DEMO_PASSWORD}

  Seeded: 1 campaign, ${CONTACTS.length} contacts, ${templates.length} templates.
  Connect a Gmail account in Settings to start creating drafts.
`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
