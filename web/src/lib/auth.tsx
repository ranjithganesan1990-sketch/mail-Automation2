import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, orgStore, tokenStore } from './api'
import type { Org, User } from './types'

interface AuthState {
  user: User | null
  orgs: Org[]
  activeOrg: Org | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (input: { name: string; email: string; password: string; workspaceName?: string }) => Promise<void>
  logout: () => void
  switchOrg: (orgId: string) => void
  refresh: () => Promise<void>
  setUser: (user: User) => void
}

const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

interface MeResponse {
  user: User
  orgs: Org[]
}

interface SessionResponse {
  token: string
  user: User
  org: Org | null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [orgs, setOrgs] = useState<Org[]>([])
  const [activeOrgId, setActiveOrgId] = useState<string | null>(orgStore.get())
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setUser(null)
      setOrgs([])
      setLoading(false)
      return
    }

    try {
      const data = await api.get<MeResponse>('/auth/me')
      setUser(data.user)
      setOrgs(data.orgs)

      // Fall back to the first workspace if the stored one is gone.
      const stored = orgStore.get()
      const valid = data.orgs.find((o) => o.id === stored) ?? data.orgs[0] ?? null
      if (valid) {
        orgStore.set(valid.id)
        setActiveOrgId(valid.id)
      }
    } catch {
      tokenStore.clear()
      orgStore.clear()
      setUser(null)
      setOrgs([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const applySession = useCallback((data: SessionResponse) => {
    tokenStore.set(data.token)
    setUser(data.user)
    if (data.org) {
      orgStore.set(data.org.id)
      setActiveOrgId(data.org.id)
      setOrgs([data.org])
    }
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      const data = await api.post<SessionResponse>('/auth/login', { email, password })
      applySession(data)
      await refresh()
    },
    [applySession, refresh],
  )

  const register = useCallback(
    async (input: { name: string; email: string; password: string; workspaceName?: string }) => {
      const data = await api.post<SessionResponse>('/auth/register', input)
      applySession(data)
      await refresh()
    },
    [applySession, refresh],
  )

  const logout = useCallback(() => {
    tokenStore.clear()
    orgStore.clear()
    setUser(null)
    setOrgs([])
    setActiveOrgId(null)
  }, [])

  const switchOrg = useCallback((orgId: string) => {
    orgStore.set(orgId)
    setActiveOrgId(orgId)
    // Simplest correct way to drop every cached query for the old workspace.
    window.location.reload()
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      user,
      orgs,
      activeOrg: orgs.find((o) => o.id === activeOrgId) ?? orgs[0] ?? null,
      loading,
      login,
      register,
      logout,
      switchOrg,
      refresh,
      setUser,
    }),
    [user, orgs, activeOrgId, loading, login, register, logout, switchOrg, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
