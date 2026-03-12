export type SessionState = {
  needs_setup: boolean
  authenticated: boolean
  expires_at?: string | null
}

export type ImportRecord = {
  id: number
  filename: string
  original_filename: string
  provider: string
  status: string
  created_at: string
  finished_at?: string | null
  warning_count: number
  warnings: string[]
  summary: Record<string, number>
  error?: string | null
}

export type ConversationListItem = {
  id: number
  title: string
  provider: string
  created_at?: string | null
  updated_at?: string | null
  last_message_at?: string | null
  message_count: number
}

export type ConversationMessage = {
  id: number
  role: string
  author_name?: string | null
  model?: string | null
  created_at?: string | null
  sequence: number
  text: string
  metadata?: Record<string, unknown> | null
  attachments: ConversationAttachment[]
}

export type ConversationAttachment = {
  id: number
  filename: string
  mime_type?: string | null
  blob_path?: string | null
  sha256?: string | null
  metadata?: Record<string, unknown> | null
}

export type ConversationDetail = {
  id: number
  title: string
  provider: string
  created_at?: string | null
  updated_at?: string | null
  metadata?: Record<string, unknown> | null
  source_import?: {
    id: number
    original_filename: string
    provider: string
    status: string
    created_at: string
  } | null
  messages: ConversationMessage[]
}

export type DashboardData = {
  conversation_count: number
  message_count: number
  import_count: number
  providers: Array<{ provider: string; count: number }>
  recent_imports: ImportRecord[]
  recent_conversations: ConversationListItem[]
}

const jsonHeaders = {
  'Content-Type': 'application/json',
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: 'Request failed.' }))
    throw new Error(payload.detail ?? 'Request failed.')
  }

  return response.json() as Promise<T>
}

export const api = {
  getSession: () => request<SessionState>('/api/auth/session'),
  setupPassword: (password: string) =>
    request('/api/auth/setup', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ password }),
    }),
  login: (password: string) =>
    request('/api/auth/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ password }),
    }),
  logout: () =>
    request('/api/auth/logout', {
      method: 'POST',
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('/api/auth/change-password', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
  getDashboard: () => request<DashboardData>('/api/dashboard'),
  listImports: async () => (await request<{ items: ImportRecord[] }>('/api/imports')).items,
  uploadImport: async (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return request<{ id: number; status: string; filename: string }>('/api/imports', {
      method: 'POST',
      body: formData,
    })
  },
  listConversations: async (provider?: string, limit = 50, offset = 0) => {
    const params = new URLSearchParams()
    if (provider) params.set('provider', provider)
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    return (await request<{ items: ConversationListItem[] }>(`/api/conversations?${params}`)).items
  },
  searchConversations: async (query: string, provider?: string, limit = 50) => {
    const params = new URLSearchParams({ q: query })
    if (provider) params.set('provider', provider)
    params.set('limit', String(limit))
    return (await request<{ items: Array<ConversationListItem & { snippet: string }> }>(`/api/search?${params}`)).items
  },
  getConversation: (id: string) => request<ConversationDetail>(`/api/conversations/${id}`),
}
