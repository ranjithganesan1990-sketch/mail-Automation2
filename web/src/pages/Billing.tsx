import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, CreditCard, ExternalLink, FileText, Sparkles } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { formatDate, formatNumber } from '../lib/format'
import { useAuth } from '../lib/auth'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Card, CardHeader, LoadingBlock, ProgressBar } from '../components/ui'
import { useToast } from '../components/Toast'

interface PlanCard {
  id: string
  name: string
  description: string
  amount: number
  currency: string
  features: string[]
  popular: boolean
  maxContacts: number
  maxDailyDrafts: number
  maxMailAccounts: number
  maxCampaigns: number
  available: boolean
}

interface BillingResponse {
  plan: { id: string; name: string }
  subscription: {
    status: string | null
    currentPeriodEnd: string | null
    cancelAtPeriodEnd: boolean
    hasSubscription: boolean
  }
  limits: { maxContacts: number; maxDailyDrafts: number; maxMailAccounts: number; maxCampaigns: number }
  usage: { contacts: number; campaigns: number; mailAccounts: number; draftsToday: number }
  plans: PlanCard[]
  stripeConfigured: boolean
}

interface Invoice {
  id: string
  number: string | null
  status: string | null
  total: number
  currency: string
  created: string
  pdf: string | null
  hostedUrl: string | null
}

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 0 }).format(
    amount / 100,
  )

