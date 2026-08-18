import { useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Mail, Plug, RefreshCw, Star, Trash2 } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { MailAccount } from '../lib/types'
import { formatDate } from '../lib/format'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBlock, LoadingBlock, StatusBadge } from '../components/ui'
import { useToast } from '../components/Toast'

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'You declined the Google permission request.',
  missing_code: 'Google did not return an authorisation code.',
  expired_state: 'The connection request expired. Please try again.',
  forbidden: 'You are no longer a member of this workspace.',
  exchange_failed: 'Google rejected the token exchange. Check your client ID and secret.',
  no_email: 'Could not read the email address from that Google account.',
}

export default function Mailboxes() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => api.get<{ accounts: MailAccount[]; googleConfigured: boolean }>('/mail-accounts'),
  })

  // Surface the result of the OAuth redirect, then clean the URL.
  useEffect(() => {
    const connected = params.get('connected')
    const oauthError = params.get('error')

    if (connected) {
      toast.success(`${connected} connected`, 'You can now use this mailbox in campaigns.')
      void queryClient.invalidateQueries({ queryKey: ['mail-accounts'] })
      setParams({}, { replace: true })
    } else if (oauthError) {
      toast.error('Connection failed', OAUTH_ERRORS[oauthError] ?? oauthError)
      setParams({}, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  const connect = useMutation({
    mutationFn: () => api.get<{ url: string }>('/mail-accounts/oauth/url'),
    onSuccess: (result) => {
      window.location.href = result.url
    },
    onError: (err) => toast.error('Cannot start connection', err instanceof ApiError ? err.message : undefined),
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['mail-accounts'] })

  const test = useMutation({
    mutationFn: (id: string) => api.post<{ email: string }>(`/mail-accounts/${id}/test`),
    onSuccess: (result) => {
      toast.success('Connection healthy', result.email)
      invalidate()
    },
    onError: (err) => toast.error('Connection test failed', err instanceof ApiError ? err.message : undefined),
  })

  const setDefault = useMutation({
    mutationFn: (id: string) => api.post(`/mail-accounts/${id}/default`),
    onSuccess: () => {
      toast.success('Default mailbox updated')
      invalidate()
    },
    onError: (err) => toast.error('Could not update', err instanceof ApiError ? err.message : undefined),
  })

  const disconnect = useMutation({
    mutationFn: (id: string) => api.delete(`/mail-accounts/${id}`),
    onSuccess: () => {
      toast.success('Mailbox disconnected')
      invalidate()
    },
    onError: (err) => toast.error('Could not disconnect', err instanceof ApiError ? err.message : undefined),
  })

  if (isLoading) return <LoadingBlock />
  if (error) return <ErrorBlock message={error instanceof ApiError ? error.message : 'Failed to load'} onRetry={refetch} />

  const accounts = data?.accounts ?? []
  const configured = data?.googleConfigured ?? false

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Campaigns create drafts and replies inside the Gmail account you connect here."
        actions={
          <Button variant="primary" icon={<Plug className="h-4 w-4" />} loading={connect.isPending} disabled={!configured} onClick={() => connect.mutate()}>
            Connect Gmail
          </Button>
        }
      />

      {!configured && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            <p className="font-medium">Google OAuth is not configured yet</p>
            <p className="mt-1 text-amber-800">
              Add your Google Cloud OAuth client under{' '}
              <Link to="/settings" className="font-medium underline underline-offset-2 hover:text-amber-950">
                Workspace settings → Google OAuth
              </Link>
              . You will need a Client ID and Client Secret from the Google Cloud Console; the redirect URI to
              register there is shown on that screen.
            </p>
          </div>
        </div>
      )}

      {accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Mail className="h-6 w-6" />}
            title="No mailbox connected"
            description="Connect the Gmail account you send outreach from. Tokens are encrypted before they touch the database."
            action={
              <Button variant="primary" size="sm" icon={<Plug className="h-4 w-4" />} disabled={!configured} onClick={() => connect.mutate()}>
                Connect Gmail
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {accounts.map((account) => (
            <Card key={account.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {account.email}
                    {account.isDefault && (
                      <Badge tone="brand">
                        <Star className="h-3 w-3" />
                        default
                      </Badge>
                    )}
                  </span>
                }
                description={account.name ?? undefined}
                action={<StatusBadge status={account.status} />}
              />

              <div className="space-y-2 p-5 text-sm">
                <div className="flex items-center gap-2 text-ink-600">
                  {account.status === 'ACTIVE' ? (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-warning" />
                  )}
                  {account.status === 'ACTIVE' ? 'Ready to send' : 'Reconnect required'}
                </div>
                <p className="text-xs text-ink-500">Connected {formatDate(account.createdAt)}</p>
                {account._count?.campaigns ? (
                  <p className="text-xs text-ink-500">Used by {account._count.campaigns} campaign(s)</p>
                ) : null}
                {account.lastError && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" title={account.lastError}>
                    {account.lastError.slice(0, 180)}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2 border-t border-ink-200 px-5 py-3">
                <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={test.isPending} onClick={() => test.mutate(account.id)}>
                  Test
                </Button>
                {account.status !== 'ACTIVE' && (
                  <Button size="sm" variant="primary" icon={<Plug className="h-3.5 w-3.5" />} onClick={() => connect.mutate()}>
                    Reconnect
                  </Button>
                )}
                {!account.isDefault && (
                  <Button size="sm" icon={<Star className="h-3.5 w-3.5" />} onClick={() => setDefault.mutate(account.id)}>
                    Make default
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-danger"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => {
                    if (confirm(`Disconnect ${account.email}?`)) disconnect.mutate(account.id)
                  }}
                >
                  Disconnect
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
