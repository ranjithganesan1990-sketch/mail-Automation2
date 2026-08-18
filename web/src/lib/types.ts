export type Role = 'OWNER' | 'ADMIN' | 'MEMBER'
export type StepKind = 'NEW' | 'FOLLOWUP_1' | 'FOLLOWUP_2' | 'FOLLOWUP_3'
export type StepStatus = 'PENDING' | 'SCHEDULED' | 'PROCESSING' | 'PROCESSED' | 'SKIPPED' | 'NO_TEMPLATE' | 'FAILED'
export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED'
export type ContactStatus = 'ACTIVE' | 'BOUNCED' | 'UNSUBSCRIBED' | 'COMPLETED'
export type RunStatus = 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type DeliveryMode = 'DRAFT' | 'SEND'
export type MailAccountStatus = 'ACTIVE' | 'NEEDS_REAUTH' | 'DISABLED'

export interface User {
  id: string
  name: string
  email: string
  avatarColor: string
}

export interface Org {
  id: string
  name: string
  slug: string
  role: Role
}

export interface OrgSettings {
  id: string
  name: string
  slug: string
  timezone: string
  dailyRunHour: number
  dailyRunMinute: number
  automationOn: boolean
  sendDailyDigest: boolean
  digestEmail: string | null
  autoCleanBounce: boolean
  planId: string
  subscriptionStatus: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  maxContacts: number
  maxDailyDrafts: number
  maxMailAccounts: number
  maxCampaigns: number
}

/**
 * Instance-wide Google OAuth configuration. The client secret is never sent
 * to the browser — `secretSet` only reports whether one is stored.
 */
export interface GoogleOAuthSettings {
  clientId: string
  redirectUri: string
  secretSet: boolean
  secretInDatabase: boolean
  source: 'database' | 'env' | 'none'
  envFallbackPresent: boolean
  expectedRedirectUri: string
}

export interface MailAccount {
  id: string
  email: string
  name: string | null
  provider: string
  status: MailAccountStatus
  isDefault: boolean
  lastError: string | null
  createdAt: string
  _count?: { campaigns: number }
}

export interface Template {
  id: string
  name: string
  description: string | null
  subject: string
  html: string
  version: number
  isArchived: boolean
  createdAt: string
  updatedAt: string
  _count?: { steps: number; versions: number }
}

export interface TemplateVersion {
  id: string
  version: number
  subject: string
  html: string
  note: string | null
  createdAt: string
}

export interface CampaignStep {
  id: string
  kind: StepKind
  status: StepStatus
  scheduledFor: string | null
  templateId: string | null
  attachmentId: string | null
  processedAt: string | null
  sentCount: number
  failedCount: number
  notes: string | null
  template?: { id: string; name: string; subject?: string } | null
  attachment?: { id: string; filename: string } | null
}

export interface Campaign {
  id: string
  name: string
  description: string | null
  status: CampaignStatus
  deliveryMode: DeliveryMode
  mailAccountId: string | null
  attachmentId: string | null
  createdAt: string
  updatedAt: string
  mailAccount?: { id: string; email: string; status: MailAccountStatus } | null
  attachment?: { id: string; filename: string } | null
  steps: CampaignStep[]
  runs?: Run[]
  _count?: { contacts: number }
  contactStats?: Partial<Record<ContactStatus, number>>
}

export interface Contact {
  id: string
  campaignId: string
  email: string
  status: ContactStatus
  fields: Record<string, unknown>
  threadId: string | null
  lastStatus: string | null
  bounceReason: string | null
  createdAt: string
  campaign?: { id: string; name: string }
}

export interface Run {
  id: string
  campaignId: string
  kind: StepKind
  trigger: 'MANUAL' | 'SCHEDULED' | 'TEST'
  status: RunStatus
  mode: DeliveryMode
  total: number
  processed: number
  succeeded: number
  failed: number
  skipped: number
  error: string | null
  startedAt: string
  finishedAt: string | null
  campaign?: { id: string; name: string }
  items?: RunItem[]
}

export interface RunItem {
  id: string
  email: string
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED'
  subject: string | null
  gmailDraftId: string | null
  threadId: string | null
  error: string | null
  createdAt: string
}

export interface Attachment {
  id: string
  filename: string
  mimeType: string
  size: number
  createdAt: string
  _count?: { campaigns: number; steps: number }
}

export interface ActivityEntry {
  id: string
  type: string
  message: string
  meta: Record<string, unknown>
  createdAt: string
  user: { name: string; avatarColor: string } | null
}

export interface Member {
  id: string
  role: Role
  createdAt: string
  user: { id: string; name: string; email: string; avatarColor: string }
}

export interface DashboardData {
  summary: {
    campaignsTotal: number
    campaignsActive: number
    totalContacts: number
    activeContacts: number
    bouncedContacts: number
    unsubscribedContacts: number
    templatesCount: number
    draftsToday: number
    draftsWeek: number
    failedWeek: number
    activeRuns: number
    dailyQuota: number
    quotaRemaining: number
    automationOn: boolean
    dailyRunTime: string
    timezone: string
  }
  mailAccounts: { id: string; email: string; status: MailAccountStatus; isDefault: boolean }[]
  trend: { date: string; success: number; failed: number; skipped: number }[]
  funnel: { kind: StepKind; succeeded: number; failed: number; skipped: number }[]
  campaigns: {
    id: string
    name: string
    status: CampaignStatus
    contacts: number
    deliveryMode: DeliveryMode
    lastRun: Run | null
    steps: { kind: StepKind; status: StepStatus; scheduledFor: string | null; templateName: string | null; sentCount: number }[]
  }[]
  upcoming: (CampaignStep & { campaign: { id: string; name: string; status: CampaignStatus } })[]
  recentRuns: Run[]
  recentActivity: ActivityEntry[]
}

export const STEP_LABELS: Record<StepKind, string> = {
  NEW: 'Initial Email',
  FOLLOWUP_1: 'Follow-up 1',
  FOLLOWUP_2: 'Follow-up 2',
  FOLLOWUP_3: 'Follow-up 3',
}

export const STEP_ORDER: StepKind[] = ['NEW', 'FOLLOWUP_1', 'FOLLOWUP_2', 'FOLLOWUP_3']
