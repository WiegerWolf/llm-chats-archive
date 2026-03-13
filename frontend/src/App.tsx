import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { marked } from 'marked'
import {
  MessageSquareText, Upload, BarChart3, Settings, LogOut, ChevronLeft,
  Search, Loader2, Paperclip, Eye, EyeOff, ExternalLink,
  ArrowUpFromLine, ChevronRight, Trash2, Globe, FileText, Sparkles, Wrench,
} from 'lucide-react'
import { cn } from './cn'
import { api, type ConversationAttachment, type ConversationDetail, type ConversationListItem, type DashboardData, type ImportRecord, type ImportSource, type SessionState } from './api'

// ── Marked config ──

marked.setOptions({ gfm: true, breaks: true })

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string
}

// ── Time helpers ──

function timeAgo(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
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

// ── Shared tiny components ──

function Badge({ children, variant = 'default', className }: { children: React.ReactNode; variant?: 'default' | 'chatgpt' | 'claude' | 'gemini' | 'kimi' | 'googleaistudio' | 'completed' | 'failed' | 'processing' | 'queued'; className?: string }) {
  const styles: Record<string, string> = {
    default: 'bg-zinc-100 text-zinc-600',
    chatgpt: 'bg-emerald-50 text-emerald-700',
    claude: 'bg-pink-50 text-pink-700',
    gemini: 'bg-blue-50 text-blue-700',
    kimi: 'bg-violet-50 text-violet-700',
    googleaistudio: 'bg-amber-50 text-amber-700',
    completed: 'bg-emerald-50 text-emerald-600',
    failed: 'bg-red-50 text-red-600',
    processing: 'bg-amber-50 text-amber-600',
    queued: 'bg-amber-50 text-amber-600',
  }
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap', styles[variant] || styles.default, className)}>
      {children}
    </span>
  )
}

function ProviderBadge({ provider }: { provider: string }) {
  const p = provider.toLowerCase()
  let variant: 'chatgpt' | 'claude' | 'gemini' | 'kimi' | 'googleaistudio' | 'default' = 'default'
  let label = provider
  if (p.includes('chatgpt') || p.includes('openai')) variant = 'chatgpt'
  else if (p.includes('claude') || p.includes('anthropic')) variant = 'claude'
  else if (p.includes('googleaistudio') || p.includes('google ai studio')) {
    variant = 'googleaistudio'
    label = 'Google AI Studio'
  }
  else if (p.includes('gemini') || p.includes('google')) variant = 'gemini'
  else if (p.includes('kimi') || p.includes('moonshot')) variant = 'kimi'
  return <Badge variant={variant}>{label}</Badge>
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase() as 'completed' | 'failed' | 'processing' | 'queued'
  return <Badge variant={s}>{status}</Badge>
}

const RoleStyles: Record<string, string> = {
  user: 'bg-blue-50 text-blue-700',
  assistant: 'bg-emerald-50 text-emerald-700',
  system: 'bg-zinc-100 text-zinc-500',
  tool: 'bg-amber-50 text-amber-700',
}

function RoleMarker({ role }: { role: string }) {
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider font-mono', RoleStyles[role] || 'bg-zinc-100 text-zinc-400')}>
      {role}
    </span>
  )
}

function Btn({ children, variant = 'primary', className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700 hover:border-indigo-700',
    secondary: 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300',
    ghost: 'bg-transparent text-zinc-500 border-transparent hover:bg-zinc-100 hover:text-zinc-700',
    danger: 'bg-transparent text-red-600 border-zinc-200 hover:bg-red-50 hover:border-red-300',
  }
  return (
    <button
      className={cn('inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[0.8125rem] font-medium border rounded-md transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap', styles[variant], className)}
      {...props}
    >
      {children}
    </button>
  )
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

  useEffect(() => { void refreshSession() }, [])

  if (!session) return <AuthScreen kicker="Chat Archive" title="Loading" message={error || 'Connecting to archive...'} />
  if (session.needs_setup) return <SetupPage onComplete={refreshSession} />
  if (!session.authenticated) return <LoginPage onLogin={refreshSession} />

  return (
    <BrowserRouter>
      <Shell onLogout={refreshSession} />
    </BrowserRouter>
  )
}

function AuthScreen({ kicker, title, message, children }: { kicker: string; title: string; message?: string; children?: React.ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center p-8 bg-zinc-50">
      <div className="w-full max-w-[380px] grid gap-4 p-6 bg-white border border-zinc-200 rounded-lg shadow-sm">
        <p className="text-2xs font-medium text-zinc-400 uppercase tracking-wider">{kicker}</p>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {message && <p className="text-[0.8125rem] text-zinc-500">{message}</p>}
        {children}
      </div>
    </div>
  )
}

function SetupPage({ onComplete }: { onComplete: () => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setBusy(true); setError('')
    try { await api.setupPassword(password); await onComplete() }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed.') }
    finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen grid place-items-center p-8 bg-zinc-50">
      <form className="w-full max-w-[380px] grid gap-4 p-6 bg-white border border-zinc-200 rounded-lg shadow-sm" onSubmit={onSubmit}>
        <p className="text-2xs font-medium text-zinc-400 uppercase tracking-wider">First-run setup</p>
        <h1 className="text-xl font-semibold tracking-tight">Create password</h1>
        <p className="text-[0.8125rem] text-zinc-500">Single-user, LAN-only. Minimum 12 characters.</p>
        <FieldLabel label="Password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="input" /></FieldLabel>
        <FieldLabel label="Confirm"><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className="input" /></FieldLabel>
        {error && <p className="text-[0.8125rem] text-red-600">{error}</p>}
        <Btn type="submit" disabled={busy}>{busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving...</> : 'Set password'}</Btn>
      </form>
    </div>
  )
}

function LoginPage({ onLogin }: { onLogin: () => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('')
    try { await api.login(password); await onLogin() }
    catch (err) { setError(err instanceof Error ? err.message : 'Login failed.') }
    finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen grid place-items-center p-8 bg-zinc-50">
      <form className="w-full max-w-[380px] grid gap-4 p-6 bg-white border border-zinc-200 rounded-lg shadow-sm" onSubmit={onSubmit}>
        <p className="text-2xs font-medium text-zinc-400 uppercase tracking-wider">Chat Archive</p>
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <FieldLabel label="Password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus className="input" /></FieldLabel>
        {error && <p className="text-[0.8125rem] text-red-600">{error}</p>}
        <Btn type="submit" disabled={busy}>{busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Signing in...</> : 'Sign in'}</Btn>
      </form>
    </div>
  )
}

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-[0.8125rem] font-medium text-zinc-600">
      {label}
      {children}
    </label>
  )
}

