import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { Button, Modal } from './ui'

interface PlanLimitDetail {
  message: string
  details?: { resource?: string; limit?: number; current?: number; plan?: string }
}

/**
 * Listens for the `plan-limit` event the API client fires on a 402 and offers
 * a route to the billing page, instead of leaving the user with a dead end.
 */
export default function PlanLimitPrompt() {
  const [detail, setDetail] = useState<PlanLimitDetail | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const onLimit = (event: Event) => {
      setDetail((event as CustomEvent<PlanLimitDetail>).detail)
    }
    window.addEventListener('plan-limit', onLimit)
    return () => window.removeEventListener('plan-limit', onLimit)
  }, [])

  const close = () => setDetail(null)

  return (
    <Modal
      open={Boolean(detail)}
      onClose={close}
      title="You've reached a plan limit"
      footer={
        <>
          <Button onClick={close}>Not now</Button>
          <Button
            variant="primary"
            icon={<Sparkles className="h-4 w-4" />}
            onClick={() => {
              close()
              navigate('/settings/billing')
            }}
          >
            See plans
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-700">{detail?.message}</p>

      {detail?.details?.limit !== undefined && (
        <div className="mt-4 rounded-lg bg-ink-50 px-4 py-3 text-sm">
          <div className="flex justify-between">
            <span className="text-ink-500">Current</span>
            <span className="font-medium text-ink-900">{detail.details.current?.toLocaleString()}</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span className="text-ink-500">Plan limit</span>
            <span className="font-medium text-ink-900">{detail.details.limit.toLocaleString()}</span>
          </div>
        </div>
      )}
    </Modal>
  )
}
