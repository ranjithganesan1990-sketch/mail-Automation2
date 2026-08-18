import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CalendarDays,
  FlaskConical,
  Link2,
  Paperclip,
  Play,
  Save,
  Trash2,
} from 'lucide-react'
import { api, ApiError } from '../lib/api'
import {
  STEP_LABELS,
  STEP_ORDER,
  type Attachment,
  type Campaign,
  type CampaignStep,
  type ContactStatus,
  type MailAccount,
  type Run,
  type Template,
} from '../lib/types'
import { formatDateTime, formatNumber, fromDateInput, toDateInput } from '../lib/format'
import PageHeader from '../components/PageHeader'
import ContactsPanel from '../components/ContactsPanel'
import RunsTable from '../components/RunsTable'
import {
  Button,
  Card,
  CardHeader,
  ErrorBlock,
  Field,
  Input,
  LoadingBlock,
  Select,
  StatusBadge,
  Tab,
  Tabs,
  Textarea,
} from '../components/ui'
import { useToast } from '../components/Toast'

interface CampaignResponse {
  campaign: Campaign
  contactStats: Partial<Record<ContactStatus, number>>
}

export default function CampaignDetail() {
  const { id = '' } = useParams()
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState('sequence')

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.get<CampaignResponse>(`/campaigns/${id}`),
    refetchInterval: (query) =>
      query.state.data?.campaign.steps.some((s) => s.status === 'PROCESSING') ? 4000 : false,
  })

  const { data: templates } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<{ templates: Template[] }>('/templates'),
  })

  const { data: attachments } = useQuery({
    queryKey: ['attachments'],
    queryFn: () => api.get<{ attachments: Attachment[] }>('/attachments'),
  })

  const { data: mailboxes } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => api.get<{ accounts: MailAccount[] }>('/mail-accounts'),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['campaign', id] })
    void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const syncThreads = useMutation({
    mutationFn: () => api.post<{ scanned: number; matched: number; unmatched: number }>(`/campaigns/${id}/sync-threads`),
    onSuccess: (result) => {
      toast.success(`${result.matched} of ${result.scanned} contacts linked`, 'Follow-ups will reply inside those threads.')
      invalidate()
    },
    onError: (err) => toast.error('Thread sync failed', err instanceof ApiError ? err.message : undefined),
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/campaigns/${id}`),
    onSuccess: () => {
      toast.success('Campaign deleted')
      navigate('/campaigns')
    },
    onError: (err) => toast.error('Could not delete', err instanceof ApiError ? err.message : undefined),
  })

  if (isLoading) return <LoadingBlock />
  if (error) return <ErrorBlock message={error instanceof ApiError ? error.message : 'Failed to load'} onRetry={refetch} />
  if (!data) return null

  const { campaign, contactStats } = data
  const activeContacts = contactStats.ACTIVE ?? 0

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to="/campaigns" className="inline-flex items-center gap-1 hover:text-brand-600">
            <ArrowLeft className="h-3.5 w-3.5" />
            Campaigns
          </Link>
        }
        title={campaign.name}
        description={campaign.description ?? undefined}
        actions={
          <>
            <StatusBadge status={campaign.status} />
            <Button size="sm" icon={<Link2 className="h-4 w-4" />} loading={syncThreads.isPending} onClick={() => syncThreads.mutate()}>
              Sync threads
            </Button>
          </>
        }
      />

      {/* Quick facts */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <FactTile label="Active contacts" value={formatNumber(activeContacts)} sub={`${formatNumber(contactStats.BOUNCED ?? 0)} bounced`} />
        <FactTile
          label="Sending from"
          value={campaign.mailAccount?.email ?? 'Not connected'}
          sub={campaign.mailAccount?.status === 'ACTIVE' ? 'Connected' : 'Needs attention'}
          tone={campaign.mailAccount?.status === 'ACTIVE' ? 'ok' : 'warn'}
        />
        <FactTile
          label="Delivery mode"
          value={campaign.deliveryMode === 'SEND' ? 'Auto-send' : 'Draft for review'}
          sub={campaign.deliveryMode === 'SEND' ? 'Emails go out immediately' : 'Lands in Gmail Drafts'}
        />
        <FactTile label="Attachment" value={campaign.attachment?.filename ?? 'None'} sub="Applied to every step by default" />
      </div>

      <Tabs value={tab} onChange={setTab}>
        <Tab id="sequence">Sequence</Tab>
        <Tab id="contacts" count={contactStats.ACTIVE ?? 0}>
          Contacts
        </Tab>
        <Tab id="runs">Runs</Tab>
        <Tab id="settings">Settings</Tab>
      </Tabs>

      <div className="mt-6">
        {tab === 'sequence' && (
          <div className="grid gap-4 lg:grid-cols-2">
            {STEP_ORDER.map((kind) => {
              const step = campaign.steps.find((s) => s.kind === kind)
              if (!step) return null
              return (
                <StepCard
                  key={kind}
                  campaignId={campaign.id}
                  step={step}
                  templates={templates?.templates ?? []}
                  attachments={attachments?.attachments ?? []}
                  contactCount={activeContacts}
                  canRun={Boolean(campaign.mailAccountId)}
                  onChanged={invalidate}
                />
              )
            })}
          </div>
        )}

        {tab === 'contacts' && <ContactsPanel campaignId={campaign.id} />}

        {tab === 'runs' && <RunsTable campaignId={campaign.id} />}

        {tab === 'settings' && (
          <CampaignSettings
            campaign={campaign}
            mailboxes={mailboxes?.accounts ?? []}
            attachments={attachments?.attachments ?? []}
            onChanged={invalidate}
            onDelete={() => {
              if (confirm(`Delete "${campaign.name}" and all of its contacts? This cannot be undone.`)) remove.mutate()
            }}
            deleting={remove.isPending}
          />
        )}
      </div>
    </>
  )
}

function FactTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1.5 truncate text-lg font-semibold text-ink-900" title={value}>
        {value}
      </p>
      {sub && <p className={`mt-0.5 text-xs ${tone === 'warn' ? 'text-warning' : 'text-ink-500'}`}>{sub}</p>}
    </Card>
  )
}

// ------------------------------ STEP CARD ------------------------------

function StepCard({
  campaignId,
  step,
  templates,
  attachments,
  contactCount,
  canRun,
  onChanged,
}: {
  campaignId: string
  step: CampaignStep
  templates: Template[]
  attachments: Attachment[]
  contactCount: number
  canRun: boolean
  onChanged: () => void
}) {
  const toast = useToast()
  const [date, setDate] = useState(toDateInput(step.scheduledFor))
  const [templateId, setTemplateId] = useState(step.templateId ?? '')
  const [attachmentId, setAttachmentId] = useState(step.attachmentId ?? '')

  const dirty =
    date !== toDateInput(step.scheduledFor) ||
    templateId !== (step.templateId ?? '') ||
    attachmentId !== (step.attachmentId ?? '')

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/campaigns/${campaignId}/steps/${step.kind}`, {
        scheduledFor: fromDateInput(date),
        templateId: templateId || null,
        attachmentId: attachmentId || null,
      }),
    onSuccess: () => {
      toast.success(`${STEP_LABELS[step.kind]} saved`, date ? 'It will run automatically on that date.' : undefined)
      onChanged()
    },
    onError: (err) => toast.error('Could not save step', err instanceof ApiError ? err.message : undefined),
  })

  const run = useMutation({
    mutationFn: (testOnly: boolean) => api.post<{ run: Run }>(`/campaigns/${campaignId}/run`, { kind: step.kind, testOnly }),
    onSuccess: (_result, testOnly) => {
      toast.success(testOnly ? 'Test queued for the first contact' : `${STEP_LABELS[step.kind]} queued`, 'Watch progress under the Runs tab.')
      onChanged()
    },
    onError: (err) => toast.error('Could not start run', err instanceof ApiError ? err.message : undefined),
  })

  const isFollowUp = step.kind !== 'NEW'
  const running = step.status === 'PROCESSING'

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {STEP_LABELS[step.kind]}
            <StatusBadge status={step.status} />
          </span>
        }
        description={
          isFollowUp
            ? 'Replies inside the existing Gmail thread, quoting the previous messages.'
            : 'Starts a new conversation with every active contact.'
        }
      />

      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Scheduled date" hint="Runs automatically at your workspace time.">
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="pl-9" disabled={running} />
            </div>
          </Field>

          <Field label="Template" required>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={running}>
              <option value="">Select a template…</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Attachment override" hint="Leave blank to use the campaign default.">
          <div className="relative">
            <Paperclip className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <Select value={attachmentId} onChange={(e) => setAttachmentId(e.target.value)} className="pl-9" disabled={running}>
              <option value="">Campaign default</option>
              {attachments.map((attachment) => (
                <option key={attachment.id} value={attachment.id}>
                  {attachment.filename}
                </option>
              ))}
            </Select>
          </div>
        </Field>

        {(step.sentCount > 0 || step.failedCount > 0 || step.processedAt) && (
          <div className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
            {formatNumber(step.sentCount)} created
            {step.failedCount > 0 && <span className="text-danger"> · {formatNumber(step.failedCount)} failed</span>}
            {step.processedAt && <span> · last run {formatDateTime(step.processedAt)}</span>}
          </div>
        )}

        {step.notes && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{step.notes}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-ink-200 px-5 py-3">
        <Button size="sm" variant="primary" icon={<Save className="h-4 w-4" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
        <Button
          size="sm"
          icon={<FlaskConical className="h-4 w-4" />}
          disabled={!templateId || !canRun || running}
          loading={run.isPending && run.variables === true}
          onClick={() => run.mutate(true)}
          title="Create one email for the first contact only"
        >
          Test first contact
        </Button>
        <Button
          size="sm"
          variant="success"
          icon={<Play className="h-4 w-4" />}
          disabled={!templateId || !canRun || running || contactCount === 0}
          loading={run.isPending && run.variables === false}
          onClick={() => {
            if (confirm(`Run ${STEP_LABELS[step.kind]} for ${formatNumber(contactCount)} contact(s) now?`)) run.mutate(false)
          }}
        >
          Run now
        </Button>

        {!canRun && <span className="text-xs text-warning">Connect a mailbox first</span>}
      </div>
    </Card>
  )
}

