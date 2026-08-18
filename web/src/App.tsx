import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { LoadingBlock } from './components/ui'
import Layout from './components/Layout'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Campaigns from './pages/Campaigns'
import CampaignDetail from './pages/CampaignDetail'
import Templates from './pages/Templates'
import TemplateEditor from './pages/TemplateEditor'
import Contacts from './pages/Contacts'
import Activity from './pages/Activity'
import Mailboxes from './pages/Mailboxes'
import Settings from './pages/Settings'
import Team from './pages/Team'
import Attachments from './pages/Attachments'
import Billing from './pages/Billing'

export default function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingBlock label="Loading your workspace…" />
      </div>
    )
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/campaigns/:id" element={<CampaignDetail />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/templates/new" element={<TemplateEditor />} />
        <Route path="/templates/:id" element={<TemplateEditor />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/attachments" element={<Attachments />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/mailboxes" element={<Mailboxes />} />
        <Route path="/settings/team" element={<Team />} />
        <Route path="/settings/billing" element={<Billing />} />
      </Route>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/register" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
