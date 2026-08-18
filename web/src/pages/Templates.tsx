import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, FileText, Plus, Search, Trash2 } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { Template } from '../lib/types'
import { formatRelative } from '../lib/format'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Card, EmptyState, ErrorBlock, Input, LoadingBlock } from '../components/ui'
import { useToast } from '../components/Toast'

export default function Templates() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['templates', search],
    queryFn: () => api.get<{ templates: Template[] }>(`/templates${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`),
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['templates'] })

  const duplicate = useMutation({
    mutationFn: (id: string) => api.post<{ template: Template }>(`/templates/${id}/duplicate`),
    onSuccess: () => {
      toast.success('Template duplicated')
      invalidate()
    },
    onError: (err) => toast.error('Could not duplicate', err instanceof ApiError ? err.message : undefined),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ archived: boolean }>(`/templates/${id}`),
    onSuccess: (result) => {
      toast.success(result.archived ? 'Template archived' : 'Template deleted', result.archived ? 'It is still used by a campaign step.' : undefined)
      invalidate()
    },
    onError: (err) => toast.error('Could not delete', err instanceof ApiError ? err.message : undefined),
  })

  const templates = data?.templates ?? []

  return (
    <>
      <PageHeader
        title="Templates"
        description="Write once, personalise per contact with merge variables."
        actions={
          <Link to="/templates/new">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />}>
              New template
            </Button>
          </Link>
        }
      />

      <div className="relative mb-5 sm:w-72">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates…" className="pl-9" />
      </div>

      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorBlock message={error instanceof ApiError ? error.message : 'Failed to load'} onRetry={refetch} />
      ) : templates.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText className="h-6 w-6" />}
            title={search ? 'No matching templates' : 'No templates yet'}
            description={
              search ? 'Try a different search term.' : 'Create a template, then attach it to a step in any campaign.'
            }
            action={
              !search ? (
                <Link to="/templates/new">
                  <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />}>
                    New template
                  </Button>
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <Card key={template.id} className="flex h-full flex-col p-5 transition hover:border-brand-300 hover:shadow-pop">
              <Link to={`/templates/${template.id}`} className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate font-semibold text-ink-900">{template.name}</h3>
                  <Badge tone="neutral">v{template.version}</Badge>
                </div>

                {template.description && <p className="mt-1 line-clamp-2 text-sm text-ink-500">{template.description}</p>}

                <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-ink-400">Subject</p>
                  <p className="truncate font-mono text-xs text-ink-700">{template.subject}</p>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-500">
                  {template._count?.steps ? <Badge tone="brand">used in {template._count.steps} step(s)</Badge> : <Badge tone="neutral">unused</Badge>}
                  {template.isArchived && <Badge tone="warning">archived</Badge>}
                  <span className="ml-auto">{formatRelative(template.updatedAt)}</span>
                </div>
              </Link>

              <div className="mt-4 flex gap-2 border-t border-ink-100 pt-3">
                <Link to={`/templates/${template.id}`} className="flex-1">
                  <Button size="sm" className="w-full">
                    Edit
                  </Button>
                </Link>
                <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => duplicate.mutate(template.id)} title="Duplicate" />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  title="Delete"
                  onClick={() => {
                    if (confirm(`Delete "${template.name}"?`)) remove.mutate(template.id)
                  }}
                />
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
