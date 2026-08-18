import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bot,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Star,
  FileText,
} from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { InboxMessage, InboxPage, InboxThread, Suggestion, Tone } from '../lib/types'
import { formatDateTime } from '../lib/format'
import PageHeader from '../components/PageHeader'
import RichTextEditor from '../components/RichTextEditor'
import { Button, Card, EmptyState, ErrorBlock, Input, Select, Spinner } from '../components/ui'
import { useToast } from '../components/Toast'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'starred', label: 'Starred' },
] as const

const TONES: { id: Tone; label: string }[] = [
  { id: 'professional', label: 'Professional' },
  { id: 'friendly', label: 'Friendly' },
  { id: 'concise', label: 'Concise' },
  { id: 'persuasive', label: 'Persuasive' },
  { id: 'formal', label: 'Formal' },
]

const TONE_LABELS: Record<string, string> = {
  professional: 'Professional',
  short: 'Short & direct',
  friendly: 'Friendly',
  concise: 'Concise',
  persuasive: 'Persuasive',
  formal: 'Formal',
}

/** "Annie James <a@b.com>" → "Annie James". Falls back to the address. */
function displayName(from: string): string {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*</)
  const name = match?.[1]?.trim()
  return name || from.replace(/[<>]/g, '').trim()
}

function addressOf(from: string): string {
  return from.match(/<([^>]+)>/)?.[1] ?? from.trim()
}

export default function Inbox() {
  const toast = useToast()
  const queryClient = useQueryClient()

  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['inbox', filter, search],
    queryFn: () => api.get<InboxPage>(`/inbox?filter=${filter}&search=${encodeURIComponent(search)}`),
  })

  // Cheap "anything new?" poll. Gmail returns only what changed since the last
  // history marker, so this stays one small request regardless of mailbox size.
  const historyId = list.data?.historyId
  const updates = useQuery({
    queryKey: ['inbox-updates', historyId],
    queryFn: () => api.get<{ count: number; historyId: string | null }>(`/inbox/updates?historyId=${historyId}`),
    enabled: Boolean(historyId),
    refetchInterval: 60_000,
  })

  const newCount = updates.data?.count ?? 0

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="Read replies and answer them with AI assistance, without leaving the app."
        actions={
          <Button
            icon={<RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} />}
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ['inbox'] })
              void queryClient.invalidateQueries({ queryKey: ['inbox-updates'] })
            }}
          >
            Refresh
          </Button>
        }
      />

      {newCount > 0 && (
        <button
          type="button"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ['inbox'] })}
          className="mb-4 w-full rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-100"
        >
          {newCount} new {newCount === 1 ? 'message' : 'messages'} — click to load
        </button>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card className="flex max-h-[calc(100vh-13rem)] flex-col overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-ink-200 p-4">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                setSearch(searchInput.trim())
              }}
              className="relative"
            >
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search mail…"
                className="pl-9"
              />
            </form>

            <div className="flex gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                    filter === f.id ? 'bg-brand-50 text-brand-700' : 'text-ink-500 hover:bg-ink-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.isLoading && <MessageSkeleton />}

            {list.error && (
              <div className="p-4">
                <ErrorBlock
                  message={list.error instanceof ApiError ? list.error.message : 'Could not load your inbox.'}
                  onRetry={() => void list.refetch()}
                />
              </div>
            )}

            {list.data?.messages.length === 0 && (
              <div className="p-6">
                <EmptyState
                  icon={<InboxIcon className="h-6 w-6" />}
                  title="No new emails"
                  description={
                    search || filter !== 'all'
                      ? 'Nothing matches that filter right now.'
                      : 'Replies to your campaigns will show up here.'
                  }
                />
              </div>
            )}

            {list.data?.messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                active={message.threadId === openThreadId}
                onOpen={() => setOpenThreadId(message.threadId)}
                onToast={toast}
              />
            ))}
          </div>
        </Card>

        {openThreadId ? (
          <ThreadPane
            threadId={openThreadId}
            aiConfigured={list.data?.aiConfigured ?? false}
            onClose={() => setOpenThreadId(null)}
          />
        ) : (
          <Card className="flex min-h-[24rem] items-center justify-center p-8">
            <EmptyState
              icon={<Mail className="h-6 w-6" />}
              title="Select a conversation"
              description="Pick a message on the left to read the full thread and draft a reply."
            />
          </Card>
        )}
      </div>
    </div>
  )
}

