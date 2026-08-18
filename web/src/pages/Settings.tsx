import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Save, Send, Trash2 } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { GoogleOAuthSettings, OrgSettings, Role } from '../lib/types'
import { formatNumber } from '../lib/format'
import { useAuth } from '../lib/auth'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Card, CardHeader, Field, Input, LoadingBlock, Select, Toggle } from '../components/ui'
import { useToast } from '../components/Toast'

interface CurrentOrgResponse {
  org: OrgSettings
  role: Role
  usage: { campaigns: number; contacts: number; templates: number; mailAccounts: number }
}

// A short, practical list; any valid IANA zone is accepted by the API.
const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
]

export default function Settings() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { user, setUser } = useAuth()

  const { data, isLoading } = useQuery({
    queryKey: ['org-current'],
    queryFn: () => api.get<CurrentOrgResponse>('/orgs/current'),
  })

  const [form, setForm] = useState<Partial<OrgSettings>>({})

  useEffect(() => {
    if (data?.org) setForm(data.org)
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api.patch('/orgs/current', {
        name: form.name,
        timezone: form.timezone,
        dailyRunHour: form.dailyRunHour,
        dailyRunMinute: form.dailyRunMinute,
        automationOn: form.automationOn,
        sendDailyDigest: form.sendDailyDigest,
        digestEmail: form.digestEmail || null,
        autoCleanBounce: form.autoCleanBounce,
        maxDailyDrafts: form.maxDailyDrafts,
      }),
    onSuccess: () => {
      toast.success('Settings saved')
      void queryClient.invalidateQueries({ queryKey: ['org-current'] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (err) => toast.error('Could not save settings', err instanceof ApiError ? err.message : undefined),
  })

  const sendDigest = useMutation({
    mutationFn: () => api.post('/runs/automation/digest'),
    onSuccess: () => toast.success('Digest sent', 'Check the inbox of your default mailbox.'),
    onError: (err) => toast.error('Could not send digest', err instanceof ApiError ? err.message : undefined),
  })

  if (isLoading || !data) return <LoadingBlock />

  const canEdit = data.role === 'OWNER' || data.role === 'ADMIN'

  return (
    <>
      <PageHeader
        title="Workspace settings"
        description="Automation timing, notifications and sending limits."
        actions={
          canEdit ? (
            <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate()}>
              Save changes
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="General" />
            <div className="space-y-4 p-5">
              <Field label="Workspace name">
                <Input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!canEdit} />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Daily automation"
              description="Steps whose scheduled date is today are queued at this time — the replacement for the 6:30 AM script trigger."
            />
            <div className="space-y-4 p-5">
              <Toggle
                checked={form.automationOn ?? true}
                onChange={(value) => setForm({ ...form, automationOn: value })}
                label="Run automation daily"
                description="Turn off to pause all scheduled runs without losing your dates."
                disabled={!canEdit}
              />

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Timezone">
                  <Select value={form.timezone ?? 'UTC'} onChange={(e) => setForm({ ...form, timezone: e.target.value })} disabled={!canEdit}>
                    {TIMEZONES.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone.replace('_', ' ')}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Hour">
                  <Select
                    value={String(form.dailyRunHour ?? 6)}
                    onChange={(e) => setForm({ ...form, dailyRunHour: Number(e.target.value) })}
                    disabled={!canEdit}
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {String(i).padStart(2, '0')}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Minute">
                  <Select
                    value={String(form.dailyRunMinute ?? 30)}
                    onChange={(e) => setForm({ ...form, dailyRunMinute: Number(e.target.value) })}
                    disabled={!canEdit}
                  >
                    {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((minute) => (
                      <option key={minute} value={minute}>
                        {String(minute).padStart(2, '0')}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <Toggle
                checked={form.autoCleanBounce ?? true}
                onChange={(value) => setForm({ ...form, autoCleanBounce: value })}
                label="Scan for bounces daily"
                description="Reads delivery-failure notices and suppresses the addresses that actually bounced."
                disabled={!canEdit}
              />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Daily digest"
              description="An executive summary emailed after the day's runs finish."
              action={
                <Button size="sm" icon={<Send className="h-4 w-4" />} loading={sendDigest.isPending} onClick={() => sendDigest.mutate()}>
                  Send now
                </Button>
              }
            />
            <div className="space-y-4 p-5">
              <Toggle
                checked={form.sendDailyDigest ?? true}
                onChange={(value) => setForm({ ...form, sendDailyDigest: value })}
                label="Send the daily digest"
                description="Skipped automatically on days with no activity and no errors."
                disabled={!canEdit}
              />

              <Field label="Send digest to" hint="Leave blank to use your default mailbox address.">
                <Input
                  type="email"
                  value={form.digestEmail ?? ''}
                  onChange={(e) => setForm({ ...form, digestEmail: e.target.value })}
                  placeholder="team@company.com"
                  disabled={!canEdit}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Sending limits" description="A safety ceiling so a bad import cannot burn your Gmail quota." />
            <div className="p-5">
              <Field label="Maximum emails per day" hint="Runs pause when this is reached and resume the next day.">
                <Input
                  type="number"
                  min={1}
                  max={20000}
                  value={form.maxDailyDrafts ?? 500}
                  onChange={(e) => setForm({ ...form, maxDailyDrafts: Number(e.target.value) })}
                  disabled={!canEdit}
                />
              </Field>
            </div>
          </Card>

          <GoogleOAuthCard />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Usage" />
            <dl className="divide-y divide-ink-100">
              {[
                { label: 'Campaigns', value: data.usage.campaigns },
                { label: 'Contacts', value: `${formatNumber(data.usage.contacts)} / ${formatNumber(data.org.maxContacts)}` },
                { label: 'Templates', value: data.usage.templates },
                { label: 'Mailboxes', value: `${data.usage.mailAccounts} / ${data.org.maxMailAccounts}` },
                { label: 'Plan', value: data.org.planId },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between px-5 py-3">
                  <dt className="text-sm text-ink-600">{row.label}</dt>
                  <dd className="text-sm font-medium text-ink-900">{row.value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <ProfileCard name={user?.name ?? ''} onSaved={setUser} />
        </div>
      </div>
    </>
  )
}

/**
 * Instance-wide Google OAuth credentials.
 *
 * The API restricts this to the instance owner, so a 403 is the expected
 * answer for everyone else — the card simply does not render for them
 * rather than showing a form that cannot be saved.
 */
function GoogleOAuthCard() {
  const toast = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['settings-google'],
    queryFn: () => api.get<GoogleOAuthSettings>('/settings/google'),
    retry: false,
  })

  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState('')

  useEffect(() => {
    if (!data) return
    setClientId(data.clientId)
    setRedirectUri(data.redirectUri)
    setClientSecret('')
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api.put<GoogleOAuthSettings>('/settings/google', {
        clientId: clientId.trim(),
        // Sending nothing keeps the stored secret; sending a value replaces it.
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        redirectUri: redirectUri.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Google OAuth saved', 'New connections use these credentials right away — no restart needed.')
      setClientSecret('')
      void queryClient.invalidateQueries({ queryKey: ['settings-google'] })
      void queryClient.invalidateQueries({ queryKey: ['mail-accounts'] })
    },
    onError: (err) => toast.error('Could not save', err instanceof ApiError ? err.message : undefined),
  })

  const clear = useMutation({
    mutationFn: () => api.delete<GoogleOAuthSettings>('/settings/google'),
    onSuccess: () => {
      toast.success('Credentials removed')
      setClientSecret('')
      void queryClient.invalidateQueries({ queryKey: ['settings-google'] })
      void queryClient.invalidateQueries({ queryKey: ['mail-accounts'] })
    },
    onError: (err) => toast.error('Could not remove', err instanceof ApiError ? err.message : undefined),
  })

  // Not the instance owner, or the endpoint is unavailable — stay out of the way.
  if (error) return null
  if (isLoading || !data) return null

  const sourceBadge =
    data.source === 'database' ? (
      <Badge tone="success">Saved here</Badge>
    ) : data.source === 'env' ? (
      <Badge tone="info">From server/.env</Badge>
    ) : (
      <Badge tone="warning">Not configured</Badge>
    )

  const redirectMismatch = data.redirectUri !== data.expectedRedirectUri

  return (
    <Card>
      <CardHeader
        title="Google OAuth"
        description="The Google Cloud OAuth client used to connect Gmail mailboxes. Only the instance owner can change this."
        action={sourceBadge}
      />
      <div className="space-y-4 p-5">
        <div className="rounded-xl border border-ink-200 bg-ink-50 px-4 py-3 text-sm text-ink-700">
          <p className="font-medium text-ink-900">Register this redirect URI in Google Cloud first</p>
          <p className="mt-1">
            APIs &amp; Services → Credentials → your OAuth client → Authorised redirect URIs. It must match
            character for character.
          </p>
          <code className="mt-2 block break-all rounded-lg bg-white px-2 py-1.5 text-xs text-ink-900 ring-1 ring-inset ring-ink-200">
            {data.expectedRedirectUri}
          </code>
        </div>

        <Field label="Client ID" hint="Ends with .apps.googleusercontent.com">
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="1234567890-abc123.apps.googleusercontent.com"
            spellCheck={false}
          />
        </Field>

        <Field
          label="Client Secret"
          hint={
            data.secretSet
              ? 'A secret is already stored. Leave this blank to keep it, or paste a new one to replace it.'
              : 'Required. Encrypted before it is stored, with the same key that protects your mailbox tokens.'
          }
        >
          <Input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={data.secretSet ? '•••••••••••••••• (unchanged)' : 'GOCSPX-…'}
            autoComplete="new-password"
            spellCheck={false}
          />
        </Field>

        <Field
          label="Redirect URI"
          hint={redirectMismatch ? undefined : 'Matches the value Google should be configured with.'}
          error={
            redirectMismatch
              ? `This differs from what this server expects (${data.expectedRedirectUri}). OAuth will fail with redirect_uri_mismatch unless Google is configured with the value below.`
              : undefined
          }
        >
          <Input
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder={data.expectedRedirectUri}
            spellCheck={false}
          />
        </Field>

        {data.source === 'env' && (
          <p className="text-xs text-ink-500">
            Values from <code className="rounded bg-ink-100 px-1">server/.env</code> are in use. Saving here
            overrides them without touching the file.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            variant="primary"
            icon={<KeyRound className="h-4 w-4" />}
            loading={save.isPending}
            disabled={!clientId.trim() || (!data.secretSet && !clientSecret.trim())}
            onClick={() => save.mutate()}
          >
            Save credentials
          </Button>

          {data.secretInDatabase && (
            <Button
              icon={<Trash2 className="h-4 w-4" />}
              loading={clear.isPending}
              onClick={() => {
                if (confirm('Remove the stored Google credentials? Connecting new mailboxes will stop working until you add them again.')) {
                  clear.mutate()
                }
              }}
            >
              Remove
            </Button>
          )}
        </div>

        <p className="text-xs text-ink-500">
          Already-connected mailboxes keep working only while these credentials stay valid — they are what
          refreshes each mailbox&apos;s access token. Replacing them with a different Google Cloud project
          requires reconnecting every mailbox.
        </p>
      </div>
    </Card>
  )
}

function ProfileCard({ name, onSaved }: { name: string; onSaved: (user: never) => void }) {
  const toast = useToast()
  const [value, setValue] = useState(name)
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' })

  useEffect(() => setValue(name), [name])

  const saveProfile = useMutation({
    mutationFn: () => api.patch<{ user: never }>('/auth/profile', { name: value.trim() }),
    onSuccess: (result) => {
      toast.success('Profile updated')
      onSaved(result.user)
    },
    onError: (err) => toast.error('Could not update profile', err instanceof ApiError ? err.message : undefined),
  })

  const changePassword = useMutation({
    mutationFn: () => api.post('/auth/change-password', passwords),
    onSuccess: () => {
      toast.success('Password changed')
      setPasswords({ currentPassword: '', newPassword: '' })
    },
    onError: (err) => toast.error('Could not change password', err instanceof ApiError ? err.message : undefined),
  })

  return (
    <Card>
      <CardHeader title="Your profile" />
      <div className="space-y-4 p-5">
        <Field label="Display name">
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Button size="sm" loading={saveProfile.isPending} disabled={!value.trim() || value === name} onClick={() => saveProfile.mutate()}>
          Update name
        </Button>

        <hr className="border-ink-200" />

        <Field label="Current password">
          <Input
            type="password"
            value={passwords.currentPassword}
            onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
            autoComplete="current-password"
          />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <Input
            type="password"
            value={passwords.newPassword}
            onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
            autoComplete="new-password"
          />
        </Field>
        <Button
          size="sm"
          loading={changePassword.isPending}
          disabled={!passwords.currentPassword || passwords.newPassword.length < 8}
          onClick={() => changePassword.mutate()}
        >
          Change password
        </Button>
      </div>
    </Card>
  )
}