export default function Billing() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { activeOrg } = useAuth()
  const [params, setParams] = useSearchParams()

  const { data, isLoading } = useQuery({
    queryKey: ['billing'],
    queryFn: () => api.get<BillingResponse>('/billing'),
  })

  const { data: invoiceData } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get<{ invoices: Invoice[] }>('/billing/invoices'),
  })

  // Stripe redirects back here after checkout; the subscription itself is
  // applied by the webhook, so refetch rather than trusting the URL.
  useEffect(() => {
    const checkout = params.get('checkout')
    if (checkout === 'success') {
      toast.success('Payment received', 'Your new plan activates within a few seconds.')
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['billing'] }), 2500)
      setParams({}, { replace: true })
    } else if (checkout === 'cancelled') {
      toast.info('Checkout cancelled', 'No changes were made to your plan.')
      setParams({}, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  const checkout = useMutation({
    mutationFn: (planId: string) => api.post<{ url: string }>('/billing/checkout', { planId }),
    onSuccess: (result) => {
      // Card details are entered on Stripe's hosted page, never here.
      window.location.href = result.url
    },
    onError: (err) => toast.error('Could not start checkout', err instanceof ApiError ? err.message : undefined),
  })

  const portal = useMutation({
    mutationFn: () => api.post<{ url: string }>('/billing/portal'),
    onSuccess: (result) => {
      window.location.href = result.url
    },
    onError: (err) => toast.error('Could not open billing portal', err instanceof ApiError ? err.message : undefined),
  })

  if (isLoading || !data) return <LoadingBlock />

  const isOwner = activeOrg?.role === 'OWNER'
  const currentPlanId = data.plan.id
  const { subscription, usage, limits } = data

  return (
    <>
      <PageHeader
        title="Plan & billing"
        description="Your subscription, usage against plan limits, and invoices."
        actions={
          subscription.hasSubscription && isOwner ? (
            <Button icon={<CreditCard className="h-4 w-4" />} loading={portal.isPending} onClick={() => portal.mutate()}>
              Manage subscription
            </Button>
          ) : undefined
        }
      />

      {!data.stripeConfigured && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            <p className="font-medium">Billing is not configured on the server</p>
            <p className="mt-1 text-amber-800">
              Add <code className="rounded bg-white px-1">STRIPE_SECRET_KEY</code>,{' '}
              <code className="rounded bg-white px-1">STRIPE_WEBHOOK_SECRET</code> and your price IDs to{' '}
              <code className="rounded bg-white px-1">server/.env</code>. Everything runs on the Free plan until then.
            </p>
          </div>
        </div>
      )}

      {subscription.status === 'past_due' && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-red-900">Your last payment failed</p>
            <p className="mt-1 text-red-800">Update your payment method to keep your plan active.</p>
          </div>
          {isOwner && (
            <Button size="sm" variant="danger" onClick={() => portal.mutate()}>
              Update payment
            </Button>
          )}
        </div>
      )}

      {/* Current plan + usage */}
      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Current plan
              <Badge tone="brand">{data.plan.name}</Badge>
              {subscription.cancelAtPeriodEnd && <Badge tone="warning">cancels at period end</Badge>}
            </span>
          }
          description={
            subscription.currentPeriodEnd
              ? `${subscription.cancelAtPeriodEnd ? 'Access ends' : 'Renews'} on ${formatDate(subscription.currentPeriodEnd)}`
              : 'No paid subscription — you are on the Free plan.'
          }
        />
        <div className="grid gap-5 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <UsageMeter label="Contacts" used={usage.contacts} limit={limits.maxContacts} />
          <UsageMeter label="Campaigns" used={usage.campaigns} limit={limits.maxCampaigns} />
          <UsageMeter label="Mailboxes" used={usage.mailAccounts} limit={limits.maxMailAccounts} />
          <UsageMeter label="Emails today" used={usage.draftsToday} limit={limits.maxDailyDrafts} />
        </div>
      </Card>

      {/* Plans */}
      <h2 className="mb-3 text-sm font-semibold text-ink-900">Available plans</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.plans.map((plan) => {
          const isCurrent = plan.id === currentPlanId
          const isFree = plan.id === 'free'

          return (
            <Card
              key={plan.id}
              className={`relative flex h-full flex-col p-5 ${plan.popular && !isCurrent ? 'border-brand-400 ring-1 ring-brand-200' : ''}`}
            >
              {plan.popular && !isCurrent && (
                <span className="absolute -top-2.5 left-5 inline-flex items-center gap-1 rounded-full bg-brand-500 px-2 py-0.5 text-[11px] font-medium text-white">
                  <Sparkles className="h-3 w-3" />
                  Most popular
                </span>
              )}

              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-ink-900">{plan.name}</h3>
                {isCurrent && <Badge tone="success">current</Badge>}
              </div>

              <p className="mt-1 text-xs text-ink-500">{plan.description}</p>

              <p className="mt-4 text-3xl font-semibold tracking-tight text-ink-900">
                {isFree ? 'Free' : money(plan.amount, plan.currency)}
                {!isFree && <span className="text-sm font-normal text-ink-500">/mo</span>}
              </p>

              <ul className="mt-4 flex-1 space-y-2">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-ink-600">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    {feature}
                  </li>
                ))}
              </ul>

              <div className="mt-5">
                {isCurrent ? (
                  <Button className="w-full" disabled>
                    Your plan
                  </Button>
                ) : isFree ? (
                  <Button
                    className="w-full"
                    disabled={!isOwner || !subscription.hasSubscription}
                    onClick={() => portal.mutate()}
                    title={subscription.hasSubscription ? 'Cancel from the billing portal' : undefined}
                  >
                    Downgrade
                  </Button>
                ) : (
                  <Button
                    variant={plan.popular ? 'primary' : 'secondary'}
                    className="w-full"
                    disabled={!isOwner || !plan.available || !data.stripeConfigured}
                    loading={checkout.isPending && checkout.variables === plan.id}
                    onClick={() => checkout.mutate(plan.id)}
                    title={!plan.available ? 'No Stripe price configured for this plan' : undefined}
                  >
                    {subscription.hasSubscription ? 'Switch plan' : 'Upgrade'}
                  </Button>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      {!isOwner && <p className="mt-4 text-sm text-ink-500">Only the workspace owner can change the plan.</p>}

      {/* Invoices */}
      {(invoiceData?.invoices.length ?? 0) > 0 && (
        <Card className="mt-6">
          <CardHeader title="Invoices" description="Your most recent charges" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Invoice</th>
                  <th className="th">Date</th>
                  <th className="th">Amount</th>
                  <th className="th">Status</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {invoiceData!.invoices.map((invoice) => (
                  <tr key={invoice.id} className="transition hover:bg-ink-50">
                    <td className="td font-medium text-ink-900">{invoice.number ?? invoice.id.slice(0, 14)}</td>
                    <td className="td text-ink-500">{formatDate(invoice.created)}</td>
                    <td className="td">{money(invoice.total, invoice.currency)}</td>
                    <td className="td">
                      <Badge tone={invoice.status === 'paid' ? 'success' : invoice.status === 'open' ? 'warning' : 'neutral'}>
                        {invoice.status ?? 'unknown'}
                      </Badge>
                    </td>
                    <td className="td">
                      {invoice.hostedUrl && (
                        <a
                          href={invoice.hostedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-brand-600 hover:text-brand-700"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          View
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const percent = limit > 0 ? (used / limit) * 100 : 0
  const tone = percent >= 100 ? 'danger' : percent >= 80 ? 'warning' : 'brand'

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
        <p className="text-xs text-ink-500">{Math.min(100, Math.round(percent))}%</p>
      </div>
      <p className="mb-2 mt-1 text-lg font-semibold text-ink-900">
        {formatNumber(used)}
        <span className="text-sm font-normal text-ink-400"> / {formatNumber(limit)}</span>
      </p>
      <ProgressBar value={used} max={limit} tone={tone} />
    </div>
  )
}