// --------------------------- CAMPAIGN SETTINGS -------------------------

function CampaignSettings({
  campaign,
  mailboxes,
  attachments,
  onChanged,
  onDelete,
  deleting,
}: {
  campaign: Campaign
  mailboxes: MailAccount[]
  attachments: Attachment[]
  onChanged: () => void
  onDelete: () => void
  deleting: boolean
}) {
  const toast = useToast()
  const [form, setForm] = useState({
    name: campaign.name,
    description: campaign.description ?? '',
    status: campaign.status,
    mailAccountId: campaign.mailAccountId ?? '',
    attachmentId: campaign.attachmentId ?? '',
    deliveryMode: campaign.deliveryMode,
  })

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/campaigns/${campaign.id}`, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        status: form.status,
        mailAccountId: form.mailAccountId || null,
        attachmentId: form.attachmentId || null,
        deliveryMode: form.deliveryMode,
      }),
    onSuccess: () => {
      toast.success('Campaign updated')
      onChanged()
    },
    onError: (err) => toast.error('Could not save', err instanceof ApiError ? err.message : undefined),
  })

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Campaign settings" />
        <div className="space-y-4 p-5">
          <Field label="Name" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>

          <Field label="Description">
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Status" hint="Only ACTIVE campaigns run on the daily schedule.">
              <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Campaign['status'] })}>
                {['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'].map((status) => (
                  <option key={status} value={status}>
                    {status.charAt(0) + status.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Delivery mode">
              <Select
                value={form.deliveryMode}
                onChange={(e) => setForm({ ...form, deliveryMode: e.target.value as Campaign['deliveryMode'] })}
              >
                <option value="DRAFT">Create drafts for review</option>
                <option value="SEND">Send automatically</option>
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Send from">
              <Select value={form.mailAccountId} onChange={(e) => setForm({ ...form, mailAccountId: e.target.value })}>
                <option value="">Select a mailbox…</option>
                {mailboxes.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.email}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Default attachment">
              <Select value={form.attachmentId} onChange={(e) => setForm({ ...form, attachmentId: e.target.value })}>
                <option value="">None</option>
                {attachments.map((attachment) => (
                  <option key={attachment.id} value={attachment.id}>
                    {attachment.filename}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <div className="border-t border-ink-200 px-5 py-3">
          <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </div>
      </Card>

      <Card className="h-fit border-red-200">
        <CardHeader title="Danger zone" description="Deleting removes every contact and run history." />
        <div className="p-5">
          <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} loading={deleting} onClick={onDelete} className="w-full">
            Delete campaign
          </Button>
        </div>
      </Card>
    </div>
  )
}
