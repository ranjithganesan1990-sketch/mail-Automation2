import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Papa from 'papaparse'
import { Download, Search, ShieldAlert, Trash2, Upload, UserPlus, Users } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { Campaign, Contact, ContactStatus } from '../lib/types'
import { formatNumber, formatRelative } from '../lib/format'
import { Badge, Button, Card, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Modal, Select, StatusBadge } from './ui'
import { useToast } from './Toast'

interface ContactsResponse {
  contacts: Contact[]
  columns: string[]
  pagination: { page: number; pageSize: number; total: number; pages: number }
}

interface ImportResult {
  created: number
  updated: number
  skipped: number
  rejected: number
  invalid: { row: number; email: string; reason: string }[]
}

const STATUS_OPTIONS: (ContactStatus | 'ALL')[] = ['ALL', 'ACTIVE', 'BOUNCED', 'UNSUBSCRIBED', 'COMPLETED']

export default function ContactsPanel({ campaignId, campaigns }: { campaignId?: string; campaigns?: Campaign[] }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const [status, setStatus] = useState<string>('ALL')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selectedCampaign, setSelectedCampaign] = useState<string>(campaignId ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importOpen, setImportOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const effectiveCampaign = campaignId ?? selectedCampaign

  const queryKey = ['contacts', effectiveCampaign, status, search, page]

  const { data, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' })
      if (effectiveCampaign) params.set('campaignId', effectiveCampaign)
      if (status !== 'ALL') params.set('status', status)
      if (search.trim()) params.set('search', search.trim())
      return api.get<ContactsResponse>(`/contacts?${params}`)
    },
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['contacts'] })
    void queryClient.invalidateQueries({ queryKey: ['campaign', effectiveCampaign] })
    void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const bulk = useMutation({
    mutationFn: (action: 'delete' | 'activate' | 'unsubscribe' | 'bounce') =>
      api.post<{ affected: number }>('/contacts/bulk', { ids: [...selected], action }),
    onSuccess: (result, action) => {
      toast.success(`${formatNumber(result.affected)} contact(s) updated`, `Action: ${action}`)
      setSelected(new Set())
      invalidate()
    },
    onError: (err) => toast.error('Bulk action failed', err instanceof ApiError ? err.message : undefined),
  })

  const cleanBounces = useMutation({
    mutationFn: () => api.post<{ markedBounced: number; scanned: number }>('/contacts/clean-bounces'),
    onSuccess: (result) => {
      toast.success(
        result.markedBounced > 0 ? `${result.markedBounced} bounced address(es) suppressed` : 'No new bounces found',
        'Read from delivery-failure notices in your mailbox.',
      )
      invalidate()
    },
    onError: (err) => toast.error('Bounce scan failed', err instanceof ApiError ? err.message : undefined),
  })

  const contacts = data?.contacts ?? []
  const columns = data?.columns ?? []
  const pagination = data?.pagination

  const allSelected = contacts.length > 0 && contacts.every((c) => selected.has(c.id))

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current)
      if (allSelected) contacts.forEach((c) => next.delete(c.id))
      else contacts.forEach((c) => next.add(c.id))
      return next
    })
  }

  const toggleOne = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              placeholder="Search by email…"
              className="pl-9"
            />
          </div>

          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
            className="w-40"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === 'ALL' ? 'All statuses' : option.charAt(0) + option.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>

          {!campaignId && campaigns && (
            <Select
              value={selectedCampaign}
              onChange={(e) => {
                setSelectedCampaign(e.target.value)
                setPage(1)
              }}
              className="w-52"
            >
              <option value="">All campaigns</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            icon={<ShieldAlert className="h-4 w-4" />}
            loading={cleanBounces.isPending}
            onClick={() => cleanBounces.mutate()}
          >
            Scan bounces
          </Button>
          <Button
            size="sm"
            icon={<Download className="h-4 w-4" />}
            onClick={() =>
              api.download(
                `/contacts/export${effectiveCampaign ? `?campaignId=${effectiveCampaign}` : ''}`,
                'contacts.csv',
              )
            }
          >
            Export
          </Button>
          <Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAddOpen(true)} disabled={!effectiveCampaign && !campaigns?.length}>
            Add
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Upload className="h-4 w-4" />}
            onClick={() => setImportOpen(true)}
            disabled={!effectiveCampaign && !campaigns?.length}
          >
            Import CSV
          </Button>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5">
          <span className="text-sm font-medium text-brand-800">{formatNumber(selected.size)} selected</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" onClick={() => bulk.mutate('activate')} loading={bulk.isPending}>
              Mark active
            </Button>
            <Button size="sm" onClick={() => bulk.mutate('unsubscribe')} loading={bulk.isPending}>
              Unsubscribe
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 className="h-4 w-4" />}
              loading={bulk.isPending}
              onClick={() => {
                if (confirm(`Delete ${selected.size} contact(s)? This cannot be undone.`)) bulk.mutate('delete')
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error instanceof ApiError ? error.message : 'Failed to load'} onRetry={refetch} />
      ) : contacts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title={search || status !== 'ALL' ? 'No matching contacts' : 'No contacts yet'}
            description={
              search || status !== 'ALL'
                ? 'Try clearing the filters.'
                : 'Import a CSV — every column header becomes a merge variable you can use in templates.'
            }
            action={
              !search && status === 'ALL' ? (
                <Button variant="primary" size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => setImportOpen(true)}>
                  Import CSV
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="table-wrap">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded border-ink-300" />
                  </th>
                  <th className="th">Email</th>
                  <th className="th">Status</th>
                  {!campaignId && <th className="th">Campaign</th>}
                  {columns.slice(0, 5).map((column) => (
                    <th key={column} className="th">
                      {column}
                    </th>
                  ))}
                  <th className="th">Thread</th>
                  <th className="th">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {contacts.map((contact) => (
                  <tr key={contact.id} className="transition hover:bg-ink-50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(contact.id)}
                        onChange={() => toggleOne(contact.id)}
                        className="rounded border-ink-300"
                      />
                    </td>
                    <td className="td font-medium text-ink-900">
                      {contact.email}
                      {contact.bounceReason && (
                        <p className="mt-0.5 max-w-xs truncate text-xs font-normal text-danger" title={contact.bounceReason}>
                          {contact.bounceReason}
                        </p>
                      )}
                    </td>
                    <td className="td">
                      <StatusBadge status={contact.status} />
                    </td>
                    {!campaignId && <td className="td text-ink-500">{contact.campaign?.name ?? '—'}</td>}
                    {columns.slice(0, 5).map((column) => (
                      <td key={column} className="td max-w-[180px] truncate">
                        {String(contact.fields?.[column] ?? '—')}
                      </td>
                    ))}
                    <td className="td">
                      {contact.threadId ? <Badge tone="success">linked</Badge> : <span className="text-ink-400">—</span>}
                    </td>
                    <td className="td text-ink-500">{formatRelative(contact.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pagination && pagination.pages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-ink-500">
                Page {pagination.page} of {pagination.pages} · {formatNumber(pagination.total)} contacts
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" disabled={page >= pagination.pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        campaignId={effectiveCampaign}
        campaigns={campaigns}
        onDone={invalidate}
      />

      <AddContactModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        campaignId={effectiveCampaign}
        campaigns={campaigns}
        onDone={invalidate}
      />
    </div>
  )
}

// ----------------------------- IMPORT MODAL -----------------------------

function ImportModal({
  open,
  onClose,
  campaignId,
  campaigns,
  onDone,
}: {
  open: boolean
  onClose: () => void
  campaignId?: string
  campaigns?: Campaign[]
  onDone: () => void
}) {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [emailKey, setEmailKey] = useState('')
  const [target, setTarget] = useState(campaignId ?? '')
  const [updateExisting, setUpdateExisting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  const effectiveTarget = campaignId ?? target

  const guessedEmailKey = useMemo(() => headers.find((h) => /e-?mail/i.test(h)) ?? '', [headers])

  const reset = () => {
    setRows([])
    setHeaders([])
    setEmailKey('')
    setResult(null)
    setParseError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleFile = (file: File) => {
    setParseError(null)
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (parsed) => {
        const data = parsed.data.filter((row) => Object.values(row).some((v) => String(v ?? '').trim() !== ''))
        if (data.length === 0) {
          setParseError('That file has no data rows.')
          return
        }
        const fields = (parsed.meta.fields ?? []).filter((f) => f && f.trim() !== '')
        setRows(data)
        setHeaders(fields)
        setEmailKey(fields.find((f) => /e-?mail/i.test(f)) ?? fields[0] ?? '')
      },
      error: (err) => setParseError(err.message),
    })
  }

  const importMutation = useMutation({
    mutationFn: () =>
      api.post<ImportResult>('/contacts/import', {
        campaignId: effectiveTarget,
        rows,
        emailKey: emailKey || guessedEmailKey || undefined,
        updateExisting,
      }),
    onSuccess: (data) => {
      setResult(data)
      toast.success(`${formatNumber(data.created)} contact(s) imported`, data.rejected > 0 ? `${data.rejected} row(s) rejected` : undefined)
      onDone()
    },
    onError: (err) => toast.error('Import failed', err instanceof ApiError ? err.message : undefined),
  })

  const close = () => {
    reset()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Import contacts"
      description="Column headers become merge variables — a column named 'Company Name' powers {{Company Name}}."
      size="lg"
      footer={
        result ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              loading={importMutation.isPending}
              disabled={rows.length === 0 || !effectiveTarget || !emailKey}
              onClick={() => importMutation.mutate()}
            >
              Import {rows.length > 0 ? `${formatNumber(rows.length)} rows` : ''}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Created', value: result.created, tone: 'text-success' },
              { label: 'Updated', value: result.updated, tone: 'text-brand-600' },
              { label: 'Rejected', value: result.rejected, tone: 'text-danger' },
            ].map((tile) => (
              <div key={tile.label} className="rounded-lg border border-ink-200 p-3 text-center">
                <p className={`text-2xl font-semibold ${tile.tone}`}>{formatNumber(tile.value)}</p>
                <p className="text-xs text-ink-500">{tile.label}</p>
              </div>
            ))}
          </div>

          {result.invalid.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-ink-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-ink-50">
                  <tr>
                    <th className="th">Row</th>
                    <th className="th">Value</th>
                    <th className="th">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {result.invalid.map((row) => (
                    <tr key={`${row.row}-${row.email}`}>
                      <td className="td">{row.row}</td>
                      <td className="td">{row.email || '(blank)'}</td>
                      <td className="td text-ink-500">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {!campaignId && campaigns && (
            <Field label="Import into campaign" required>
              <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Select a campaign…</option>
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const file = e.dataTransfer.files?.[0]
              if (file) handleFile(file)
            }}
            className="rounded-xl border-2 border-dashed border-ink-300 bg-ink-50 px-6 py-8 text-center"
          >
            <Upload className="mx-auto h-8 w-8 text-ink-400" />
            <p className="mt-2 text-sm text-ink-600">Drop a CSV here, or</p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
            <Button size="sm" className="mt-2" onClick={() => fileRef.current?.click()}>
              Choose file
            </Button>
          </div>

          {parseError && <p className="text-sm text-danger">{parseError}</p>}

          {headers.length > 0 && (
            <>
              <Field label="Email column" required hint="Which column holds the recipient address.">
                <Select value={emailKey} onChange={(e) => setEmailKey(e.target.value)}>
                  {headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </Select>
              </Field>

              <div>
                <p className="label">Merge variables detected</p>
                <div className="flex flex-wrap gap-1.5">
                  {headers
                    .filter((h) => h !== emailKey)
                    .map((header) => (
                      <code key={header} className="rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">
                        {`{{${header}}}`}
                      </code>
                    ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={updateExisting}
                  onChange={(e) => setUpdateExisting(e.target.checked)}
                  className="rounded border-ink-300"
                />
                Update fields on contacts that already exist
              </label>

              {/* Preview */}
              <div className="max-h-40 overflow-auto rounded-lg border border-ink-200">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-ink-50">
                    <tr>
                      {headers.slice(0, 6).map((header) => (
                        <th key={header} className="px-3 py-2 text-left font-semibold text-ink-600">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {rows.slice(0, 5).map((row, index) => (
                      <tr key={index}>
                        {headers.slice(0, 6).map((header) => (
                          <td key={header} className="max-w-[140px] truncate px-3 py-2 text-ink-600">
                            {String(row[header] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

// ---------------------------- ADD CONTACT ------------------------------

function AddContactModal({
  open,
  onClose,
  campaignId,
  campaigns,
  onDone,
}: {
  open: boolean
  onClose: () => void
  campaignId?: string
  campaigns?: Campaign[]
  onDone: () => void
}) {
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [target, setTarget] = useState(campaignId ?? '')
  const [fieldPairs, setFieldPairs] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }])

  const effectiveTarget = campaignId ?? target

  const create = useMutation({
    mutationFn: () =>
      api.post('/contacts', {
        campaignId: effectiveTarget,
        email: email.trim(),
        fields: Object.fromEntries(
          fieldPairs.filter((pair) => pair.key.trim()).map((pair) => [pair.key.trim(), pair.value]),
        ),
      }),
    onSuccess: () => {
      toast.success('Contact added')
      setEmail('')
      setFieldPairs([{ key: '', value: '' }])
      onDone()
      onClose()
    },
    onError: (err) => toast.error('Could not add contact', err instanceof ApiError ? err.message : undefined),
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add contact"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!email.trim() || !effectiveTarget} onClick={() => create.mutate()}>
            Add contact
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!campaignId && campaigns && (
          <Field label="Campaign" required>
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Select a campaign…</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Email address" required>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        </Field>

        <div>
          <p className="label">Merge fields</p>
          <div className="space-y-2">
            {fieldPairs.map((pair, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  value={pair.key}
                  onChange={(e) =>
                    setFieldPairs((pairs) => pairs.map((p, i) => (i === index ? { ...p, key: e.target.value } : p)))
                  }
                  placeholder="Company Name"
                />
                <Input
                  value={pair.value}
                  onChange={(e) =>
                    setFieldPairs((pairs) => pairs.map((p, i) => (i === index ? { ...p, value: e.target.value } : p)))
                  }
                  placeholder="Acme Inc"
                />
              </div>
            ))}
          </div>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setFieldPairs((p) => [...p, { key: '', value: '' }])}>
            + Add field
          </Button>
        </div>
      </div>
    </Modal>
  )
}