// ── Shell & sidebar ──

const NAV_ITEMS: Array<{ to: string; icon: typeof MessageSquareText; label: string; end?: boolean }> = [
  { to: '/', icon: MessageSquareText, label: 'Conversations', end: true },
  { to: '/imports', icon: Upload, label: 'Imports' },
  { to: '/stats', icon: BarChart3, label: 'Stats' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

function Shell({ onLogout }: { onLogout: () => Promise<void> }) {
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)

  const logout = async () => { await api.logout(); await onLogout(); navigate('/') }

  return (
    <div className={cn('grid min-h-screen transition-[grid-template-columns] duration-200', collapsed ? 'grid-cols-[56px_1fr]' : 'grid-cols-[220px_1fr]')}>
      <aside className="flex flex-col bg-sidebar text-sidebar-muted sticky top-0 h-screen overflow-hidden">
        {/* Brand */}
        <div className={cn('flex items-center gap-2.5 border-b border-sidebar-border px-3 min-h-[56px]', collapsed && 'justify-center')}>
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-600 text-white shrink-0">
            <MessageSquareText className="w-4 h-4" />
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <p className="text-[0.8125rem] font-semibold text-sidebar-foreground leading-tight truncate">Chat Archive</p>
              <p className="text-2xs text-sidebar-muted leading-tight truncate">LLM export viewer</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 flex flex-col gap-0.5 p-2 overflow-y-auto">
          {NAV_ITEMS.map(({ to, icon: Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => cn(
                'group flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[0.8125rem] font-medium transition-colors',
                collapsed && 'justify-center px-0',
                isActive
                  ? 'bg-sidebar-ring text-sidebar-foreground'
                  : 'text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground',
              )}
            >
              <Icon className="w-4 h-4 shrink-0 opacity-60 group-hover:opacity-90" />
              {!collapsed && <span className="truncate">{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-sidebar-border p-2 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void logout()}
            className={cn('flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[0.8125rem] font-medium text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors w-full', collapsed && 'justify-center px-0')}
          >
            <LogOut className="w-4 h-4 shrink-0 opacity-60" />
            {!collapsed && <span>Log out</span>}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className={cn('flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-2xs text-sidebar-muted/60 hover:bg-sidebar-accent hover:text-sidebar-muted transition-colors w-full', collapsed && 'justify-center px-0')}
          >
            {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <><ChevronLeft className="w-3.5 h-3.5" /> Collapse</>}
          </button>
        </div>
      </aside>

      <main className="min-h-screen overflow-y-auto bg-white">
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

// ── Stats (formerly Dashboard) ──

function StatsPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { api.getDashboard().then(setData).catch((err: Error) => setError(err.message)) }, [])

  if (error) return <PageShell title="Stats"><p className="text-red-600 text-[0.8125rem]">{error}</p></PageShell>
  if (!data) return <PageShell title="Stats"><p className="text-zinc-400 text-[0.8125rem]">Loading...</p></PageShell>

  const isEmpty = data.conversation_count === 0 && data.import_count === 0

  if (isEmpty) {
    return (
      <PageShell title="Stats">
        <div className="flex flex-col items-center gap-3 py-16 border-2 border-dashed border-zinc-200 rounded-lg text-center">
          <Upload className="w-8 h-8 text-zinc-300" />
          <h3 className="text-base font-semibold">No data yet</h3>
          <p className="text-[0.8125rem] text-zinc-500 max-w-sm">Upload a ChatGPT export (single-file or sharded), Claude, Gemini, Google AI Studio, or Kimi bundle to start browsing your conversations.</p>
          <Btn onClick={() => navigate('/imports')}>Go to Imports</Btn>
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell title="Stats" desc="Archive overview across all providers">
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Conversations', value: data.conversation_count },
          { label: 'Messages', value: data.message_count },
          { label: 'Imports', value: data.import_count },
        ].map(({ label, value }) => (
          <div key={label} className="border border-zinc-200 rounded-lg p-3.5">
            <div className="text-2xl font-semibold tabular-nums tracking-tight">{value.toLocaleString()}</div>
            <div className="text-xs text-zinc-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <Panel title="Providers">
          {data.providers.length ? (
            <ul>
              {data.providers.map((p) => (
                <li
                  key={p.provider}
                  className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-100 last:border-b-0 cursor-pointer hover:bg-zinc-50 transition-colors"
                  onClick={() => navigate(`/?provider=${encodeURIComponent(p.provider)}`)}
                >
                  <span className="flex items-center gap-2"><ProviderBadge provider={p.provider} /> {p.provider}</span>
                  <span className="text-xs font-semibold tabular-nums text-zinc-500">{p.count.toLocaleString()} <ChevronRight className="w-3 h-3 inline text-zinc-300" /></span>
                </li>
              ))}
            </ul>
          ) : <EmptyState>No conversations yet</EmptyState>}
        </Panel>

        <Panel title="Recent imports">
          {data.recent_imports.length
            ? <ImportList items={data.recent_imports} compact />
            : <EmptyState>No imports yet</EmptyState>
          }
        </Panel>
      </div>

      <Panel title="Recent conversations">
        {data.recent_conversations.length
          ? <ConversationList items={data.recent_conversations} />
          : <EmptyState>Import a provider export to get started</EmptyState>
        }
      </Panel>
    </PageShell>
  )
}

// ── Imports (with polling) ──

function ImportsPage() {
  const [imports, setImports] = useState<ImportRecord[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadImports = useCallback(async () => {
    try { const items = await api.listImports(); setImports(items); setError(''); return items }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load imports.'); return [] }
  }, [])

  const stopPolling = useCallback(() => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }, [])

  const startPolling = useCallback(() => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      const items = await loadImports()
      if (!items.some((i) => i.status === 'processing' || i.status === 'queued')) stopPolling()
    }, 2000)
  }, [loadImports, stopPolling])

  useEffect(() => { void loadImports(); return stopPolling }, [loadImports, stopPolling])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!selectedFile) return
    setBusy(true); setError('')
    try {
      await api.uploadImport(selectedFile)
      setSelectedFile(null)
      const fi = document.querySelector('.upload-drop input[type="file"]') as HTMLInputElement | null
      if (fi) fi.value = ''
      await loadImports(); startPolling()
    } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed.') }
    finally { setBusy(false) }
  }

  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) setSelectedFile(f) }
  const hasPending = imports.some((i) => i.status === 'processing' || i.status === 'queued')
  const onDelete = async (item: ImportRecord) => {
    if (item.status === 'processing' || item.status === 'queued') return
    const confirmed = window.confirm(`Delete ${item.original_filename} and all messages, attachments, and stored files imported from it?`)
    if (!confirmed) return
    setDeletingId(item.id)
    setError('')
    try {
      await api.deleteImport(item.id)
      await loadImports()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete import.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <PageShell title="Imports" desc="Upload provider exports (.zip or .json)">
      <form onSubmit={onSubmit}>
        <div
          className={cn('upload-drop border-2 border-dashed rounded-lg p-8 text-center mb-4 transition-colors', dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-zinc-300 hover:border-zinc-400')}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <label className="flex flex-col items-center gap-2 cursor-pointer">
            <ArrowUpFromLine className="w-6 h-6 text-zinc-400" />
            <span className="text-sm font-medium">{selectedFile ? selectedFile.name : 'Drop file here or click to browse'}</span>
            <span className="text-xs text-zinc-400">ChatGPT single-file and sharded exports, Claude, Gemini, Google AI Studio, and Kimi bundles supported</span>
            <input type="file" accept=".zip,.json" onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)} className="text-xs text-zinc-400 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border file:border-zinc-200 file:bg-white file:text-zinc-600 file:font-medium file:text-xs file:cursor-pointer" />
          </label>
          <div className="flex items-center gap-3 mt-3 justify-center">
            <Btn type="submit" disabled={busy || !selectedFile}>
              {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading...</> : 'Upload'}
            </Btn>
          </div>
        </div>
        {error && <p className="text-red-600 text-[0.8125rem] mb-4">{error}</p>}
      </form>

      <Panel
        title="History"
        action={
          <div className="flex items-center gap-2">
            {hasPending && <Badge variant="processing">Processing</Badge>}
            <Btn variant="ghost" onClick={() => void loadImports()}>Refresh</Btn>
          </div>
        }
      >
        <ImportList items={imports} deletingId={deletingId} onDelete={onDelete} />
      </Panel>
    </PageShell>
  )
}

// ── Conversations (debounced search + provider chips with counts) ──

const PAGE_SIZE = 50
const DEBOUNCE_MS = 300

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => { const id = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(id) }, [value, delay])
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
      if (q.trim()) { const r = await api.searchConversations(q.trim(), prov || undefined, PAGE_SIZE); setItems(r); setHasMore(false) }
      else { const r = await api.listConversations(prov || undefined, PAGE_SIZE, 0); setItems(r); setHasMore(r.length >= PAGE_SIZE) }
      setError('')
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load conversations.') }
    finally { setBusy(false) }
  }, [])

  useEffect(() => { if (!initialLoadDone.current) return; void load(provider, debouncedQuery) }, [debouncedQuery, provider, load])
  useEffect(() => { void load(provider, debouncedQuery).then(() => { initialLoadDone.current = true }) }, [])

  const loadMore = async () => {
    if (isSearch || loadingMore) return
    setLoadingMore(true)
    try { const r = await api.listConversations(provider || undefined, PAGE_SIZE, items.length); setItems((prev) => [...prev, ...r]); setHasMore(r.length >= PAGE_SIZE) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load more.') }
    finally { setLoadingMore(false) }
  }

  const toggleProvider = (p: string) => {
    const next = provider === p ? '' : p
    setProvider(next)
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

  const knownProviders = ['chatgpt', 'claude', 'gemini', 'googleaistudio', 'kimi'] as const

  return (
    <PageShell title="Conversations">
      {/* Search bar */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search messages..."
          className="input pl-9 pr-10"
        />
        {busy && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 animate-spin" />}
      </div>

      {/* Provider chips */}
      <div className="flex items-center gap-1.5 mb-3">
        {knownProviders.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => toggleProvider(p)}
            className={cn(
              'inline-flex items-center gap-1.5 border rounded-full px-1 py-0.5 transition-all cursor-pointer',
              provider === p
                ? 'border-indigo-300 bg-indigo-50 opacity-100'
                : 'border-zinc-200 opacity-50 hover:opacity-80',
            )}
          >
            <ProviderBadge provider={p} />
            {providerCounts[p] != null && (
              <span className={cn('text-2xs tabular-nums pr-1', provider === p ? 'text-indigo-600' : 'text-zinc-400')}>
                {providerCounts[p].toLocaleString()}
              </span>
            )}
          </button>
        ))}
        {provider && <Btn variant="ghost" className="text-xs h-auto py-0.5 px-1.5" onClick={() => toggleProvider(provider)}>Clear</Btn>}
      </div>

      {/* Results */}
      <Panel
        title={isSearch ? `Results for "${debouncedQuery.trim()}"` : 'All conversations'}
        action={<span className="text-xs text-zinc-400 tabular-nums">{items.length}{hasMore ? '+' : ''}</span>}
      >
        {error && <p className="text-red-600 text-[0.8125rem] px-4 py-3">{error}</p>}
        <ConversationList items={items} showSnippet={isSearch} searchQuery={isSearch ? debouncedQuery.trim() : undefined} />
        {hasMore && (
          <div className="px-4 py-3 border-t border-zinc-100 text-center">
            <Btn variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</> : 'Load more'}
            </Btn>
          </div>
        )}
      </Panel>
    </PageShell>
  )
}