function MessageSkeleton() {
  return (
    <div className="flex flex-col gap-px">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="animate-pulse border-b border-ink-100 p-4">
          <div className="mb-2 h-3 w-1/3 rounded bg-ink-100" />
          <div className="mb-2 h-3 w-2/3 rounded bg-ink-100" />
          <div className="h-3 w-full rounded bg-ink-50" />
        </div>
      ))}
    </div>
  )
}

function MessageRow({
  message,
  active,
  onOpen,
  onToast,
}: {
  message: InboxMessage
  active: boolean
  onOpen: () => void
  onToast: ReturnType<typeof useToast>
}) {
  const queryClient = useQueryClient()

  const flags = useMutation({
    mutationFn: (body: { read?: boolean; starred?: boolean }) =>
      api.patch(`/inbox/messages/${message.id}`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['inbox'] }),
    onError: (err) =>
      onToast.error('Could not update the message', err instanceof ApiError ? err.message : undefined),
  })

  return (
    <div
      className={`group flex cursor-pointer gap-3 border-b border-ink-100 p-4 transition ${
        active ? 'bg-brand-50' : 'hover:bg-ink-50'
      }`}
      onClick={() => {
        onOpen()
        if (message.unread) flags.mutate({ read: true })
      }}
    >
      <button
        type="button"
        aria-label={message.starred ? 'Remove star' : 'Add star'}
        onClick={(e) => {
          e.stopPropagation()
          flags.mutate({ starred: !message.starred })
        }}
        className="mt-0.5 shrink-0 text-ink-300 transition hover:text-amber-500"
      >
        <Star className={`h-4 w-4 ${message.starred ? 'fill-amber-400 text-amber-400' : ''}`} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${message.unread ? 'font-semibold text-ink-900' : 'text-ink-700'}`}
            title={message.from}
          >
            {displayName(message.from)}
          </span>
          <span className="shrink-0 text-xs text-ink-400">{formatDateTime(message.date)}</span>
        </div>

        <div className="flex items-center gap-1.5">
          {message.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
          <span className={`truncate text-sm ${message.unread ? 'font-medium text-ink-800' : 'text-ink-600'}`}>
            {message.subject || '(no subject)'}
          </span>
          {message.hasAttachment && <Paperclip className="h-3 w-3 shrink-0 text-ink-400" />}
        </div>

        <p className="mt-0.5 truncate text-xs text-ink-400">{message.snippet}</p>
      </div>
    </div>
  )
}

function ThreadPane({
  threadId,
  aiConfigured,
  onClose,
}: {
  threadId: string
  aiConfigured: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const [reply, setReply] = useState('')
  const [tone, setTone] = useState<Tone>('professional')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  const thread = useQuery({
    queryKey: ['inbox-thread', threadId],
    queryFn: () => api.get<InboxThread>(`/inbox/threads/${threadId}`),
  })

  // A different conversation is a different reply — never carry a draft over.
  useEffect(() => {
    setReply('')
    setSuggestions([])
  }, [threadId])

  const suggest = useMutation({
    mutationFn: (body: { tone?: Tone }) =>
      api.post<{ suggestions: Suggestion[] }>(`/inbox/threads/${threadId}/suggest`, body),
    onSuccess: (result) => setSuggestions(result.suggestions),
    onError: (err) =>
      toast.error('Could not generate a reply', err instanceof ApiError ? err.message : undefined),
  })

  const draft = useMutation({
    mutationFn: () => api.post(`/inbox/threads/${threadId}/draft`, { html: reply }),
    onSuccess: () => toast.success('Draft created', 'It is waiting in Gmail, in this same conversation.'),
    onError: (err) =>
      toast.error('Could not create the draft', err instanceof ApiError ? err.message : undefined),
  })

  const send = useMutation({
    mutationFn: () => api.post(`/inbox/threads/${threadId}/reply`, { html: reply }),
    onSuccess: () => {
      toast.success('Reply sent', 'It stays inside the original Gmail conversation.')
      setReply('')
      setSuggestions([])
      void queryClient.invalidateQueries({ queryKey: ['inbox-thread', threadId] })
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    },
    onError: (err) => toast.error('Could not send the reply', err instanceof ApiError ? err.message : undefined),
  })

  const busy = draft.isPending || send.isPending
  const latest = useMemo(() => thread.data?.messages.at(-1), [thread.data])

  if (thread.isLoading) {
    return (
      <Card className="flex min-h-[24rem] items-center justify-center p-8">
        <Spinner />
      </Card>
    )
  }

  if (thread.error || !thread.data) {
    return (
      <Card className="p-6">
        <ErrorBlock
          message={thread.error instanceof ApiError ? thread.error.message : 'Could not open this conversation.'}
          onRetry={() => void thread.refetch()}
        />
      </Card>
    )
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-ink-200 p-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink-900">
            {thread.data.subject || '(no subject)'}
          </h2>
          <p className="text-xs text-ink-500">
            {thread.data.messages.length} message{thread.data.messages.length === 1 ? '' : 's'} · replying from{' '}
            {thread.data.account.email}
          </p>
        </div>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="max-h-[26rem] min-h-[8rem] overflow-y-auto">
        <div className="flex flex-col gap-4 p-4">
          {thread.data.messages.map((message) => (
            <div key={message.id} className="rounded-lg border border-ink-200">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-ink-900">{displayName(message.from)}</span>
                  <span className="ml-2 text-xs text-ink-500">{addressOf(message.from)}</span>
                </div>
                <span className="text-xs text-ink-400">{formatDateTime(message.date)}</span>
              </div>
              <div
                className="prose prose-sm max-w-none overflow-x-auto px-4 py-3 text-sm text-ink-700"
                // Gmail content is rendered as it arrived. It is already
                // sanitised by Gmail and never re-sent from here unedited.
                dangerouslySetInnerHTML={{ __html: message.html || `<p>${message.snippet}</p>` }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 border-t border-ink-200 bg-ink-50/60 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-800">
            <Sparkles className="h-4 w-4 text-brand-500" />
            AI reply suggestion
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={tone} onChange={(e) => setTone(e.target.value as Tone)} className="h-8 py-0 text-xs">
              {TONES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="primary"
              icon={<Bot className="h-4 w-4" />}
              disabled={!aiConfigured || suggest.isPending}
              loading={suggest.isPending}
              onClick={() => suggest.mutate(suggestions.length ? { tone } : {})}
            >
              {suggestions.length ? 'Regenerate' : 'Generate AI reply'}
            </Button>
          </div>
        </div>

        {!aiConfigured && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            AI replies are not configured on this server yet. Add a GROQ_API_KEY and restart.
          </p>
        )}

        {suggest.isPending && (
          <p className="flex items-center gap-2 text-sm text-ink-500">
            <Spinner className="h-4 w-4" /> Analyzing conversation…
          </p>
        )}

        {suggestions.length > 0 && !suggest.isPending && (
          <div className="grid gap-2 sm:grid-cols-3">
            {suggestions.map((suggestion, i) => (
              <button
                key={`${suggestion.tone}-${i}`}
                type="button"
                onClick={() => setReply(suggestion.html)}
                className="rounded-lg border border-ink-200 bg-white p-3 text-left transition hover:border-brand-300 hover:shadow-sm"
              >
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-600">
                  {TONE_LABELS[suggestion.tone] ?? suggestion.tone}
                </div>
                <p className="line-clamp-6 whitespace-pre-wrap text-xs text-ink-600">{suggestion.body}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-ink-200 p-4">
        <p className="mb-2 text-xs text-ink-500">
          Replying to {latest ? displayName(latest.from) : 'this conversation'} — stays in the same Gmail thread.
        </p>

        <RichTextEditor value={reply} onChange={setReply} placeholder="Write your reply…" />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={<Send className="h-4 w-4" />}
            disabled={!reply.trim() || busy}
            loading={send.isPending}
            onClick={() => {
              if (confirm('Send this reply now?')) send.mutate()
            }}
          >
            Send reply
          </Button>
          <Button
            icon={<FileText className="h-4 w-4" />}
            disabled={!reply.trim() || busy}
            loading={draft.isPending}
            onClick={() => draft.mutate()}
          >
            Create draft
          </Button>
          <Button
            icon={<MailOpen className="h-4 w-4" />}
            disabled={!reply.trim() || busy}
            onClick={() => {
              void navigator.clipboard.writeText(reply.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
              toast.success('Copied', 'The reply text is on your clipboard.')
            }}
          >
            Copy
          </Button>
        </div>
      </div>
    </Card>
  )
}
