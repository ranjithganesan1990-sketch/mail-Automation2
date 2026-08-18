import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Campaign } from '../lib/types'
import PageHeader from '../components/PageHeader'
import ContactsPanel from '../components/ContactsPanel'

export default function Contacts() {
  const { data } = useQuery({
    queryKey: ['campaigns', 'ALL', ''],
    queryFn: () => api.get<{ campaigns: Campaign[] }>('/campaigns'),
  })

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Every column you import becomes a merge variable available in your templates."
      />
      <ContactsPanel campaigns={data?.campaigns ?? []} />
    </>
  )
}