// ── Conversation detail ──

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

  useEffect(() => {
    if (!conversation || !highlightQuery || scrolledRef.current) return
    scrolledRef.current = true
    requestAnimationFrame(() => {
      document.querySelector('.search-hl')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [conversation, highlightQuery])

  if (error) return <PageShell title="Error"><p className="text-red-600 text-[0.8125rem]">{error}</p></PageShell>
  if (!conversation) return <PageShell title="Conversation"><p className="text-zinc-400 text-[0.8125rem]">Loading...</p></PageShell>

  const backTo = highlightQuery ? `/?q=${encodeURIComponent(highlightQuery)}` : '/'
  const visibleMessages = conversation.messages.filter((msg) => shouldDisplayMessage(msg))

  return (
    <div className="max-w-[1100px] mx-auto px-6 py-6 pb-12">
      <Btn variant="ghost" onClick={() => navigate(backTo)} className="mb-3 -ml-2 text-xs">
        <ChevronLeft className="w-3.5 h-3.5" /> Back to {highlightQuery ? 'results' : 'conversations'}
      </Btn>

      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-lg font-semibold tracking-tight flex-1 min-w-0 truncate">{conversation.title}</h2>
        <ProviderBadge provider={conversation.provider} />
      </div>

      <div className="flex gap-6 px-4 py-3 mb-4 bg-zinc-50 border border-zinc-200 rounded-lg text-xs">
        {[
          { label: 'Created', value: formatDateShort(conversation.created_at) },
          { label: 'Updated', value: formatDateShort(conversation.updated_at) },
          { label: 'Messages', value: String(conversation.messages.length) },
          { label: 'Source', value: conversation.source_import?.original_filename ?? 'Unknown' },
        ].map(({ label, value }) => (
          <dl key={label} className="m-0">
            <dt className="text-2xs font-semibold uppercase tracking-wider text-zinc-400">{label}</dt>
            <dd className="mt-0.5 text-zinc-700">{value}</dd>
          </dl>
        ))}
      </div>

      <div className="border border-zinc-200 rounded-lg overflow-hidden">
        {visibleMessages.map((msg) => (
          <MessageBlock key={msg.id} msg={msg} highlightQuery={highlightQuery} />
        ))}
      </div>
    </div>
  )
}

function MessageBlock({ msg, highlightQuery }: { msg: ConversationDetail['messages'][0]; highlightQuery: string }) {
  const presentation = getMessagePresentation(msg)
  const html = presentation.kind === 'markdown' ? renderMarkdown(presentation.text) : ''
  const highlighted = highlightQuery && html ? highlightHtml(html, highlightQuery) : html
  const research = getKimiResearchData(msg.metadata)
  const thinking = getClaudeThinkingData(msg)
  const showBody = presentation.kind === 'code' || presentation.text.trim().length > 0

  return (
    <div className={cn('px-5 py-4 border-b border-zinc-100 last:border-b-0', msg.role === 'assistant' && 'bg-zinc-50/70')}>
      <div className="flex items-center gap-2 mb-2">
        <RoleMarker role={msg.role} />
        <span className="text-[0.8125rem] font-semibold">{msg.author_name || roleDisplayName(msg.role)}</span>
        <span className="text-2xs text-zinc-400 font-mono" title={formatDateFull(msg.created_at)}>
          #{msg.sequence}{msg.created_at ? ` · ${timeAgo(msg.created_at)}` : ''}{msg.model ? ` · ${msg.model}` : ''}
        </span>
      </div>
      {showBody && (presentation.kind === 'markdown' ? (
        <div className="markdown-body text-[0.8125rem] leading-relaxed break-words" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <div className="space-y-2">
          {presentation.title && <p className="text-2xs font-semibold uppercase tracking-wider text-zinc-400">{presentation.title}</p>}
          <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs leading-relaxed text-zinc-700"><code>{presentation.text}</code></pre>
          {presentation.raw && presentation.raw !== presentation.text && (
            <details className="rounded-md border border-zinc-200 bg-white">
              <summary className="cursor-pointer list-none px-3 py-2 text-[0.8125rem] font-medium text-zinc-700">Raw payload</summary>
              <pre className="overflow-x-auto border-t border-zinc-200 px-3 py-2 text-xs leading-relaxed text-zinc-600"><code>{presentation.raw}</code></pre>
            </details>
          )}
        </div>
      ))}
      {thinking.length > 0 && <ThinkingBlock thoughts={thinking} highlightQuery={highlightQuery} />}
      {research && <KimiResearchBlock data={research} highlightQuery={highlightQuery} />}
      {msg.attachments.length > 0 && (
        <div className="mt-3 pt-3 border-t border-zinc-200">
          <p className="text-2xs font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">Attachments</p>
          {msg.attachments.map((att) => <AttachmentItem key={att.id} attachment={att} />)}
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({ thoughts, highlightQuery }: { thoughts: ClaudeThinkingEntry[]; highlightQuery: string }) {
  return (
    <details className="mt-3 rounded-md border border-zinc-200 bg-white">
      <summary className="cursor-pointer list-none px-3 py-2 text-[0.8125rem] font-medium text-zinc-700">Thinking</summary>
      <div className="space-y-2 border-t border-zinc-200 p-3">
        {thoughts.map((thought, index) => {
          const thoughtHtml = renderMarkdown(thought.text)
          const highlightedThought = highlightQuery ? highlightHtml(thoughtHtml, highlightQuery) : thoughtHtml
          return (
            <div key={`${thought.created_at || 'thought'}-${index}`} className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
              <div className="markdown-body text-[0.8125rem] leading-relaxed break-words" dangerouslySetInnerHTML={{ __html: highlightedThought }} />
              {thought.summaries.length > 0 && <p className="mt-2 text-2xs text-zinc-500">{thought.summaries.join(' · ')}</p>}
            </div>
          )
        })}
      </div>
    </details>
  )
}

function KimiResearchBlock({ data, highlightQuery }: { data: KimiResearchData; highlightQuery: string }) {
  const reportHtml = data.markdownArtifact?.content ? renderMarkdown(data.markdownArtifact.content) : ''
  const highlightedReport = reportHtml && highlightQuery ? highlightHtml(reportHtml, highlightQuery) : reportHtml

  return (
    <div className="mt-4 space-y-4 border-t border-zinc-200 pt-4">
      {data.thoughts.length > 0 && (
        <SectionCard title="Research Trace" icon={<Sparkles className="w-3.5 h-3.5" />}>
          <div className="space-y-2">
            {data.thoughts.map((thought, index) => (
              <div key={`${thought.created_at || 'thought'}-${index}`} className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-[0.8125rem] text-zinc-700">
                {thought.text}
              </div>
            ))}
            {data.searches.map((search, index) => (
              <div key={`${search.created_at || 'search'}-${index}`} className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-[0.8125rem] text-zinc-700">
                <div className="mb-1 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-zinc-400">
                  <Globe className="h-3 w-3" />
                  Searched
                </div>
                {search.keywords.length > 0 ? search.keywords.join(', ') : 'Search activity'}
              </div>
            ))}
            {data.tools.map((tool, index) => (
              <div key={`${tool.tool_call_id || tool.name || 'tool'}-${index}`} className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-[0.8125rem] text-zinc-700">
                <div className="mb-1 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-zinc-400">
                  <Wrench className="h-3 w-3" />
                  Used {tool.name || 'tool'}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-zinc-600">{formatToolSummary(tool)}</pre>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {(data.markdownArtifact || data.htmlArtifact) && (
        <SectionCard title="Generated Report" icon={<FileText className="w-3.5 h-3.5" />}>
          <div className="space-y-3">
            {data.markdownArtifact && highlightedReport && (
              <div>
                <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-zinc-400">Markdown Report</p>
                <div className="markdown-body rounded-md border border-zinc-200 bg-white p-4 text-[0.8125rem] leading-relaxed break-words" dangerouslySetInnerHTML={{ __html: highlightedReport }} />
              </div>
            )}
            {data.htmlArtifact && (
              <details className="rounded-md border border-zinc-200 bg-white">
                <summary className="cursor-pointer list-none px-3 py-2 text-[0.8125rem] font-medium text-zinc-700">Interactive report preview</summary>
                <div className="border-t border-zinc-200 p-3">
                  <iframe title={data.htmlArtifact.title || 'Interactive report'} srcDoc={data.htmlArtifact.content} className="h-[560px] w-full rounded-md border border-zinc-200 bg-white" sandbox="allow-scripts allow-popups" />
                </div>
              </details>
            )}
          </div>
        </SectionCard>
      )}

      {data.references.length > 0 && (
        <SectionCard title="Sources" icon={<Globe className="w-3.5 h-3.5" />}>
          <div className="grid gap-2">
            {data.references.map((ref, index) => (
              <a key={`${ref.url}-${index}`} href={ref.url} target="_blank" rel="noreferrer" className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-[0.8125rem] text-zinc-700 hover:border-violet-300 hover:bg-violet-50/40">
                <div className="font-medium text-zinc-800">{ref.title || ref.url}</div>
                {ref.snippet && <div className="mt-1 text-xs text-zinc-500">{ref.snippet}</div>}
                <div className="mt-1 text-2xs text-zinc-400">{[ref.site_name, ref.publish_time ? formatDateShort(ref.publish_time) : ''].filter(Boolean).join(' · ')}</div>
              </a>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  )
}

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-zinc-400">
        {icon}
        {title}
      </div>
      {children}
    </section>
  )
}

// ── Settings ──

function SettingsPage() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [status, setStatus] = useState('')

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault(); setStatus('')
    try { await api.changePassword(currentPassword, newPassword); setCurrentPassword(''); setNewPassword(''); setStatus('Password updated.') }
    catch (err) { setStatus(err instanceof Error ? err.message : 'Could not update the password.') }
  }

  return (
    <PageShell title="Settings">
      <Panel title="Change password">
        <form className="grid gap-3 max-w-sm p-4" onSubmit={onSubmit}>
          <FieldLabel label="Current password"><input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required className="input" /></FieldLabel>
          <FieldLabel label="New password"><input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required className="input" /></FieldLabel>
          <div className="flex items-center gap-3 mt-1">
            <Btn type="submit">Save</Btn>
            {status && <p className={cn('text-[0.8125rem]', status === 'Password updated.' ? 'text-emerald-600' : 'text-red-600')}>{status}</p>}
          </div>
        </form>
      </Panel>
    </PageShell>
  )
}

// ── Layout primitives ──

function PageShell({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="max-w-[960px] mx-auto px-6 py-6 pb-12">
      <div className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {desc && <p className="text-[0.8125rem] text-zinc-500 mt-0.5">{desc}</p>}
      </div>
      {children}
    </div>
  )
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border border-zinc-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-200 bg-zinc-50/50">
        <h3 className="text-[0.8125rem] font-semibold">{title}</h3>
        {action}
      </div>
      <div>{children}</div>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="py-10 px-4 text-center text-[0.8125rem] text-zinc-400">{children}</div>
}

// ── Data display components ──

function ImportList({ items, compact = false, deletingId, onDelete }: { items: ImportRecord[]; compact?: boolean; deletingId?: number | null; onDelete?: (item: ImportRecord) => void }) {
  if (!items.length) return <EmptyState>No imports</EmptyState>

  return (
    <div>
      {items.map((item) => <ImportListItem key={item.id} item={item} compact={compact} deletingId={deletingId} onDelete={onDelete} />)}
    </div>
  )
}

function ImportListItem({ item, compact = false, deletingId, onDelete }: { item: ImportRecord; compact?: boolean; deletingId?: number | null; onDelete?: (item: ImportRecord) => void }) {
  const [open, setOpen] = useState(false)
  const [loadingSources, setLoadingSources] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const preservedSources = (sources || []).filter((source) => {
    const sourceType = source.metadata && typeof source.metadata.source === 'string' ? source.metadata.source : ''
    return source.kind === 'blob' && sourceType === 'google_ai_studio_artifact' && !source.is_attached
  })

  const toggleOpen = async () => {
    const next = !open
    setOpen(next)
    if (!next || compact || sources !== null || loadingSources) return
    try {
      setLoadingSources(true)
      setSourceError('')
      setSources(await api.listImportSources(item.id))
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : 'Failed to load import artifacts.')
    } finally {
      setLoadingSources(false)
    }
  }

  return (
    <div className="border-b border-zinc-100 last:border-b-0">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 items-center px-4 py-2.5 text-[0.8125rem]">
        <span className="font-medium truncate">{item.original_filename}</span>
        <div className="flex items-center gap-2 justify-end col-span-2">
          <ProviderBadge provider={item.provider} />
          <StatusBadge status={item.status} />
          {!compact && (
            <Btn type="button" variant="ghost" className="px-2 py-1" onClick={() => void toggleOpen()}>
              {open ? <><EyeOff className="w-3.5 h-3.5" /> Hide</> : <><Eye className="w-3.5 h-3.5" /> Details</>}
            </Btn>
          )}
          {!compact && onDelete && (
            <Btn
              type="button"
              variant="danger"
              className="px-2 py-1"
              onClick={() => void onDelete(item)}
              disabled={item.status === 'processing' || item.status === 'queued' || deletingId === item.id}
              title={item.status === 'processing' || item.status === 'queued' ? 'Wait for import to finish before deleting.' : 'Delete this import'}
            >
              {deletingId === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </Btn>
          )}
        </div>
        <span className="text-xs text-zinc-400 col-span-full" title={formatDateFull(item.created_at)}>{timeAgo(item.created_at)}</span>
        {!compact && (
          <>
            <span className="text-xs text-zinc-400 col-span-full">{item.summary.inserted_messages ?? 0} msgs · {item.summary.inserted_attachments ?? 0} attachments · {item.summary.duplicate_messages ?? 0} dupes</span>
            {item.error && <span className="text-xs text-red-600 col-span-full">{item.error}</span>}
            {item.warnings.length > 0 && <span className="text-xs text-amber-600 col-span-full">{item.warnings.join(' | ')}</span>}
          </>
        )}
      </div>
      {!compact && open && (
        <div className="px-4 pb-3">
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 space-y-2">
            <div className="text-xs text-zinc-500">{item.summary.inserted_sources ?? 0} stored files · {item.summary.unmatched_artifact_count ?? 0} unmatched preserved artifacts</div>
            {loadingSources && <div className="text-xs text-zinc-400">Loading artifacts…</div>}
            {sourceError && <div className="text-xs text-red-600">{sourceError}</div>}
            {!loadingSources && !sourceError && preservedSources.length > 0 && (
              <div className="space-y-1.5">
                {preservedSources.map((source) => <ImportSourceItem key={source.id} source={source} />)}
              </div>
            )}
            {!loadingSources && !sourceError && sources !== null && preservedSources.length === 0 && (
              <div className="text-xs text-zinc-400">No unmatched preserved artifacts for this import.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ImportSourceItem({ source }: { source: ImportSource }) {
  const metadata = source.metadata || null
  const filename = getImportSourceFilename(source)
  const url = `/api/sources/${source.id}`
  const size = typeof metadata?.size === 'number' ? formatBytes(metadata.size) : ''
  const mime = typeof metadata?.mime_type === 'string' ? metadata.mime_type : ''
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs">
      <div className="min-w-0">
        <div className="font-medium truncate">{filename}</div>
        <div className="text-zinc-400 truncate">{[mime, size].filter(Boolean).join(' · ') || source.kind}</div>
      </div>
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-zinc-600 hover:text-zinc-900 shrink-0">
        <ExternalLink className="w-3 h-3" /> Open
      </a>
    </div>
  )
}

function ConversationList({ items, showSnippet = false, searchQuery }: { items: Array<ConversationListItem & { snippet?: string }>; showSnippet?: boolean; searchQuery?: string }) {
  const navigate = useNavigate()
  if (!items.length) return <EmptyState>{showSnippet ? 'No matching conversations' : 'No conversations'}</EmptyState>

  return (
    <div>
      {items.map((item) => {
        const target = searchQuery ? `/conversations/${item.id}?q=${encodeURIComponent(searchQuery)}` : `/conversations/${item.id}`
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => navigate(target)}
            className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 w-full px-4 py-2.5 border-b border-zinc-100 last:border-b-0 text-left hover:bg-zinc-50 transition-colors cursor-pointer"
          >
            <span className="text-[0.8125rem] font-medium truncate">{item.title}</span>
            <span className="row-span-2 self-center"><ProviderBadge provider={item.provider} /></span>
            <span className="text-xs text-zinc-400 truncate" title={formatDateFull(item.updated_at || item.last_message_at)}>
              {item.message_count} msgs · {timeAgo(item.updated_at || item.last_message_at)}
            </span>
            {showSnippet && item.snippet && (
              <span className="col-span-full text-xs text-zinc-500 mt-0.5 leading-snug [&_mark]:bg-yellow-200 [&_mark]:text-zinc-900 [&_mark]:rounded-sm [&_mark]:px-px [&_em]:bg-yellow-200 [&_em]:not-italic [&_em]:text-zinc-900 [&_em]:rounded-sm [&_em]:px-px" dangerouslySetInnerHTML={{ __html: item.snippet }} />
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
  const sourceUrl = getAttachmentSourceUrl(attachment.metadata)
  const attachmentUrl = getAttachmentFileUrl(attachment)
  const isImage = isImageAttachment(attachment)
  const isPdf = isPdfAttachment(attachment)
  const isVideo = isVideoAttachment(attachment)
  const isAudio = isAudioAttachment(attachment)
  const canPreview = Boolean(preview || isImage)
  const canRichPreview = Boolean(isImage || isPdf || isVideo || isAudio)

  return (
    <>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border border-zinc-200 rounded-md bg-white mb-1.5 text-[0.8125rem]">
        <div className="flex items-center gap-2 min-w-0">
          <Paperclip className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          <span className="font-medium truncate">{attachment.filename}</span>
          {info && <span className="text-xs text-zinc-400 truncate">{info}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-violet-700 hover:text-violet-900">
              <ExternalLink className="w-3 h-3" /> Source
            </a>
          )}
          {attachmentUrl && (
            <a href={attachmentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900">
              <ExternalLink className="w-3 h-3" /> Open
            </a>
          )}
          {canPreview || canRichPreview ? (
            <Btn variant="ghost" className="text-xs h-auto py-0.5 px-1.5" onClick={() => setOpen((v) => !v)}>
              {open ? <><EyeOff className="w-3 h-3" /> Hide</> : <><Eye className="w-3 h-3" /> View</>}
            </Btn>
          ) : (
            <span className="text-xs text-zinc-400">No text</span>
          )}
        </div>
      </div>
      {open && (
        <div className="mb-1.5 space-y-2">
          {isImage && attachmentUrl && (
            <a href={attachmentUrl} target="_blank" rel="noreferrer" className="block rounded-md border border-zinc-200 bg-zinc-50 p-2 hover:bg-zinc-100 transition-colors">
              <img src={attachmentUrl} alt={attachment.filename} className="block max-h-[420px] max-w-full rounded object-contain mx-auto" loading="lazy" />
            </a>
          )}
          {isPdf && attachmentUrl && (
            <div className="rounded-md border border-zinc-200 bg-white overflow-hidden">
              <iframe src={attachmentUrl} title={attachment.filename} className="block w-full h-[420px]" />
            </div>
          )}
          {isVideo && attachmentUrl && (
            <video src={attachmentUrl} controls className="block max-h-[420px] max-w-full rounded border border-zinc-200 bg-black mx-auto" preload="metadata" />
          )}
          {isAudio && attachmentUrl && (
            <audio src={attachmentUrl} controls className="w-full" preload="metadata" />
          )}
          {preview && (
            <pre className="p-3 rounded-md bg-zinc-100 border border-zinc-200 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed max-h-[300px] overflow-y-auto">{preview}</pre>
          )}
        </div>
      )}
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

function getAttachmentSourceUrl(metadata?: Record<string, unknown> | null) {
  if (!metadata) return null
  const sourceUrl = metadata.source_url
  return typeof sourceUrl === 'string' && sourceUrl.trim() ? sourceUrl : null
}

function getAttachmentFileUrl(attachment: ConversationAttachment) {
  return attachment.blob_path ? `/api/attachments/${attachment.id}` : null
}

function isImageAttachment(attachment: ConversationAttachment) {
  const mimeType = attachment.mime_type?.toLowerCase() || ''
  if (mimeType.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(attachment.filename)
}

function isPdfAttachment(attachment: ConversationAttachment) {
  const mimeType = attachment.mime_type?.toLowerCase() || ''
  return mimeType === 'application/pdf' || /\.pdf$/i.test(attachment.filename)
}

function isVideoAttachment(attachment: ConversationAttachment) {
  const mimeType = attachment.mime_type?.toLowerCase() || ''
  if (mimeType.startsWith('video/')) return true
  return /\.(mp4|webm|mov|m4v|avi)$/i.test(attachment.filename)
}

function isAudioAttachment(attachment: ConversationAttachment) {
  const mimeType = attachment.mime_type?.toLowerCase() || ''
  if (mimeType.startsWith('audio/')) return true
  return /\.(mp3|wav|ogg|m4a|flac)$/i.test(attachment.filename)
}

function getImportSourceFilename(source: ImportSource) {
  const metadata = source.metadata || null
  const filename = metadata && typeof metadata.filename === 'string' ? metadata.filename : ''
  const original = metadata && typeof metadata.original_filename === 'string' ? metadata.original_filename : ''
  return filename || original || source.relative_path.split('/').pop() || source.relative_path
}


function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function highlightHtml(html: string, query: string): string {
  if (!query) return html
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = html.split(/(<[^>]*>)/g)
  const re = new RegExp(`(${escaped})`, 'gi')
  return parts.map((part) => part.startsWith('<') ? part : part.replace(re, '<mark class="search-hl">$1</mark>')).join('')
}

type KimiResearchRef = {
  url: string
  title?: string
  snippet?: string
  site_name?: string
  publish_time?: string
}

type KimiResearchArtifact = {
  artifact_id?: string
  type?: string
  version?: string
  path?: string
  title?: string
  content: string
}

type KimiResearchData = {
  thoughts: Array<{ text: string; created_at?: string }>
  searches: Array<{ keywords: string[]; created_at?: string }>
  tools: Array<{ name?: string; tool_call_id?: string; status?: string; args?: unknown; contents?: unknown }>
  references: KimiResearchRef[]
  markdownArtifact?: KimiResearchArtifact
  htmlArtifact?: KimiResearchArtifact
}

type ClaudeThinkingEntry = {
  text: string
  created_at?: string
  summaries: string[]
}

type MessagePresentation =
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; text: string; title?: string; raw?: string }

function shouldDisplayMessage(msg: ConversationDetail['messages'][0]): boolean {
  const metadata = asRecord(msg.metadata)
  const research = getKimiResearchData(msg.metadata)
  if (metadata?.is_visually_hidden_from_conversation === true && !research) return false

  const content = asRecord(msg.content)
  const contentType = asString(content?.content_type).toLowerCase()
  if (contentType === 'reasoning_recap') return false
  if (contentType === 'thoughts' && asArray(content?.thoughts).length === 0) return false
  if (isChatGptBootstrapMessage(msg)) return false

  const visibleText = getVisibleMessageText(msg).trim()
  if (!visibleText && msg.attachments.length === 0 && !research) return false
  if (msg.role === 'unknown' && safeJsonLikeEmpty(visibleText) && msg.attachments.length === 0) return false
  return true
}

function getMessagePresentation(msg: ConversationDetail['messages'][0]): MessagePresentation {
  const payload = getChatGptSpecialPayload(msg)
  if (payload) return payload
  return { kind: 'markdown', text: getVisibleMessageText(msg) }
}

function getVisibleMessageText(msg: ConversationDetail['messages'][0]): string {
  const content = asRecord(msg.content)
  const contentType = asString(content?.content_type).toLowerCase()
  if (contentType === 'reasoning_recap') return flattenTextContent(content?.content) || msg.text

  const blocks = asArray(asRecord(msg.content)?.blocks)
  const visibleParts = blocks
    .map((item) => asRecord(item))
    .filter(isPresent)
    .map((block) => renderClaudeVisibleBlock(block))
    .filter(Boolean)

  if (visibleParts.length > 0) return visibleParts.join('\n\n').trim()

  if (contentType === 'thoughts') {
    const thoughts = asArray(content?.thoughts)
      .map((item) => flattenTextContent(item))
      .filter(Boolean)
    if (thoughts.length > 0) return thoughts.join('\n\n').trim()
    return ''
  }

  return msg.text
}

function getChatGptSpecialPayload(msg: ConversationDetail['messages'][0]): MessagePresentation | null {
  const content = asRecord(msg.content)
  const contentType = asString(content?.content_type).toLowerCase()
  if (contentType !== 'code') return null

  const raw = asString(content?.text) || msg.text
  if (!raw) return null
  const parsed = safeParseJson(raw)
  if (!parsed) return {
    kind: 'code',
    text: raw,
    title: asString(content?.language) ? `${asString(content?.language)} payload` : 'Code payload',
  }

  const record = asRecord(parsed)
  const artifactContent = asString(record?.content)
  const artifactType = asString(record?.type)
  const artifactName = asString(record?.name)
  if (artifactContent) {
    return {
      kind: 'code',
      text: artifactContent,
      title: [artifactName || 'Generated artifact', artifactType].filter(Boolean).join(' · '),
      raw,
    }
  }

  const calculator = asArray(record?.calculator)
  if (calculator.length > 0) {
    const expressions = calculator
      .map((item) => asRecord(item))
      .filter(isPresent)
      .map((item) => asString(item.expression))
      .filter(Boolean)
    if (expressions.length > 0) {
      return {
        kind: 'code',
        text: expressions.join('\n'),
        title: 'Calculator payload',
        raw,
      }
    }
  }

  return {
    kind: 'code',
    text: safeJson(parsed),
    title: 'Structured payload',
    raw,
  }
}

function isChatGptBootstrapMessage(msg: ConversationDetail['messages'][0]): boolean {
  const metadata = asRecord(msg.metadata)
  const sdk = asRecord(metadata?.chatgpt_sdk)
  const invokedResource = asRecord(metadata?.invoked_resource)
  const resourceName = asString(sdk?.resource_name)
  const resourceUri = asString(invokedResource?.resource_uri)
  const rawText = msg.text.trim()
  const parsed = rawText ? safeParseJson(rawText) : null
  const parsedRecord = asRecord(parsed)
  const payloadPath = asString(parsedRecord?.path)

  if (payloadPath.toLowerCase().includes('deep research')) return true
  if ((resourceName.toLowerCase().includes('deep research') || resourceUri.toLowerCase().includes('deep_research')) && msg.role === 'tool') return true
  if ((resourceName.toLowerCase().includes('deep research') || resourceUri.toLowerCase().includes('deep_research')) && msg.role === 'assistant' && rawText.startsWith('{')) return true
  if (rawText.includes('Embedded UI description') && rawText.includes('deep research')) return true
  return false
}

function getClaudeThinkingData(msg: ConversationDetail['messages'][0]): ClaudeThinkingEntry[] {
  const fromMetadata = asArray(msg.metadata?.thinking)
    .map((item) => asRecord(item))
    .filter(isPresent)
    .map((item) => ({
      text: asString(item.text),
      created_at: asString(item.created_at) || undefined,
      summaries: asArray(item.summaries).map((value) => asString(value)).filter(Boolean),
    }))
    .filter((item) => item.text)
  if (fromMetadata.length > 0) return fromMetadata

  return asArray(asRecord(msg.content)?.blocks)
    .map((item) => asRecord(item))
    .filter(isPresent)
    .filter((block) => asString(block.type).toLowerCase() === 'thinking')
    .map((block) => ({
      text: asString(block.thinking),
      created_at: asString(block.start_timestamp) || asString(block.stop_timestamp) || undefined,
      summaries: asArray(block.summaries)
        .map((item) => asRecord(item))
        .filter(isPresent)
        .map((item) => asString(item.summary))
        .filter(Boolean),
    }))
    .filter((item) => item.text)
}

function renderClaudeVisibleBlock(block: Record<string, unknown>): string {
  const blockType = asString(block.type).toLowerCase()
  if (blockType === 'thinking' || blockType === 'token_budget') return ''
  if (blockType === 'text') return asString(block.text)
  if (blockType === 'voice_note') return [asString(block.title) || 'Voice note', asString(block.text)].filter(Boolean).join('\n').trim()
  if (blockType === 'tool_result') {
    const name = asString(block.name) || 'tool'
    const content = flattenTextContent(block.content)
    return content ? `Tool result (${name})\n${content}` : `Tool result (${name})`
  }
  if (blockType === 'tool_use') {
    const name = asString(block.name) || 'tool'
    const input = asRecord(block.input)
    const details = [asString(input?.command), asString(input?.id), asString(input?.name)].filter(Boolean)
    return details.length ? `Tool use (${name}): ${details.join(' - ')}` : `Tool use (${name})`
  }
  return flattenTextContent(block)
}

function flattenTextContent(value: unknown): string {
  const text = asString(value)
  if (text) return text
  if (Array.isArray(value)) return value.map((item) => flattenTextContent(item)).filter(Boolean).join('\n').trim()
  const record = asRecord(value)
  if (!record) return ''
  for (const key of ['text', 'result', 'output_text', 'content', 'message', 'value']) {
    const nested = flattenTextContent(record[key])
    if (nested) return nested
  }
  for (const key of ['contents', 'parts', 'segments', 'children']) {
    const nested = flattenTextContent(record[key])
    if (nested) return nested
  }
  return ''
}

function getKimiResearchData(metadata?: Record<string, unknown> | null): KimiResearchData | null {
  if (!metadata) return null
  const thoughts = asArray(metadata.thoughts)
    .map((item) => asRecord(item))
    .filter(isPresent)
    .map((item) => ({ text: asString(item.text), created_at: asString(item.created_at) || undefined }))
    .filter((item) => item.text)
  const searches = asArray(metadata.searches)
    .map((item) => asRecord(item))
    .filter(isPresent)
    .map((item) => ({ keywords: asArray(item.keywords).map((value) => asString(value)).filter(Boolean), created_at: asString(item.created_at) || undefined }))
  const tools = asArray(metadata.tools)
    .map((item) => asRecord(item))
    .filter(isPresent)
    .map((item) => ({ name: asString(item.name) || undefined, tool_call_id: asString(item.tool_call_id) || undefined, status: asString(item.status) || undefined, args: item.args, contents: item.contents }))
  const refs = asRecord(metadata.refs)
  const references = [...asArray(refs?.used_search_chunks), ...asArray(refs?.search_chunks)]
    .map((item) => asRecord(item))
    .filter(isPresent)
    .map((item) => ({ url: asString(item.url), title: asString(item.title) || undefined, snippet: asString(item.snippet) || undefined, site_name: asString(item.site_name) || undefined, publish_time: asString(item.publish_time) || undefined }))
    .filter((item) => item.url)
    .filter((item, index, array) => array.findIndex((other) => other.url === item.url) === index)
  const artifacts = asArray(metadata.artifacts)
    .map((item) => asRecord(item))
    .filter(isPresent)
    .map((item) => ({ artifact_id: asString(item.artifact_id) || undefined, type: asString(item.type) || undefined, version: asString(item.version) || undefined, path: asString(item.path) || undefined, title: asString(item.title) || undefined, content: asString(item.content) }))
    .filter((item) => item.content)
  const markdownArtifact = artifacts.find((item) => item.type === 'ARTIFACT_TYPE_MARKDOWN')
  const htmlArtifact = artifacts.find((item) => item.type === 'ARTIFACT_TYPE_CODE' || item.path === 'index.html')

  if (!thoughts.length && !searches.length && !tools.length && !references.length && !markdownArtifact && !htmlArtifact) return null
  return { thoughts, searches, tools, references, markdownArtifact, htmlArtifact }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function formatToolSummary(tool: { name?: string; status?: string; args?: unknown; contents?: unknown }) {
  const parts = [
    tool.status ? `status: ${tool.status}` : '',
    tool.args ? `args: ${safeJson(tool.args)}` : '',
    tool.contents ? `contents: ${safeJson(tool.contents)}` : '',
  ].filter(Boolean)
  return parts.join('\n') || (tool.name || 'tool activity')
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function safeParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function safeJsonLikeEmpty(value: string) {
  return value === '{}' || value === '[]'
}

export default App
