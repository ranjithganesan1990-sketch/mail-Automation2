import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import {
  Activity as ActivityIcon,
  ChevronDown,
  CreditCard,
  FileText,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Paperclip,
  Send,
  Settings as SettingsIcon,
  Users,
  UsersRound,
  X,
} from 'lucide-react'
import { useAuth } from '../lib/auth'
import { Avatar } from './ui'
import PlanLimitPrompt from './PlanLimitPrompt'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/campaigns', label: 'Campaigns', icon: Send },
  { to: '/templates', label: 'Templates', icon: FileText },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/attachments', label: 'Attachments', icon: Paperclip },
  { to: '/activity', label: 'Activity', icon: ActivityIcon },
]

const SETTINGS_NAV = [
  { to: '/settings', label: 'Workspace', icon: SettingsIcon, end: true },
  { to: '/settings/mailboxes', label: 'Mailboxes', icon: Mail },
  { to: '/settings/team', label: 'Team', icon: UsersRound },
  { to: '/settings/billing', label: 'Plan & billing', icon: CreditCard },
]

export default function Layout() {
  const { user, orgs, activeOrg, switchOrg, logout } = useAuth()
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [orgMenuOpen, setOrgMenuOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
    )

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 border-b border-ink-200 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-white">
          <Mail className="h-4.5 w-4.5" strokeWidth={2.2} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink-900">Mail Automation</p>
          <p className="truncate text-[11px] text-ink-500">Campaign engine</p>
        </div>
      </div>

      {/* Workspace switcher */}
      <div className="relative border-b border-ink-200 px-3 py-3">
        <button
          type="button"
          onClick={() => setOrgMenuOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-ink-200 px-3 py-2 text-left transition hover:bg-ink-50"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink-800">{activeOrg?.name ?? 'Workspace'}</p>
            <p className="text-[11px] uppercase tracking-wide text-ink-400">{activeOrg?.role ?? ''}</p>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-ink-400" />
        </button>

        {orgMenuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOrgMenuOpen(false)} />
            <div className="absolute left-3 right-3 top-[calc(100%-0.25rem)] z-20 rounded-lg border border-ink-200 bg-white py-1 shadow-pop">
              {orgs.map((org) => (
                <button
                  key={org.id}
                  type="button"
                  onClick={() => {
                    setOrgMenuOpen(false)
                    if (org.id !== activeOrg?.id) switchOrg(org.id)
                  }}
                  className={clsx(
                    'block w-full px-3 py-2 text-left text-sm transition hover:bg-ink-50',
                    org.id === activeOrg?.id ? 'font-medium text-brand-600' : 'text-ink-700',
                  )}
                >
                  {org.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={() => setMobileOpen(false)}>
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </NavLink>
        ))}

        <p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Settings</p>
        {SETTINGS_NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={() => setMobileOpen(false)}>
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="relative border-t border-ink-200 p-3">
        <button
          type="button"
          onClick={() => setUserMenuOpen((v) => !v)}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-ink-100"
        >
          <Avatar name={user?.name ?? '?'} color={user?.avatarColor} size={32} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink-800">{user?.name}</p>
            <p className="truncate text-xs text-ink-500">{user?.email}</p>
          </div>
        </button>

        {userMenuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
            <div className="absolute bottom-[calc(100%-0.5rem)] left-3 right-3 z-20 rounded-lg border border-ink-200 bg-white py-1 shadow-pop">
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 transition hover:bg-ink-50"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-ink-50">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-ink-200 bg-white lg:block">{sidebar}</aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-pop">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-2 top-4 rounded p-1 text-ink-400 hover:bg-ink-100"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-ink-200 bg-white/90 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-1.5 text-ink-600 hover:bg-ink-100"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold text-ink-900">Mail Automation</span>
        </header>

        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>

      <PlanLimitPrompt />
    </div>
  )
}
