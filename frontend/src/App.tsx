import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { marked } from 'marked'
import { api, type ConversationAttachment, type ConversationDetail, type ConversationListItem, type DashboardData, type ImportRecord, type SessionState } from './api'

// ── Marked config ──

marked.setOptions({
  gfm: true,
  breaks: true,
})

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string
}

// ── Time helpers ──

function timeAgo(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const now = Date.now()
  const diff = now - d.getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(months / 12)
  return `${years}y ago`
}

function formatDateFull(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatDateShort(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// ── App root ──

function App() {
  const [session, setSession] = useState<SessionState | null>(null)
  const [error, setError] = useState('')

  const refreshSession = async () => {
    try {
      setError('')
      setSession(await api.getSession())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server.')
    }
  }

  useEffect(() => {
    void refreshSession()
  }, [])

  if (!session) {
    return <FullScreenMessage title="Loading" message={error || 'Connecting to archive...'} />
  }

  if (session.needs_setup) {
    return <SetupPage onComplete={refreshSession} />
  }

  if (!session.authenticated) {
    return <LoginPage onLogin={refreshSession} />
  }

  return (
    <BrowserRouter>
      <ArchiveShell onLogout={refreshSession} />
    </BrowserRouter>
  )
}

function FullScreenMessage({ title, message }: { title: string; message: string }) {
  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <p className="panel-kicker">Chat Archive</p>
        <h1>{title}</h1>
        <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>{message}</p>
      </div>
    </div>
  )
}

function SetupPage({ onComplete }: { onComplete: () => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.setupPassword(password)
      await onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={onSubmit}>
        <p className="panel-kicker">First-run setup</p>
        <h1>Create password</h1>
        <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>Single-user, LAN-only. Minimum 12 characters.</p>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label>
          Confirm
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Set password'}</button>
      </form>
    </div>
  )
}

function LoginPage({ onLogin }: { onLogin: () => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.login(password)
      await onLogin()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={onSubmit}>
        <p className="panel-kicker">Chat Archive</p>
        <h1>Sign in</h1>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
      </form>
    </div>
  )
}

// ── SVG icons (inline, tiny) ──

const icons = {
  dashboard: <svg className="nav-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h5v6H2V2zm7 0h5v4H9V2zM2 10h5v4H2v-4zm7-2h5v6H9V8z"/></svg>,
  imports: <svg className="nav-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1v8.5m0 0L5 6.5m3 3L11 6.5M3 11v2h10v-2"/></svg>,
  conversations: <svg className="nav-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v8H5l-3 3V3z"/></svg>,
  settings: <svg className="nav-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 10a2 2 0 100-4 2 2 0 000 4zm6-1.5h-1.17a4.98 4.98 0 00-.42-1.01l.83-.83-1.5-1.5-.83.83a4.98 4.98 0 00-1.01-.42V4.5h-2v1.07c-.36.09-.7.23-1.01.42l-.83-.83-1.5 1.5.83.83c-.19.31-.33.65-.42 1.01H4v2h1.07c.09.36.23.7.42 1.01l-.83.83 1.5 1.5.83-.83c.31.19.65.33 1.01.42V13h2v-1.07c.36-.09.7-.23 1.01-.42l.83.83 1.5-1.5-.83-.83c.19-.31.33-.65.42-1.01H14v-2z"/></svg>,
  logout: <svg className="nav-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M6 2H3v12h3m4-6h5m0 0l-2-2m2 2l-2 2"/></svg>,
  back: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5"/></svg>,
}

function ArchiveShell({ onLogout }: { onLogout: () => Promise<void> }) {
  const navigate = useNavigate()

  const logout = async () => {
    await api.logout()
    await onLogout()
    navigate('/')
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>Chat Archive</h1>
          <p>Unified LLM export viewer</p>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/" end>{icons.conversations} Conversations</NavLink>
          <NavLink to="/imports">{icons.imports} Imports</NavLink>
          <NavLink to="/stats">{icons.dashboard} Stats</NavLink>
          <NavLink to="/settings">{icons.settings} Settings</NavLink>
        </nav>
        <div className="sidebar-footer">
          <button className="btn btn-ghost" type="button" onClick={() => void logout()} style={{ color: 'var(--sidebar-text)', width: '100%', justifyContent: 'flex-start' }}>
            {icons.logout} Log out
          </button>
        </div>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<ConversationsPage />} />
          <Route path="/conversations/:conversationId" element={<ConversationDetailPage />} />
          <Route path="/imports" element={<ImportsPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  )
}

// ── Dashboard ──

function StatsPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getDashboard().then(setData).catch((err: Error) => setError(err.message))
  }, [])

  if (error) return <PageState title="Stats" message={error} />
  if (!data) return <PageState title="Stats" message="Loading..." />

  const isEmpty = data.conversation_count === 0 && data.import_count === 0

  if (isEmpty) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h2>Stats</h2>
          </div>
        </header>
        <div className="onboarding-card">
          <div className="onboarding-icon">{icons.imports}</div>
          <h3>No data yet</h3>
          <p>Upload a ChatGPT, Claude, or Gemini export to start browsing your conversations.</p>
          <button className="btn btn-primary" type="button" onClick={() => navigate('/imports')}>
            Go to Imports
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page page-wide">
      <header className="page-header">
        <div>
          <h2>Stats</h2>
          <p className="page-desc">Archive overview across all providers</p>
        </div>
      </header>

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-value">{data.conversation_count.toLocaleString()}</div>
          <div className="stat-label">Conversations</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.message_count.toLocaleString()}</div>
          <div className="stat-label">Messages</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{data.import_count.toLocaleString()}</div>
          <div className="stat-label">Imports</div>
        </div>
      </div>

      <div className="two-col">
        <div className="panel">
          <div className="panel-header">
            <h3>Providers</h3>
          </div>
          <div className="panel-body">
            {data.providers.length ? (
              <ul className="provider-list">
                {data.providers.map((p) => (
                  <li key={p.provider} className="provider-row-link" onClick={() => navigate(`/?provider=${encodeURIComponent(p.provider)}`)}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <ProviderBadge provider={p.provider} />
                      {p.provider}
                    </span>
                    <span className="provider-count">{p.count.toLocaleString()} &rsaquo;</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state">No conversations yet</div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h3>Recent imports</h3>
          </div>
          <div className="panel-body">
            {data.recent_imports.length ? (
              <ImportList items={data.recent_imports} compact />
            ) : (
              <div className="empty-state">No imports yet</div>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Recent conversations</h3>
        </div>
        <div className="panel-body">
          {data.recent_conversations.length ? (
            <ConversationList items={data.recent_conversations} />
          ) : (
            <div className="empty-state">Import a provider export to get started</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Imports (with polling) ──

function ImportsPage() {
  const [imports, setImports] = useState<ImportRecord[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadImports = useCallback(async () => {
    try {
      const items = await api.listImports()
      setImports(items)
      setError('')
      return items
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load imports.')
      return []
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPolling = useCallback(() => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      const items = await loadImports()
      const hasPending = items.some((i) => i.status === 'processing' || i.status === 'queued')
      if (!hasPending) stopPolling()
    }, 2000)
  }, [loadImports, stopPolling])

  useEffect(() => {
    void loadImports()
    return stopPolling
  }, [loadImports, stopPolling])

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedFile) return
    setBusy(true)
    setError('')
    try {
      await api.uploadImport(selectedFile)
      setSelectedFile(null)
      // Reset the file input
      const fileInput = document.querySelector('.upload-zone input[type="file"]') as HTMLInputElement | null
      if (fileInput) fileInput.value = ''
      await loadImports()
      startPolling()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) setSelectedFile(file)
  }

  const hasPending = imports.some((i) => i.status === 'processing' || i.status === 'queued')

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Imports</h2>
          <p className="page-desc">Upload provider exports (.zip or .json)</p>
        </div>
      </header>

      <form onSubmit={onSubmit}>
        <div
          className={`upload-zone${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <label>
            <span className="upload-title">
              {selectedFile ? selectedFile.name : 'Drop file here or click to browse'}
            </span>
            <span className="upload-hint">ChatGPT, Claude, and Gemini exports supported</span>
            <input
              type="file"
              accept=".zip,.json"
              onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="upload-actions">
            <button className="btn btn-primary" type="submit" disabled={busy || !selectedFile}>
              {busy ? 'Uploading...' : 'Upload'}
            </button>
          </div>
        </div>
        {error && <p className="error-text" style={{ marginBottom: '1rem' }}>{error}</p>}
      </form>

      <div className="panel">
        <div className="panel-header">
          <h3>History</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {hasPending && <span className="badge badge-status badge-processing">Processing</span>}
            <button className="btn btn-ghost" type="button" onClick={() => void loadImports()}>Refresh</button>
          </div>
        </div>
        <div className="panel-body">
          <ImportList items={imports} />
        </div>
      </div>
    </div>
  )
}

// ── Conversations (debounced search, provider chips with counts) ──

const PAGE_SIZE = 50
const DEBOUNCE_MS = 300

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

function ConversationsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [provider, setProvider] = useState(searchParams.get('provider') || '')
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [items, setItems] = useState<Array<ConversationListItem & { snippet?: string }>>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [providerCounts, setProviderCounts] = useState<Record<string, number>>({})
  const debouncedQuery = useDebounce(query, DEBOUNCE_MS)
  const isSearch = debouncedQuery.trim().length > 0
  const initialLoadDone = useRef(false)

  // Fetch provider counts once
  useEffect(() => {
    api.getDashboard().then((d) => {
      const counts: Record<string, number> = {}
      for (const p of d.providers) counts[p.provider.toLowerCase()] = p.count
      setProviderCounts(counts)
    }).catch(() => {})
  }, [])

  const load = useCallback(async (prov: string, q: string) => {
    setBusy(true)
    try {
      if (q.trim()) {
        const result = await api.searchConversations(q.trim(), prov || undefined, PAGE_SIZE)
        setItems(result)
        setHasMore(false)
      } else {
        const result = await api.listConversations(prov || undefined, PAGE_SIZE, 0)
        setItems(result)
        setHasMore(result.length >= PAGE_SIZE)
      }
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load conversations.')
    } finally {
      setBusy(false)
    }
  }, [])

  // React to debounced query or provider changes
  useEffect(() => {
    // Skip the very first render — we handle that with the initial load below
    if (!initialLoadDone.current) return
    void load(provider, debouncedQuery)
  }, [debouncedQuery, provider, load])

  // Initial load
  useEffect(() => {
    void load(provider, debouncedQuery).then(() => { initialLoadDone.current = true })
  }, [])

  const loadMore = async () => {
    if (isSearch || loadingMore) return
    setLoadingMore(true)
    try {
      const result = await api.listConversations(provider || undefined, PAGE_SIZE, items.length)
      setItems((prev) => [...prev, ...result])
      setHasMore(result.length >= PAGE_SIZE)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more.')
    } finally {
      setLoadingMore(false)
    }
  }

  const toggleProvider = (p: string) => {
    const next = provider === p ? '' : p
    setProvider(next)
    // Update URL without navigation
    const params = new URLSearchParams(searchParams)
    if (next) params.set('provider', next); else params.delete('provider')
    setSearchParams(params, { replace: true })
  }

  const handleQueryChange = (value: string) => {
    setQuery(value)
    const params = new URLSearchParams(searchParams)
    if (value) params.set('q', value); else params.delete('q')
    setSearchParams(params, { replace: true })
  }

  const knownProviders = ['chatgpt', 'claude', 'gemini'] as const

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Conversations</h2>
        </div>
      </header>

      <div className="toolbar">
        <div className="field" style={{ flex: 1 }}>
          <input
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Search messages..."
          />
        </div>
        {busy && <span className="muted" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Searching...</span>}
      </div>

      <div className="provider-chips">
        {knownProviders.map((p) => (
          <button
            key={p}
            type="button"
            className={`chip ${provider === p ? 'chip-active' : ''}`}
            onClick={() => toggleProvider(p)}
          >
            <ProviderBadge provider={p} />
            {providerCounts[p] != null && (
              <span className="chip-count">{providerCounts[p].toLocaleString()}</span>
            )}
          </button>
        ))}
        {provider && (
          <button type="button" className="btn btn-ghost" style={{ fontSize: '0.75rem' }} onClick={() => toggleProvider(provider)}>
            Clear filter
          </button>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>{isSearch ? `Results for "${debouncedQuery.trim()}"` : `All conversations`}</h3>
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {items.length} shown{hasMore ? '+' : ''}
          </span>
        </div>
        <div className="panel-body">
          {error && <p className="error-text" style={{ padding: '0.75rem 1rem' }}>{error}</p>}
          <ConversationList items={items} showSnippet={isSearch} searchQuery={isSearch ? debouncedQuery.trim() : undefined} />
          {hasMore && (
            <div className="load-more">
              <button className="btn btn-secondary" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Load more conversations'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Conversation detail (with markdown + search highlight) ──

function ConversationDetailPage() {
  const { conversationId } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [conversation, setConversation] = useState<ConversationDetail | null>(null)
  const [error, setError] = useState('')
  const highlightQuery = searchParams.get('q') || ''
  const scrolledRef = useRef(false)

  useEffect(() => {
    if (!conversationId) return
    scrolledRef.current = false
    api.getConversation(conversationId).then(setConversation).catch((err: Error) => setError(err.message))
  }, [conversationId])

  // After render, scroll to first highlighted match
  useEffect(() => {
    if (!conversation || !highlightQuery || scrolledRef.current) return
    scrolledRef.current = true
    // Wait a tick for DOM to render
    requestAnimationFrame(() => {
      const firstMatch = document.querySelector('.search-highlight')
      if (firstMatch) {
        firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    })
  }, [conversation, highlightQuery])

  if (error) return <PageState title="Error" message={error} />
  if (!conversation) return <PageState title="Loading" message="Fetching conversation..." />

  const backTo = highlightQuery
    ? `/?q=${encodeURIComponent(highlightQuery)}`
    : '/'

  return (
    <div className="page page-wide">
      <button className="back-link btn btn-ghost" onClick={() => navigate(backTo)} type="button" style={{ marginBottom: '0.75rem', padding: '0.25rem 0.375rem' }}>
        {icons.back} Back to {highlightQuery ? 'results' : 'conversations'}
      </button>

      <div className="detail-header">
        <h2>{conversation.title}</h2>
        <ProviderBadge provider={conversation.provider} />
      </div>

      <div className="detail-meta">
        <dl style={{ margin: 0 }}>
          <dt>Created</dt>
          <dd>{formatDateShort(conversation.created_at)}</dd>
        </dl>
        <dl style={{ margin: 0 }}>
          <dt>Updated</dt>
          <dd>{formatDateShort(conversation.updated_at)}</dd>
        </dl>
        <dl style={{ margin: 0 }}>
          <dt>Messages</dt>
          <dd>{conversation.messages.length}</dd>
        </dl>
        <dl style={{ margin: 0 }}>
          <dt>Source</dt>
          <dd>{conversation.source_import?.original_filename ?? 'Unknown'}</dd>
        </dl>
      </div>

      <div className="panel">
        <div className="message-thread">
          {conversation.messages.map((msg) => (
            <MessageBlock key={msg.id} msg={msg} highlightQuery={highlightQuery} />
          ))}
        </div>
      </div>
    </div>
  )
}

function MessageBlock({ msg, highlightQuery }: { msg: ConversationDetail['messages'][0]; highlightQuery: string }) {
  const html = renderMarkdown(msg.text)
  const highlighted = highlightQuery ? highlightHtml(html, highlightQuery) : html

  return (
    <div className={`message-block ${msg.role === 'assistant' ? 'message-block-assistant' : ''}`}>
      <div className="message-header">
        <span className={`role-marker role-${msg.role}`}>{msg.role}</span>
        <span className="message-author">{msg.author_name || roleDisplayName(msg.role)}</span>
        <span className="message-info" title={formatDateFull(msg.created_at)}>
          #{msg.sequence}{msg.created_at ? ` · ${timeAgo(msg.created_at)}` : ''}{msg.model ? ` · ${msg.model}` : ''}
        </span>
      </div>
      <div className="message-body markdown-body" dangerouslySetInnerHTML={{ __html: highlighted }} />
      {msg.attachments.length > 0 && (
        <div className="attachments-section">
          <div className="attachments-label">Attachments</div>
          {msg.attachments.map((att) => (
            <AttachmentItem key={att.id} attachment={att} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Settings ──

function SettingsPage() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [status, setStatus] = useState('')

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setStatus('')
    try {
      await api.changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setStatus('Password updated.')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not update the password.')
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>Settings</h2>
        </div>
      </header>

      <div className="panel">
        <div className="panel-header">
          <h3>Change password</h3>
        </div>
        <div className="panel-body-pad">
          <form className="settings-form form-grid" onSubmit={onSubmit}>
            <label>
              Current password
              <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            </label>
            <label>
              New password
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            </label>
            <div className="form-actions">
              <button className="btn btn-primary" type="submit">Save</button>
              {status && <p className={status === 'Password updated.' ? 'success-text' : 'error-text'}>{status}</p>}
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

// ── Shared components ──

function PageState({ title, message }: { title: string; message: string }) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h2>{title}</h2>
          <p className="page-desc">{message}</p>
        </div>
      </header>
    </div>
  )
}

function ProviderBadge({ provider }: { provider: string }) {
  const p = provider.toLowerCase()
  let cls = 'badge badge-default'
  if (p.includes('chatgpt') || p.includes('openai')) cls = 'badge badge-chatgpt'
  else if (p.includes('claude') || p.includes('anthropic')) cls = 'badge badge-claude'
  else if (p.includes('gemini') || p.includes('google')) cls = 'badge badge-gemini'
  return <span className={cls}>{provider}</span>
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  let cls = 'badge badge-status badge-default'
  if (s === 'completed') cls = 'badge badge-status badge-completed'
  else if (s === 'failed') cls = 'badge badge-status badge-failed'
  else if (s === 'processing' || s === 'queued') cls = 'badge badge-status badge-processing'
  return <span className={cls}>{status}</span>
}

function ImportList({ items, compact = false }: { items: ImportRecord[]; compact?: boolean }) {
  if (!items.length) {
    return <div className="empty-state">No imports</div>
  }

  return (
    <div>
      {items.map((item) => (
        <div className="import-row" key={item.id}>
          <span className="import-filename">{item.original_filename}</span>
          <ProviderBadge provider={item.provider} />
          <StatusBadge status={item.status} />
          <span className="import-meta" title={formatDateFull(item.created_at)}>{timeAgo(item.created_at)}</span>
          {!compact && (
            <>
              <span className="import-stats">
                {item.summary.inserted_messages ?? 0} msgs · {item.summary.inserted_attachments ?? 0} attachments · {item.summary.duplicate_messages ?? 0} dupes
              </span>
              {item.error && <span className="import-error">{item.error}</span>}
              {item.warnings.length > 0 && <span className="import-warnings">{item.warnings.join(' | ')}</span>}
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function ConversationList({ items, showSnippet = false, searchQuery }: { items: Array<ConversationListItem & { snippet?: string }>; showSnippet?: boolean; searchQuery?: string }) {
  const navigate = useNavigate()

  if (!items.length) {
    return <div className="empty-state">{showSnippet ? 'No matching conversations' : 'No conversations'}</div>
  }

  return (
    <div>
      {items.map((item) => {
        const target = searchQuery
          ? `/conversations/${item.id}?q=${encodeURIComponent(searchQuery)}`
          : `/conversations/${item.id}`
        return (
          <button className="conv-row" key={item.id} type="button" onClick={() => navigate(target)}>
            <span className="conv-title">{item.title}</span>
            <span className="conv-badge"><ProviderBadge provider={item.provider} /></span>
            <span className="conv-meta" title={formatDateFull(item.updated_at || item.last_message_at)}>
              {item.message_count} msgs · {timeAgo(item.updated_at || item.last_message_at)}
            </span>
            {showSnippet && item.snippet && (
              <span className="conv-snippet" dangerouslySetInnerHTML={{ __html: item.snippet }} />
            )}
          </button>
        )
      })}
    </div>
  )
}

function AttachmentItem({ attachment }: { attachment: ConversationAttachment }) {
  const [open, setOpen] = useState(false)
  const preview = getExtractedContent(attachment.metadata)
  const info = describeAttachment(attachment.metadata)

  return (
    <>
      <div className="attachment-chip">
        <div>
          <span className="att-name">{attachment.filename}</span>
          <span className="att-info" style={{ marginLeft: '0.5rem' }}>{info}</span>
        </div>
        {preview ? (
          <button className="btn btn-ghost" type="button" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'View'}
          </button>
        ) : (
          <span className="att-info">No text content</span>
        )}
      </div>
      {open && preview && <pre className="attachment-preview">{preview}</pre>}
    </>
  )
}

// ── Helpers ──

function roleDisplayName(role: string) {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'Assistant'
  if (role === 'system') return 'System'
  if (role === 'tool') return 'Tool'
  return role
}

function describeAttachment(metadata?: Record<string, unknown> | null) {
  if (!metadata) return ''
  const source = typeof metadata.source === 'string' ? metadata.source.replace(/_/g, ' ') : ''
  const fileType = typeof metadata.file_type === 'string' ? metadata.file_type : ''
  const fileSize = typeof metadata.file_size === 'number' ? formatBytes(metadata.file_size) : ''
  return [source, fileType, fileSize].filter(Boolean).join(' · ')
}

function getExtractedContent(metadata?: Record<string, unknown> | null) {
  if (!metadata) return null
  const extracted = metadata.extracted_content
  return typeof extracted === 'string' && extracted.trim() ? extracted.trim() : null
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * Highlight search terms in already-rendered HTML.
 * Walks text nodes only (skips tags) to avoid breaking markup.
 */
function highlightHtml(html: string, query: string): string {
  if (!query) return html
  // Escape regex special chars in the query
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Split HTML into tags and text segments
  const parts = html.split(/(<[^>]*>)/g)
  const re = new RegExp(`(${escaped})`, 'gi')
  return parts.map((part) => {
    // If it's a tag, leave it alone
    if (part.startsWith('<')) return part
    // Replace matches in text content
    return part.replace(re, '<mark class="search-highlight">$1</mark>')
  }).join('')
}

export default App
