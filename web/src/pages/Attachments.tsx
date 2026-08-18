import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Paperclip, Trash2, Upload } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import type { Attachment } from '../lib/types'
import { formatBytes, formatDate } from '../lib/format'
import PageHeader from '../components/PageHeader'
import { Badge, Button, Card, EmptyState, LoadingBlock } from '../components/ui'
import { useToast } from '../components/Toast'

export default function Attachments() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['attachments'],
    queryFn: () => api.get<{ attachments: Attachment[] }>('/attachments'),
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['attachments'] })

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      return api.upload<{ attachment: Attachment }>('/attachments', form)
    },
    onSuccess: (result) => {
      toast.success('File uploaded', result.attachment.filename)
      invalidate()
    },
    onError: (err) => toast.error('Upload failed', err instanceof ApiError ? err.message : undefined),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/attachments/${id}`),
    onSuccess: () => {
      toast.success('Attachment deleted')
      invalidate()
    },
    onError: (err) => toast.error('Could not delete', err instanceof ApiError ? err.message : undefined),
  })

  const attachments = data?.attachments ?? []

  return (
    <>
      <PageHeader
        title="Attachments"
        description="Files you can attach to a campaign or to an individual step."
        actions={
          <Button variant="primary" icon={<Upload className="h-4 w-4" />} loading={upload.isPending} onClick={() => fileRef.current?.click()}>
            Upload file
          </Button>
        }
      />

      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) upload.mutate(file)
          e.target.value = ''
        }}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files?.[0]
          if (file) upload.mutate(file)
        }}
        className={`mb-6 rounded-xl border-2 border-dashed px-6 py-8 text-center transition ${
          dragging ? 'border-brand-400 bg-brand-50' : 'border-ink-300 bg-white'
        }`}
      >
        <Upload className="mx-auto h-8 w-8 text-ink-400" />
        <p className="mt-2 text-sm text-ink-600">Drop a file here to upload it (max 15 MB)</p>
      </div>

      {isLoading ? (
        <LoadingBlock />
      ) : attachments.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Paperclip className="h-6 w-6" />}
            title="No attachments yet"
            description="Upload a brochure, deck or price list and attach it to any campaign step."
          />
        </Card>
      ) : (
        <div className="table-wrap">
          <table className="w-full">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                <th className="th">File</th>
                <th className="th">Type</th>
                <th className="th">Size</th>
                <th className="th">In use</th>
                <th className="th">Uploaded</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {attachments.map((attachment) => {
                const uses = (attachment._count?.campaigns ?? 0) + (attachment._count?.steps ?? 0)
                return (
                  <tr key={attachment.id} className="transition hover:bg-ink-50">
                    <td className="td font-medium text-ink-900">
                      <span className="inline-flex items-center gap-2">
                        <Paperclip className="h-4 w-4 text-ink-400" />
                        {attachment.filename}
                      </span>
                    </td>
                    <td className="td text-ink-500">{attachment.mimeType}</td>
                    <td className="td">{formatBytes(attachment.size)}</td>
                    <td className="td">
                      {uses > 0 ? <Badge tone="brand">{uses} place(s)</Badge> : <span className="text-ink-400">—</span>}
                    </td>
                    <td className="td text-ink-500">{formatDate(attachment.createdAt)}</td>
                    <td className="td">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Download className="h-3.5 w-3.5" />}
                          onClick={() => api.download(`/attachments/${attachment.id}/download`, attachment.filename)}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger"
                          icon={<Trash2 className="h-3.5 w-3.5" />}
                          onClick={() => {
                            if (confirm(`Delete "${attachment.filename}"?`)) remove.mutate(attachment.id)
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
