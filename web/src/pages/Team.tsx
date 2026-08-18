import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Trash2, UserPlus } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { Member, Role } from '../lib/types'
import { formatDate } from '../lib/format'
import { useAuth } from '../lib/auth'
import PageHeader from '../components/PageHeader'
import { Avatar, Badge, Button, Card, Field, Input, LoadingBlock, Modal, Select } from '../components/ui'
import { useToast } from '../components/Toast'

const ROLE_HELP: Record<Role, string> = {
  OWNER: 'Full control, including billing and ownership transfer.',
  ADMIN: 'Manage campaigns, mailboxes, settings and teammates.',
  MEMBER: 'Create and run campaigns; cannot change workspace settings.',
}

export default function Team() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { user, activeOrg } = useAuth()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<{ members: Member[] }>('/orgs/members'),
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['members'] })

  const invite = useMutation({
    mutationFn: (body: { email: string; name?: string; role: Role }) =>
      api.post<{ member: Member; temporaryPassword: string | null }>('/orgs/members', body),
    onSuccess: (result, variables) => {
      setInviteOpen(false)
      invalidate()
      if (result.temporaryPassword) {
        setTempPassword({ email: variables.email, password: result.temporaryPassword })
      } else {
        toast.success('Teammate added', `${variables.email} now has access.`)
      }
    },
    onError: (err) => toast.error('Could not add teammate', err instanceof ApiError ? err.message : undefined),
  })

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.patch(`/orgs/members/${id}`, { role }),
    onSuccess: () => {
      toast.success('Role updated')
      invalidate()
    },
    onError: (err) => toast.error('Could not update role', err instanceof ApiError ? err.message : undefined),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/members/${id}`),
    onSuccess: () => {
      toast.success('Member removed')
      invalidate()
    },
    onError: (err) => toast.error('Could not remove member', err instanceof ApiError ? err.message : undefined),
  })

  if (isLoading) return <LoadingBlock />

  const members = data?.members ?? []
  const canManage = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN'

  return (
    <>
      <PageHeader
        title="Team"
        description={`People with access to ${activeOrg?.name ?? 'this workspace'}.`}
        actions={
          canManage ? (
            <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setInviteOpen(true)}>
              Add teammate
            </Button>
          ) : undefined
        }
      />

      <Card>
        <ul className="divide-y divide-ink-100">
          {members.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <Avatar name={member.user.name} color={member.user.avatarColor} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-900">
                  {member.user.name}
                  {member.user.id === user?.id && <span className="ml-2 text-xs text-ink-400">you</span>}
                </p>
                <p className="truncate text-xs text-ink-500">{member.user.email}</p>
              </div>

              <span className="hidden text-xs text-ink-400 sm:block">joined {formatDate(member.createdAt)}</span>

              {canManage && member.user.id !== user?.id ? (
                <Select
                  value={member.role}
                  onChange={(e) => changeRole.mutate({ id: member.id, role: e.target.value as Role })}
                  className="w-32"
                >
                  {(['OWNER', 'ADMIN', 'MEMBER'] as Role[]).map((role) => (
                    <option key={role} value={role}>
                      {role.charAt(0) + role.slice(1).toLowerCase()}
                    </option>
                  ))}
                </Select>
              ) : (
                <Badge tone={member.role === 'OWNER' ? 'brand' : 'neutral'}>{member.role.toLowerCase()}</Badge>
              )}

              {canManage && member.user.id !== user?.id && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => {
                    if (confirm(`Remove ${member.user.email} from this workspace?`)) remove.mutate(member.id)
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </Card>

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} onSubmit={(body) => invite.mutate(body)} loading={invite.isPending} />

      {/* Shown once — the server never stores or re-sends this password. */}
      <Modal
        open={Boolean(tempPassword)}
        onClose={() => setTempPassword(null)}
        title="Account created"
        description="Share these credentials with your teammate. They will not be shown again."
        footer={
          <Button variant="primary" onClick={() => setTempPassword(null)}>
            Done
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="rounded-lg bg-ink-50 p-4">
            <p className="text-xs uppercase tracking-wide text-ink-500">Email</p>
            <p className="font-mono text-sm text-ink-900">{tempPassword?.email}</p>
            <p className="mt-3 text-xs uppercase tracking-wide text-ink-500">Temporary password</p>
            <p className="font-mono text-sm text-ink-900">{tempPassword?.password}</p>
          </div>
          <p className="flex items-start gap-2 text-xs text-ink-500">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Ask them to change it from Settings once they sign in.
          </p>
        </div>
      </Modal>
    </>
  )
}

function InviteModal({
  open,
  onClose,
  onSubmit,
  loading,
}: {
  open: boolean
  onClose: () => void
  onSubmit: (body: { email: string; name?: string; role: Role }) => void
  loading: boolean
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('MEMBER')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add teammate"
      description="If they don't have an account yet, one is created for them."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={loading} disabled={!email.trim()} onClick={() => onSubmit({ email: email.trim(), name: name.trim() || undefined, role })}>
            Add teammate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Email address" required>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com" autoFocus />
        </Field>

        <Field label="Full name" hint="Used only if we need to create their account.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Kim" />
        </Field>

        <Field label="Role" hint={ROLE_HELP[role]}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {(['MEMBER', 'ADMIN', 'OWNER'] as Role[]).map((option) => (
              <option key={option} value={option}>
                {option.charAt(0) + option.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}
