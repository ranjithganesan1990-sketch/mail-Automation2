import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Send, Users } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { STEP_LABELS, STEP_ORDER, type Campaign, type MailAccount } from '../lib/types'
import { formatNumber, formatRelative, formatSchedule } from '../lib/format'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Card, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Modal, Select, StatusBadge, Tab, Tabs, Textarea } from '../components/ui'
import { useToast } from '../components/Toast'

const STATUS_TABS = ['ALL', 'ACTIVE', 'DRAFT', 'PAUSED', 'COMPLETED'] as const

export default function Campaigns() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['campaigns', status, search],
    queryFn: () => {
      const params = new URLSearchParams()
      if (status !== 'ALL') params.set('status', status)
      if (search.trim()) params.set('search', search.trim())
      return api.get<{ campaigns: Campaign[] }>(`/campaigns?${params}`)
    },
  })

  const { data: mailboxes } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => api.get<{ accounts: MailAccount[] }>('/mail-accounts'),
  })

  const create = useMutation({
    mutationFn: (body: { name: string; description?: string; mailAccountId?: string; deliveryMode: 'DRAFT' | 'SEND' }) =>
      api.post<{ campaign: Campaign }>('/campaigns', body),
    onSuccess: () => {
      toast.success('Campaign created', 'Add contacts and schedule its steps next.')
      setCreateOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
    },
    onError: (err) => toast.error('Could not create campaign', err instanceof ApiError ? err.message : undefined),
  })

  const campaigns = data?.campaigns ?? []

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Each campaign holds its own contact list, schedule and four-step sequence."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>
            New campaign
          </Button>
        }
      />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={status} onChange={setStatus}>
          {STATUS_TABS.map((tab) => (
            <Tab key={tab} id={tab}>
              {tab === 'ALL' ? 'All' : tab.charAt(0) + tab.slice(1).toLowerCase()}
            </Tab>
          ))}
        </Tabs>

        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            className="pl-9"
          />
        </div>
      </div>

      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error instanceof ApiError ? error.message : 'Failed to load'} onRetry={refetch} />
      ) : campaigns.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Send className="h-6 w-6" />}
            title={search ? 'No matching campaigns' : 'No campaigns yet'}
            description={
              search
                ? 'Try a different search term.'
                : 'A campaign is one audience plus a sequence: an initial email and up to three follow-ups.'
            }
            action={
              !search ? (
                <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>
                  Create campaign
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((campaign) => (
            <CampaignCard key={campaign.id} campaign={campaign} />
          ))}
        </div>
      )}

      <CreateCampaignModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        mailboxes={mailboxes?.accounts ?? []}
        onSubmit={(body) => create.mutate(body)}
        loading={create.isPending}
      />
    </>
  )
}

function CampaignCard({ campaign }: { campaign: Campaign }) {
  const active = campaign.contactStats?.ACTIVE ?? 0
  const bounced = campaign.contactStats?.BOUNCED ?? 0

  return (
    <Link to={`/campaigns/${campaign.id}`} className="block">
      <Card className="h-full p-5 transition hover:border-brand-300 hover:shadow-pop">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-ink-900">{campaign.name}</h3>
            {campaign.description && <p className="mt-0.5 line-clamp-2 text-sm text-ink-500">{campaign.description}</p>}
          </div>
          <StatusBadge status={campaign.status} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-ink-600">
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-4 w-4 text-ink-400" />
            {formatNumber(active)} active
          </span>
          {bounced > 0 && <Badge tone="warning">{formatNumber(bounced)} bounced</Badge>}
          <Badge tone={campaign.deliveryMode === 'SEND' ? 'brand' : 'neutral'}>
            {campaign.deliveryMode === 'SEND' ? 'Auto-send' : 'Draft only'}
          </Badge>
        </div>

        {/* Four-step strip */}
        <div className="mt-4 grid grid-cols-4 gap-1.5">
          {STEP_ORDER.map((kind) => {
            const step = campaign.steps?.find((s) => s.kind === kind)
            const done = step?.status === 'PROCESSED'
            const scheduled = step?.status === 'SCHEDULED'
            const failed = step?.status === 'FAILED' || step?.status === 'NO_TEMPLATE'

            return (
              <div
                key={kind}
                title={`${STEP_LABELS[kind]} — ${step?.status ?? 'not configured'}`}
                className={`rounded-lg px-2 py-2 text-center text-[10px] font-medium uppercase tracking-wide ${
                  done
                    ? 'bg-green-50 text-green-700'
                    : failed
                      ? 'bg-red-50 text-red-700'
                      : scheduled
                        ? 'bg-sky-50 text-sky-700'
                        : 'bg-ink-100 text-ink-500'
                }`}
              >
                {kind === 'NEW' ? 'New' : `FU${kind.slice(-1)}`}
                <div className="mt-0.5 text-[10px] font-normal normal-case opacity-80">
                  {step?.scheduledFor ? formatSchedule(step.scheduledFor) : '—'}
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-ink-100 pt-3 text-xs text-ink-500">
          <span className="truncate">{campaign.mailAccount?.email ?? 'No mailbox connected'}</span>
          <span className="shrink-0">{formatRelative(campaign.updatedAt)}</span>
        </div>
      </Card>
    </Link>
  )
}

function CreateCampaignModal({
  open,
  onClose,
  mailboxes,
  onSubmit,
  loading,
}: {
  open: boolean
  onClose: () => void
  mailboxes: MailAccount[]
  onSubmit: (body: { name: string; description?: string; mailAccountId?: string; deliveryMode: 'DRAFT' | 'SEND' }) => void
  loading: boolean
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mailAccountId, setMailAccountId] = useState('')
  const [deliveryMode, setDeliveryMode] = useState<'DRAFT' | 'SEND'>('DRAFT')

  const submit = () => {
    if (!name.trim()) return
    onSubmit({
      name: name.trim(),
      description: description.trim() || undefined,
      mailAccountId: mailAccountId || undefined,
      deliveryMode,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New campaign"
      description="You can change any of this later."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={loading} disabled={!name.trim()}>
            Create campaign
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Campaign name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q3 Enterprise Outreach" autoFocus />
        </Field>

        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Who this campaign targets and why."
          />
        </Field>

        <Field label="Send from" hint={mailboxes.length === 0 ? 'No mailbox connected yet — add one in Settings.' : undefined}>
          <Select value={mailAccountId} onChange={(e) => setMailAccountId(e.target.value)}>
            <option value="">Select a mailbox…</option>
            {mailboxes.map((account) => (
              <option key={account.id} value={account.id}>
                {account.email}
                {account.status !== 'ACTIVE' ? ' (needs reconnect)' : ''}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Delivery mode"
          hint={
            deliveryMode === 'DRAFT'
              ? 'Emails land in your Gmail Drafts folder for review before you send them.'
              : 'Emails are sent immediately when a step runs. Use with care.'
          }
        >
          <Select value={deliveryMode} onChange={(e) => setDeliveryMode(e.target.value as 'DRAFT' | 'SEND')}>
            <option value="DRAFT">Create drafts for review</option>
            <option value="SEND">Send automatically</option>
          </Select>
        </Field>
      </div>
    </Modal>
  )
}
