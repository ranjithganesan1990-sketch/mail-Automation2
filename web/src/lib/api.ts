const TOKEN_KEY = 'ma.token'
const ORG_KEY = 'ma.orgId'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

export const orgStore = {
  get: () => localStorage.getItem(ORG_KEY),
  set: (orgId: string) => localStorage.setItem(ORG_KEY, orgId),
  clear: () => localStorage.removeItem(ORG_KEY),
}

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  raw?: boolean
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)

  const token = tokenStore.get()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const orgId = orgStore.get()
  if (orgId) headers.set('X-Org-Id', orgId)

  let body: BodyInit | undefined
  if (options.body instanceof FormData) {
    body = options.body
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.body)
  }

  const response = await fetch(`/api${path}`, { ...options, headers, body })

  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') ?? ''

  if (!response.ok) {
    let message = response.statusText
    let code = 'error'
    let details: unknown

    if (contentType.includes('application/json')) {
      const payload = await response.json().catch(() => null)
      message = payload?.error ?? message
      code = payload?.code ?? code
      details = payload?.details
    }

    // An expired session should drop the user back to the sign-in screen.
    if (response.status === 401) {
      tokenStore.clear()
      orgStore.clear()
      if (!location.pathname.startsWith('/login')) location.href = '/login'
    }

    // 402 means a plan limit was hit; Layout listens for this and offers an upgrade.
    if (response.status === 402) {
      window.dispatchEvent(new CustomEvent('plan-limit', { detail: { message, details } }))
    }

    throw new ApiError(response.status, message, code, details)
  }

  if (options.raw) return (await response.blob()) as T
  if (contentType.includes('application/json')) return response.json() as Promise<T>
  return (await response.text()) as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  download: async (path: string, filename: string) => {
    const blob = await request<Blob>(path, { raw: true })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  },
}
