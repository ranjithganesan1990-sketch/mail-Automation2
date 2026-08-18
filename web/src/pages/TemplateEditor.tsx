import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Code2, Copy, Eye, History, Save, Type } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { Campaign, Contact, Template, TemplateVersion } from '../lib/types'
import { formatDateTime } from '../lib/format'
import PageHeader from '../components/PageHeader'
import RichTextEditor from '../components/RichTextEditor'
import { Badge, Button, Card, CardHeader, Field, Input, LoadingBlock, Modal, Select, Textarea } from '../components/ui'
import { useToast } from '../components/Toast'

interface TemplateResponse {
  template: Template & { versions: TemplateVersion[] }
  variables: string[]
  usedBy: { campaignId: string; campaignName: string; kind: string }[]
}

interface PreviewResponse {
  subject: string
  html: string
  contact: { id: string; email: string; fields: Record<string, unknown> } | null
}

const DEFAULT_HTML = '<p>Hi {{First Name|there}},</p><p></p><p>Best regards,</p>'

export default function TemplateEditor() {
  const { id } = useParams()
  const isNew = !id
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [subject, setSubject] = useState('{{Company Name}}')
  const [html, setHtml] = useState(DEFAULT_HTML)
  const [mode, setMode] = useState<'rich' | 'html'>('rich')
  const [previewCampaign, setPreviewCampaign] = useState('')
  const [previewContact, setPreviewContact] = useState('')
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['template', id],
    queryFn: () => api.get<TemplateResponse>(`/templates/${id}`),
    enabled: !isNew,
  })

  // Seed the form once the template arrives.
  useEffect(() => {
    if (data && !loaded) {
      setName(data.template.name)
      setDescription(data.template.description ?? '')
      setSubject(data.template.subject)
      setHtml(data.template.html)
      setLoaded(true)
    }
  }, [data, loaded])

  const { data: campaignsData } = useQuery({
    queryKey: ['campaigns', 'ALL', ''],
    queryFn: () => api.get<{ campaigns: Campaign[] }>('/campaigns'),
  })

  const { data: contactsData } = useQuery({
    queryKey: ['contacts-preview', previewCampaign],
    queryFn: () => api.get<{ contacts: Contact[] }>(`/contacts?pageSize=25${previewCampaign ? `&campaignId=${previewCampaign}` : ''}`),
  })

  const { data: variablesData } = useQuery({
    queryKey: ['variables', previewCampaign],
    queryFn: () => api.get<{ variables: string[] }>(`/templates/meta/variables${previewCampaign ? `?campaignId=${previewCampaign}` : ''}`),
  })

  const preview = useQuery({
    queryKey: ['preview', subject, html, previewContact],
    queryFn: () =>
      api.post<PreviewResponse>('/templates/preview', {
        subject,
        html,
        contactId: previewContact || null,
        campaignId: previewCampaign || null,
      }),
    enabled: Boolean(subject || html),
  })

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: description.trim() || null, subject: subject.trim(), html }
      return isNew ? api.post<{ template: Template }>('/templates', body) : api.patch<{ template: Template }>(`/templates/${id}`, body)
    },
    onSuccess: (result) => {
      toast.success(isNew ? 'Template created' : 'Template saved')
      void queryClient.invalidateQueries({ queryKey: ['templates'] })
      void queryClient.invalidateQueries({ queryKey: ['template', id] })
      if (isNew) navigate(`/templates/${result.template.id}`, { replace: true })
    },
    onError: (err) => toast.error('Could not save template', err instanceof ApiError ? err.message : undefined),
  })

  const restore = useMutation({
    mutationFn: (version: number) => api.post<{ template: Template }>(`/templates/${id}/restore/${version}`),
    onSuccess: (result) => {
      setSubject(result.template.subject)
      setHtml(result.template.html)
      setVersionsOpen(false)
      toast.success('Version restored')
      void queryClient.invalidateQueries({ queryKey: ['template', id] })
    },
    onError: (err) => toast.error('Could not restore', err instanceof ApiError ? err.message : undefined),
  })

  const variables = useMemo(() => variablesData?.variables ?? ['Email'], [variablesData])

  const insertVariable = (variable: string) => {
    const token = `{{${variable}}}`
    setHtml((current) => `${current}<p>${token}</p>`)
    void navigator.clipboard?.writeText(token)
    toast.info(`${token} copied`, 'Paste it anywhere in the subject or body.')
  }

  if (!isNew && isLoading) return <LoadingBlock />

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to="/templates" className="inline-flex items-center gap-1 hover:text-brand-600">
            <ArrowLeft className="h-3.5 w-3.5" />
            Templates
          </Link>
        }
        title={isNew ? 'New template' : name || 'Template'}
        description={isNew ? 'Write your message and drop in merge variables from your contact columns.' : undefined}
        actions={
          <>
            {!isNew && data && (
              <>
                <Badge tone="neutral">v{data.template.version}</Badge>
                <Button size="sm" icon={<History className="h-4 w-4" />} onClick={() => setVersionsOpen(true)}>
                  History
                </Button>
              </>
            )}
            <Button
              variant="primary"
              icon={<Save className="h-4 w-4" />}
              loading={save.isPending}
              disabled={!name.trim() || !subject.trim()}
              onClick={() => save.mutate()}
            >
              {isNew ? 'Create template' : 'Save changes'}
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-5">
        {/* Editor */}
        <div className="space-y-4 xl:col-span-3">
          <Card>
            <CardHeader title="Message" />
            <div className="space-y-4 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Template name" required>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Initial Outreach" />
                </Field>
                <Field label="Description">
                  <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="First touch for cold leads" />
                </Field>
              </div>

              <Field label="Subject line" required hint="Merge variables work here too. Follow-ups automatically get a 'Re:' prefix.">
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="{{Company Name}}" />
              </Field>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="label mb-0">Body</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setMode('rich')}
                      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition ${
                        mode === 'rich' ? 'bg-brand-50 text-brand-600' : 'text-ink-500 hover:bg-ink-100'
                      }`}
                    >
                      <Type className="h-3.5 w-3.5" />
                      Rich text
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode('html')}
                      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition ${
                        mode === 'html' ? 'bg-brand-50 text-brand-600' : 'text-ink-500 hover:bg-ink-100'
                      }`}
                    >
                      <Code2 className="h-3.5 w-3.5" />
                      HTML
                    </button>
                  </div>
                </div>

                {mode === 'rich' ? (
                  <RichTextEditor value={html} onChange={setHtml} />
                ) : (
                  <Textarea
                    value={html}
                    onChange={(e) => setHtml(e.target.value)}
                    rows={16}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                )}
              </div>
            </div>
          </Card>

          {/* Variable palette */}
          <Card>
            <CardHeader
              title="Merge variables"
              description="Click to copy. Use {{Field|fallback}} to supply a default when a contact has no value."
            />
            <div className="flex flex-wrap gap-1.5 p-5">
              {variables.map((variable) => (
                <button
                  key={variable}
                  type="button"
                  onClick={() => insertVariable(variable)}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 font-mono text-xs text-brand-700 transition hover:bg-brand-100"
                >
                  <Copy className="h-3 w-3" />
                  {`{{${variable}}}`}
                </button>
              ))}
              {variables.length <= 1 && (
                <p className="text-sm text-ink-500">Import contacts with named columns and they will show up here.</p>
              )}
            </div>
          </Card>
        </div>

        {/* Live preview */}
        <div className="xl:col-span-2">
          <Card className="sticky top-6">
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Eye className="h-4 w-4 text-ink-400" />
                  Live preview
                </span>
              }
              description="Rendered against a real contact."
            />
            <div className="space-y-3 border-b border-ink-200 p-4">
              <Select
                value={previewCampaign}
                onChange={(e) => {
                  setPreviewCampaign(e.target.value)
                  setPreviewContact('')
                }}
              >
                <option value="">Any campaign</option>
                {(campaignsData?.campaigns ?? []).map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </Select>

              <Select value={previewContact} onChange={(e) => setPreviewContact(e.target.value)}>
                <option value="">First contact</option>
                {(contactsData?.contacts ?? []).map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.email}
                  </option>
                ))}
              </Select>
            </div>

            <div className="p-4">
              {preview.isLoading ? (
                <LoadingBlock label="Rendering…" />
              ) : preview.data ? (
                <div className="overflow-hidden rounded-lg border border-ink-200">
                  <div className="border-b border-ink-200 bg-ink-50 px-4 py-3">
                    <p className="text-xs text-ink-500">To</p>
                    <p className="truncate text-sm font-medium text-ink-800">
                      {preview.data.contact?.email ?? 'no contact selected'}
                    </p>
                    <p className="mt-2 text-xs text-ink-500">Subject</p>
                    <p className="truncate text-sm font-medium text-ink-800">{preview.data.subject}</p>
                  </div>
                  {/* Sandboxed so template markup cannot touch the dashboard. */}
                  <iframe
                    title="Email preview"
                    sandbox=""
                    srcDoc={preview.data.html}
                    className="h-[420px] w-full bg-white"
                  />
                </div>
              ) : (
                <p className="text-sm text-ink-500">Start typing to see a preview.</p>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Version history */}
      <Modal open={versionsOpen} onClose={() => setVersionsOpen(false)} title="Version history" size="lg">
        <ul className="divide-y divide-ink-100">
          {(data?.template.versions ?? []).map((version) => (
            <li key={version.id} className="flex items-center gap-3 py-3">
              <Badge tone={version.version === data?.template.version ? 'brand' : 'neutral'}>v{version.version}</Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-800">{version.subject}</p>
                <p className="text-xs text-ink-500">
                  {formatDateTime(version.createdAt)}
                  {version.note ? ` · ${version.note}` : ''}
                </p>
              </div>
              {version.version !== data?.template.version && (
                <Button size="sm" loading={restore.isPending} onClick={() => restore.mutate(version.version)}>
                  Restore
                </Button>
              )}
            </li>
          ))}
          {(data?.template.versions ?? []).length === 0 && <p className="py-6 text-center text-sm text-ink-500">No versions yet.</p>}
        </ul>
      </Modal>
    </>
  )
}
