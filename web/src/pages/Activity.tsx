import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity as ActivityIcon } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { ActivityEntry } from '../lib/types'
import { formatDateTime, formatRelative } from '../lib/format'
import PageHeader from '../components/PageHeader'
import RunsTable from '../components/RunsTable'
import { Avatar, Card, CardHeader, EmptyState, ErrorBlock, LoadingBlock, Tab, Tabs } from '../components/ui'

export default function Activity() {
  const [tab, setTab] = useState('runs')

  return (
    <>
      <PageHeader title="Activity" description="Execution history and an audit trail of everything that happened in this workspace." />

      <Tabs value={tab} onChange={setTab}>
        <Tab id="runs">Runs</Tab>
        <Tab id="audit">Audit log</Tab>
      </Tabs>

      <div className="mt-6">{tab === 'runs' ? <RunsTable /> : <AuditLog />}</div>
    </>
  )
}

function AuditLog() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.get<{ activity: ActivityEntry[] }>('/orgs/activity?limit=100'),
  })

  if (isLoading) return <LoadingBlock />
  if (error) return <ErrorBlock message={error instanceof ApiError ? error.message : 'Failed to load'} onRetry={refetch} />

  const entries = data?.activity ?? []

  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState icon={<ActivityIcon className="h-6 w-6" />} title="Nothing logged yet" description="Actions taken in this workspace will appear here." />
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader title="Audit log" description="Newest first" />
      <ul className="divide-y divide-ink-100">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-start gap-3 px-5 py-3">
            {entry.user ? (
              <Avatar name={entry.user.name} color={entry.user.avatarColor} size={30} />
            ) : (
              <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-ink-200 text-ink-500">
                <ActivityIcon className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink-800">{entry.message}</p>
              <p className="mt-0.5 text-xs text-ink-500" title={formatDateTime(entry.createdAt)}>
                <code className="rounded bg-ink-100 px-1 py-0.5 text-[11px] text-ink-600">{entry.type}</code>
                <span className="ml-2">{formatRelative(entry.createdAt)}</span>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
