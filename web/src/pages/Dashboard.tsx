import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  Mail,
  Play,
  Send,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { api, ApiError } from '../lib/api'
import { STEP_LABELS, type DashboardData } from '../lib/types'
import { formatNumber, formatRelative, formatSchedule } from '../lib/format'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBlock, LoadingBlock, ProgressBar, StatusBadge } from '../components/ui'
import { useToast } from '../components/Toast'

export default function Dashboard() {
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/dashboard'),
    // Keep the numbers moving while a run is in flight.
    refetchInterval: (query) => ((query.state.data?.summary.activeRuns ?? 0) > 0 ? 4000 : 30_000),
  })

  const runNow = useMutation({
    mutationFn: () => api.post<{ queued: number; noTemplate: number; bounced: number; errors: string[] }>('/runs/automation/run-now'),
    onSuccess: (result) => {
      toast.success(
        'Daily automation finished',
        `${result.queued} step(s) queued${result.bounced ? `, ${result.bounced} bounce(s) cleaned` : ''}`,
      )
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (err) => toast.error('Automation failed', err instanceof ApiError ? err.message : undefined),
  })

  if (isLoading) return <LoadingBlock label="Loading dashboard…" />
  if (error) return <ErrorBlock message={error instanceof ApiError ? error.message : 'Failed to load'} onRetry={refetch} />
  if (!data) return null

  const { summary } = data
  const needsAttention = data.mailAccounts.filter((a) => a.status !== 'ACTIVE')

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Automation runs at ${summary.dailyRunTime} ${summary.timezone.replace('_', ' ')} each day.`}
        actions={
          <>
            <Badge tone={summary.automationOn ? 'success' : 'warning'}>
              <Zap className="h-3 w-3" />
              {summary.automationOn ? 'Automation on' : 'Automation paused'}
            </Badge>
            <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={runNow.isPending} onClick={() => runNow.mutate()}>
              Run daily process now
            </Button>
          </>
        }
      />

      {/* Alerts */}
      {(needsAttention.length > 0 || data.mailAccounts.length === 0) && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-900">
              {data.mailAccounts.length === 0 ? 'No mailbox connected' : 'A mailbox needs reconnecting'}
            </p>
            <p className="mt-0.5 text-sm text-amber-800">
              {data.mailAccounts.length === 0
                ? 'Connect a Gmail account before campaigns can create drafts or replies.'
                : needsAttention.map((a) => a.email).join(', ')}
            </p>
          </div>
          <Link to="/settings/mailboxes">
            <Button size="sm" variant="secondary">
              Open mailboxes
            </Button>
          </Link>
        </div>
      )}

      {/* Stat tiles */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Emails today"
          value={summary.draftsToday}
          icon={<Send className="h-4 w-4" />}
          footer={`${formatNumber(summary.quotaRemaining)} of ${formatNumber(summary.dailyQuota)} left today`}
          progress={{ value: summary.draftsToday, max: summary.dailyQuota }}
        />
        <StatTile
          label="Sent this week"
          value={summary.draftsWeek}
          icon={<TrendingUp className="h-4 w-4" />}
          footer={summary.failedWeek > 0 ? `${summary.failedWeek} failed` : 'No failures this week'}
          tone={summary.failedWeek > 0 ? 'warning' : 'success'}
        />
        <StatTile
          label="Active contacts"
          value={summary.activeContacts}
          icon={<Users className="h-4 w-4" />}
          footer={`${formatNumber(summary.bouncedContacts)} bounced · ${formatNumber(summary.unsubscribedContacts)} unsubscribed`}
        />
        <StatTile
          label="Active campaigns"
          value={summary.campaignsActive}
          icon={<Mail className="h-4 w-4" />}
          footer={`${formatNumber(summary.campaignsTotal)} total · ${formatNumber(summary.templatesCount)} templates`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Trend */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Delivery activity"
            description="Emails created over the last 14 days"
            action={
              summary.activeRuns > 0 ? (
                <Badge tone="info">
                  <Clock className="h-3 w-3" />
                  {summary.activeRuns} running
                </Badge>
              ) : null
            }
          />
          <div className="p-4">
            {data.trend.every((d) => d.success + d.failed + d.skipped === 0) ? (
              <EmptyState
                icon={<TrendingUp className="h-6 w-6" />}
                title="No activity yet"
                description="Once a campaign runs, its daily volume shows up here."
              />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={data.trend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="successFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#1E88E5" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#1E88E5" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(value: string) => format(parseISO(value), 'd MMM')}
                    tick={{ fontSize: 11, fill: '#94A3B8' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: '1px solid #E2E8F0', fontSize: 12 }}
                    labelFormatter={(value: string) => format(parseISO(value), 'd MMMM yyyy')}
                  />
                  <Area type="monotone" dataKey="success" name="Created" stroke="#1E88E5" strokeWidth={2} fill="url(#successFill)" />
                  <Area type="monotone" dataKey="failed" name="Failed" stroke="#DC2626" strokeWidth={2} fillOpacity={0} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* Follow-up funnel */}
        <Card>
          <CardHeader title="Sequence funnel" description="Total emails per step" />
          <div className="p-4">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.funnel} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                <XAxis
                  dataKey="kind"
                  tickFormatter={(kind: keyof typeof STEP_LABELS) => (kind === 'NEW' ? 'Initial' : kind.replace('FOLLOWUP_', 'FU'))}
                  tick={{ fontSize: 11, fill: '#94A3B8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ borderRadius: 10, border: '1px solid #E2E8F0', fontSize: 12 }}
                  formatter={(value: number) => [value, 'Created']}
                  labelFormatter={(kind: keyof typeof STEP_LABELS) => STEP_LABELS[kind] ?? kind}
                />
                <Bar dataKey="succeeded" radius={[6, 6, 0, 0]}>
                  {data.funnel.map((_, index) => (
                    <Cell key={index} fill={['#1E88E5', '#42A5F5', '#64B5F6', '#90CAF9'][index]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Campaign overview — the old Dashboard sheet */}
      <Card className="mt-6">
        <CardHeader
          title="Campaign overview"
          description="Every campaign and where each step stands"
          action={
            <Link to="/campaigns">
              <Button size="sm" variant="secondary">
                View all
              </Button>
            </Link>
          }
        />
        {data.campaigns.length === 0 ? (
          <EmptyState
            icon={<Send className="h-6 w-6" />}
            title="No campaigns yet"
            description="Create your first campaign to schedule an initial email and up to three follow-ups."
            action={
              <Link to="/campaigns">
                <Button variant="primary" size="sm">
                  Create campaign
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Campaign</th>
                  <th className="th">Contacts</th>
                  <th className="th">Initial</th>
                  <th className="th">FU 1</th>
                  <th className="th">FU 2</th>
                  <th className="th">FU 3</th>
                  <th className="th">Last run</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.campaigns.map((campaign) => (
                  <tr key={campaign.id} className="transition hover:bg-ink-50">
                    <td className="td">
                      <Link to={`/campaigns/${campaign.id}`} className="font-medium text-brand-600 hover:text-brand-700">
                        {campaign.name}
                      </Link>
                      <div className="mt-0.5">
                        <StatusBadge status={campaign.status} />
                      </div>
                    </td>
                    <td className="td">{formatNumber(campaign.contacts)}</td>
                    {(['NEW', 'FOLLOWUP_1', 'FOLLOWUP_2', 'FOLLOWUP_3'] as const).map((kind) => {
                      const step = campaign.steps.find((s) => s.kind === kind)
                      return (
                        <td key={kind} className="td">
                          {step ? (
                            <div className="space-y-0.5">
                              <StatusBadge status={step.status} />
                              <div className="text-xs text-ink-500">{formatSchedule(step.scheduledFor)}</div>
                            </div>
                          ) : (
                            <span className="text-ink-400">—</span>
                          )}
                        </td>
                      )
                    })}
                    <td className="td text-ink-500">
                      {campaign.lastRun ? formatRelative(campaign.lastRun.startedAt) : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Upcoming */}
        <Card>
          <CardHeader title="Scheduled this week" description="Steps queued to run in the next 7 days" />
          {data.upcoming.length === 0 ? (
            <EmptyState
              icon={<CalendarClock className="h-6 w-6" />}
              title="Nothing scheduled"
              description="Set dates on a campaign's steps to have them run automatically."
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {data.upcoming.map((step) => (
                <li key={step.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                    <CalendarClock className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link to={`/campaigns/${step.campaign.id}`} className="block truncate text-sm font-medium text-ink-800 hover:text-brand-600">
                      {step.campaign.name}
                    </Link>
                    <p className="truncate text-xs text-ink-500">
                      {STEP_LABELS[step.kind]}
                      {step.template ? ` · ${step.template.name}` : ' · no template'}
                    </p>
                  </div>
                  <Badge tone="info">{formatSchedule(step.scheduledFor)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Recent runs */}
        <Card>
          <CardHeader
            title="Recent runs"
            description="Latest execution history"
            action={
              <Link to="/activity">
                <Button size="sm" variant="ghost">
                  View activity
                </Button>
              </Link>
            }
          />
          {data.recentRuns.length === 0 ? (
            <EmptyState icon={<FileText className="h-6 w-6" />} title="No runs yet" description="Run a campaign step to see its history here." />
          ) : (
            <ul className="divide-y divide-ink-100">
              {data.recentRuns.map((run) => (
                <li key={run.id} className="flex items-center gap-3 px-5 py-3">
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                      run.status === 'COMPLETED' ? 'bg-green-50 text-success' : run.status === 'FAILED' ? 'bg-red-50 text-danger' : 'bg-sky-50 text-sky-600'
                    }`}
                  >
                    {run.status === 'COMPLETED' ? <CheckCircle2 className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-800">{run.campaign?.name ?? 'Campaign'}</p>
                    <p className="truncate text-xs text-ink-500">
                      {STEP_LABELS[run.kind]} · {run.succeeded}/{run.total} · {formatRelative(run.startedAt)}
                    </p>
                  </div>
                  <StatusBadge status={run.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}

function StatTile({
  label,
  value,
  icon,
  footer,
  progress,
  tone = 'brand',
}: {
  label: string
  value: number
  icon: React.ReactNode
  footer?: string
  progress?: { value: number; max: number }
  tone?: 'brand' | 'success' | 'warning'
}) {
  const toneClasses = {
    brand: 'bg-brand-50 text-brand-600',
    success: 'bg-green-50 text-success',
    warning: 'bg-amber-50 text-warning',
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-ink-900">{formatNumber(value)}</p>
        </div>
        <span className={`rounded-lg p-2 ${toneClasses[tone]}`}>{icon}</span>
      </div>
      {progress && (
        <div className="mt-3">
          <ProgressBar value={progress.value} max={progress.max} />
        </div>
      )}
      {footer && <p className="mt-2 text-xs text-ink-500">{footer}</p>}
    </Card>
  )
}
