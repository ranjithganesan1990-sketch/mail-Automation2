import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, ExternalLink, History, RotateCw } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { STEP_LABELS, type Run } from '../lib/types'
import { formatDateTime, formatNumber, formatRelative } from '../lib/format'
import { Badge, Button, Card, EmptyState, ErrorBlock, LoadingBlock, Modal, ProgressBar, StatusBadge } from './ui'
import { useToast } from './Toast'

export default function RunsTable({ campaignId }: { campaignId?: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [openRunId, setOpenRunId] = useState<string | null>(null)

  const path = campaignId ? `/campaigns/${campaignId}/runs` : '/runs'

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['runs', campaignId ?? 'all'],
    queryFn: () => api.get<{ runs: Run[] }>(path),
    // Poll while anything is in flight so progress bars actually move.
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === 'RUNNING' || r.status === 'QUEUED') ? 3000 : false,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['runs'] })
    void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] })
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const cancel = useMutation({
    mutationFn: (runId: string) => api.post(`/runs/${runId}/cancel`),
    onSuccess: () => {
      toast.success('Run cancelled')
      invalidate()
    },
    onError: (err) => toast.error('Could not cancel', err instanceof ApiError ? err.message : undefined),
  })

  const resume = useMutation({
    mutationFn: (runId: string) => api.post(`/runs/${runId}/resume`),
    onSuccess: () => {
      toast.success('Run re-queued', 'It resumes from where it stopped.')
      invalidate()
    },
    onError: (err) => toast.error('Could not resume', err instanceof ApiError ? err.message : undefined),
  })

  if (isLoading) return <LoadingBlock />
  if (error) return <ErrorBlock message={error instanceof ApiError ? error.message : 'Failed to load'} onRetry={refetch} />

  const runs = data?.runs ?? []

  if (runs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<History className="h-6 w-6" />}
          title="No runs yet"
          description="Every time a step executes — manually or on schedule — it appears here with a per-contact log."
        />
      </Card>
    )
  }

  return (
    <>
      <div className="table-wrap">
        <table className="w-full">
          <thead className="border-b border-ink-200 bg-ink-50">
            <tr>
              {!campaignId && <th className="th">Campaign</th>}
              <th className="th">Step</th>
              <th className="th">Status</th>
              <th className="th">Progress</th>
              <th className="th">Results</th>
              <th className="th">Started</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {runs.map((run) => (
              <tr key={run.id} className="transition hover:bg-ink-50">
                {!campaignId && <td className="td font-medium text-ink-900">{run.campaign?.name ?? '—'}</td>}
                <td className="td">
                  {STEP_LABELS[run.kind]}
                  {run.trigger === 'TEST' && (
                    <Badge tone="neutral" className="ml-2">
                      test
                    </Badge>
                  )}
                  {run.trigger === 'SCHEDULED' && (
                    <Badge tone="info" className="ml-2">
                      auto
                    </Badge>
                  )}
                </td>
                <td className="td">
                  <StatusBadge status={run.status} />
                  {run.error && (
                    <p className="mt-1 max-w-xs truncate text-xs text-danger" title={run.error}>
                      {run.error}
                    </p>
                  )}
                </td>
                <td className="td w-40">
                  <ProgressBar
                    value={run.processed}
                    max={Math.max(run.total, 1)}
                    tone={run.status === 'FAILED' ? 'danger' : run.status === 'COMPLETED' ? 'success' : 'brand'}
                  />
                  <p className="mt-1 text-xs text-ink-500">
                    {formatNumber(run.processed)} / {formatNumber(run.total)}
                  </p>
                </td>
                <td className="td">
                  <div className="flex gap-1.5">
                    <Badge tone="success">{run.succeeded}</Badge>
                    {run.failed > 0 && <Badge tone="danger">{run.failed}</Badge>}
                    {run.skipped > 0 && <Badge tone="warning">{run.skipped}</Badge>}
                  </div>
                </td>
                <td className="td text-ink-500" title={formatDateTime(run.startedAt)}>
                  {formatRelative(run.startedAt)}
                </td>
                <td className="td">
                  <div className="flex justify-end gap-1.5">
                    {(run.status === 'QUEUED' || run.status === 'RUNNING') && (
                      <Button size="sm" variant="ghost" icon={<Ban className="h-3.5 w-3.5" />} onClick={() => cancel.mutate(run.id)}>
                        Stop
                      </Button>
                    )}
                    {(run.status === 'PAUSED' || run.status === 'FAILED' || run.status === 'CANCELLED') && (
                      <Button size="sm" variant="ghost" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={() => resume.mutate(run.id)}>
                        Resume
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => setOpenRunId(run.id)}>
                      Log
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <RunLogModal runId={openRunId} onClose={() => setOpenRunId(null)} />
    </>
  )
}

function RunLogModal({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.get<{ run: Run }>(`/runs/${runId}`),
    enabled: Boolean(runId),
  })

  const run = data?.run

  return (
    <Modal open={Boolean(runId)} onClose={onClose} title="Run log" description={run ? `${STEP_LABELS[run.kind]} · ${run.campaign?.name}` : undefined} size="xl">
      {isLoading || !run ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Created', value: run.succeeded, tone: 'text-success' },
              { label: 'Failed', value: run.failed, tone: 'text-danger' },
              { label: 'Skipped', value: run.skipped, tone: 'text-warning' },
              { label: 'Total', value: run.total, tone: 'text-ink-900' },
            ].map((tile) => (
              <div key={tile.label} className="rounded-lg border border-ink-200 p-3 text-center">
                <p className={`text-xl font-semibold ${tile.tone}`}>{formatNumber(tile.value)}</p>
                <p className="text-xs text-ink-500">{tile.label}</p>
              </div>
            ))}
          </div>

          {run.error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{run.error}</div>}

          <div className="max-h-96 overflow-auto rounded-lg border border-ink-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-ink-50">
                <tr>
                  <th className="th">Recipient</th>
                  <th className="th">Status</th>
                  <th className="th">Subject</th>
                  <th className="th">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {(run.items ?? []).map((item) => (
                  <tr key={item.id}>
                    <td className="td">{item.email}</td>
                    <td className="td">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="td max-w-[220px] truncate" title={item.subject ?? ''}>
                      {item.subject ?? '—'}
                    </td>
                    <td className="td max-w-[240px] truncate text-ink-500" title={item.error ?? ''}>
                      {item.error ?? (item.threadId ? `thread ${item.threadId.slice(0, 12)}…` : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  )
}
