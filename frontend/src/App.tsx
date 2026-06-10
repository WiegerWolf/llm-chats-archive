import { FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { BrowserRouter, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { marked } from 'marked'
import {
  MessageSquareText, Upload, Settings, LogOut, Search, Loader2,
  Paperclip, Eye, EyeOff, ExternalLink, ArrowUpFromLine,
  ChevronLeft, Trash2, Globe, FileText, Sparkles, Wrench, X,
} from 'lucide-react'
import { cn } from './cn'
import { api, type ConversationAttachment, type ConversationDetail, type ConversationListItem, type ImportRecord, type ImportSource, type SessionState } from './api'
import chatgptLogo from './assets/providers/chatgpt.svg'
import claudeLogo from './assets/providers/claude.svg'
import geminiLogo from './assets/providers/gemini.svg'
import googleAiStudioLogo from './assets/providers/googleaistudio.png'
import kimiLogo from './assets/providers/kimi.png'
import lobeChatLogo from './assets/providers/lobechat.png'
import metaLogo from './assets/providers/meta.png'
import piLogo from './assets/providers/pi.svg'

// ── Marked config ──

marked.setOptions({ gfm: true, breaks: true })

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string
}

function MarkdownContent({ text, highlightQuery = '', className }: { text: string; highlightQuery?: string; className?: string }) {
  const segments = parseMarkdownSegments(text)

  return (
    <div className={cn('markdown-body', className)}>
      {segments.map((segment, index) => {
        if (segment.kind === 'mermaid') {
          return <MermaidDiagram key={`mermaid-${index}`} code={segment.code} />
        }
        if (segment.kind === 'writing') {
          return <WritingCard key={`writing-${index}`} block={segment.block} />
        }
        const html = renderMarkdown(segment.text)
        const highlighted = highlightQuery ? highlightHtml(html, highlightQuery) : html
        return <div key={`html-${index}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      })}
    </div>
  )
}

function WritingCard({ block }: { block: WritingBlock }) {
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-sky-200 bg-sky-50/60">
      <div className="flex items-center justify-between gap-3 border-b border-sky-200 bg-sky-100/70 px-4 py-2">
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-sky-700">Draft {block.variant || 'writing'}</p>
          {block.subject && <p className="mt-0.5 text-sm font-medium text-sky-950">{block.subject}</p>}
        </div>
      </div>
      <div className="whitespace-pre-wrap break-words bg-white px-4 py-4 font-serif text-[0.95rem] leading-7 text-zinc-800">
          {block.body}
      </div>
    </div>
  )
}

function MermaidDiagram({ code }: { code: string }) {
  const id = useId().replace(/:/g, '-')
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const candidateCodes = useMemo(() => buildMermaidCandidates(code), [code])

  useEffect(() => {
    let cancelled = false

    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'strict',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      })
      let lastError: unknown = null
      let renderableCode: string | null = null
      for (let index = 0; index < candidateCodes.length; index += 1) {
        try {
          await mermaid.parse(candidateCodes[index], { suppressErrors: false })
          renderableCode = candidateCodes[index]
          break
        } catch (err) {
          lastError = err
        }
      }
      if (renderableCode) {
        try {
          const rendered = await mermaid.render(`diagram-${id}`, renderableCode)
          if (!cancelled) {
            setSvg(rendered.svg)
            setError('')
          }
          return
        } catch (err) {
          lastError = err
        }
      }
      if (!cancelled) {
        setSvg('')
        setError(lastError instanceof Error ? lastError.message : 'Could not render diagram.')
      }
    }).catch((err) => {
      if (!cancelled) {
        setSvg('')
        setError(err instanceof Error ? err.message : 'Could not load diagram renderer.')
      }
    })

    return () => {
      cancelled = true
    }
  }, [candidateCodes, id])

  if (error) {
    return (
      <div className="my-3 rounded-md border border-amber-200 bg-amber-50 p-3">
        <p className="mb-2 text-xs font-medium text-amber-700">Could not render flowchart</p>
        <pre className="overflow-x-auto rounded-md border border-amber-200 bg-white px-3 py-2 text-xs text-zinc-700"><code>{code}</code></pre>
      </div>
    )
  }

  if (!svg) {
    return <div className="my-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-6 text-center text-xs text-zinc-400">Rendering flowchart...</div>
  }

  return (
    <div className="mermaid-diagram my-3 overflow-x-auto rounded-md border border-zinc-200 bg-white p-3" dangerouslySetInnerHTML={{ __html: svg }} />
  )
}

type MarkdownSegment =
  | { kind: 'html'; text: string }
  | { kind: 'mermaid'; code: string }
  | { kind: 'writing'; block: WritingBlock }

type WritingBlock = {
  id?: string
  variant?: string
  subject?: string
  body: string
}

function parseMarkdownSegments(text: string): MarkdownSegment[] {
  const normalized = normalizeMermaidMarkdown(text)
  const pattern = /```mermaid\s*\n([\s\S]*?)```|:::writing\{([^}]*)\}\n([\s\S]*?)\n:::/g
  const segments: MarkdownSegment[] = []
  let lastIndex = 0

  for (const match of normalized.matchAll(pattern)) {
    const index = match.index ?? 0
    const before = normalized.slice(lastIndex, index)
    if (before.trim()) segments.push({ kind: 'html', text: before })
    const mermaidCode = (match[1] || '').trim()
    if (mermaidCode) {
      segments.push({ kind: 'mermaid', code: mermaidCode })
    } else {
      const writing = parseWritingBlock(match[2] || '', match[3] || '')
      if (writing) segments.push({ kind: 'writing', block: writing })
    }
    lastIndex = index + match[0].length
  }

  const tail = normalized.slice(lastIndex)
  if (tail.trim() || segments.length === 0) segments.push({ kind: 'html', text: tail || text })
  return segments
}

function parseWritingBlock(rawAttrs: string, rawBody: string): WritingBlock | null {
  const attrs = parseWritingAttributes(rawAttrs)
  const body = rawBody.trim()
  if (!body) return null
  return {
    id: attrs.id,
    variant: attrs.variant,
    subject: attrs.subject,
    body,
  }
}

function parseWritingAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /(\w+)="([^"]*)"|(\w+)=\"([^\"]*)\"|(\w+)=([^\s]+)/g
  for (const match of rawAttrs.matchAll(pattern)) {
    const key = match[1] || match[3] || match[5]
    const value = match[2] || match[4] || match[6] || ''
    if (key) attrs[key] = value
  }
  return attrs
}

function normalizeMermaidMarkdown(text: string): string {
  const lines = text.split('\n')
  const output: string[] = []
  let index = 0
  let inFence = false

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      output.push(line)
      index += 1
      continue
    }

    if (!inFence && isMermaidStart(trimmed)) {
      const block: string[] = [trimmed]
      index += 1
      while (index < lines.length) {
        const nextLine = lines[index]
        if (!nextLine.trim()) break
        block.push(nextLine)
        index += 1
      }
      output.push('```mermaid', ...block, '```')
      continue
    }

    output.push(line)
    index += 1
  }

  return output.join('\n')
}

function isMermaidStart(line: string): boolean {
  return /^(flowchart|graph|sequenceDiagram|classDiagram|erDiagram|journey|gantt|mindmap|timeline|stateDiagram(?:-v2)?|gitGraph|pie|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/.test(line)
}

function sanitizeMermaidCode(code: string): string {
  const normalized = code
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")

  const stripQuotes = (value: string) => value.replace(/["']/g, '')

  return normalized
    .replace(/\[([^\]]*?)\]/g, (_, label: string) => `[${stripQuotes(label)}]`)
    .replace(/\{([^{}]*?)\}/g, (_, label: string) => `{${stripQuotes(label)}}`)
}

function aggressivelySanitizeMermaidCode(code: string): string {
  const simplify = (value: string) => value
    .replace(/["']/g, '')
    .replace(/[()]/g, '')
    .replace(/[?]/g, '')
    .replace(/[+]/g, ' plus ')
    .replace(/[/:,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return sanitizeMermaidCode(code)
    .replace(/\[([^\]]*?)\]/g, (_, label: string) => `[${simplify(label)}]`)
    .replace(/\{([^{}]*?)\}/g, (_, label: string) => `{${simplify(label)}}`)
    .replace(/\|([^|]*?)\|/g, (_, label: string) => `|${simplify(label)}|`)
}

function buildMermaidCandidates(code: string): string[] {
  return Array.from(new Set([
    code,
    sanitizeMermaidCode(code),
    aggressivelySanitizeMermaidCode(code),
  ]))
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

function Badge({ children, variant = 'default', className }: { children: React.ReactNode; variant?: 'default' | 'chatgpt' | 'claude' | 'gemini' | 'kimi' | 'pi' | 'googleaistudio' | 'completed' | 'failed' | 'processing' | 'queued'; className?: string }) {
  const styles: Record<string, string> = {
    default: 'bg-zinc-100 text-zinc-600',
    chatgpt: 'bg-emerald-50 text-emerald-700',
    claude: 'bg-pink-50 text-pink-700',
    gemini: 'bg-blue-50 text-blue-700',
    kimi: 'bg-violet-50 text-violet-700',
    pi: 'bg-cyan-50 text-cyan-700',
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
  const logos = {
    chatgpt: chatgptLogo,
    claude: claudeLogo,
    gemini: geminiLogo,
    googleaistudio: googleAiStudioLogo,
    kimi: kimiLogo,
    lobechat: lobeChatLogo,
    meta: metaLogo,
    pi: piLogo,
  } as const

  const p = provider.toLowerCase()
  let logo: keyof typeof logos | null = null
  let label = provider
  if (p.includes('chatgpt') || p.includes('openai')) { logo = 'chatgpt'; label = 'ChatGPT' }
  else if (p.includes('claude') || p.includes('anthropic')) { logo = 'claude'; label = 'Claude' }
  else if (p.includes('googleaistudio') || p.includes('google ai studio')) {
    logo = 'googleaistudio'
    label = 'Google AI Studio'
  }
  else if (p.includes('gemini') || p.includes('google')) { logo = 'gemini'; label = 'Gemini' }
  else if (p.includes('kimi') || p.includes('moonshot')) { logo = 'kimi'; label = 'Kimi' }
  else if (p.includes('lobechat') || p.includes('lobe')) { logo = 'lobechat'; label = 'LobeChat' }
  else if (p.includes('meta') || p.includes('llama') || p.includes('facebook')) { logo = 'meta'; label = 'Meta' }
  else if (p === 'pi' || p.includes('pi.ai')) { logo = 'pi'; label = 'Pi' }

  if (!logo) return <Badge>{label}</Badge>

  return (
    <span
      className="inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border border-zinc-200 bg-white shadow-sm"
      title={label}
      aria-label={label}
    >
      <img src={logos[logo]} alt="" className="h-full w-full object-contain" />
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase() as 'completed' | 'failed' | 'processing' | 'queued'
  return <Badge variant={s}>{status}</Badge>
}

const RoleBorderStyles: Record<string, string> = {
  user: 'border-l-blue-400',
  assistant: 'border-l-emerald-400',
  system: 'border-l-zinc-300',
  tool: 'border-l-amber-400',
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

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-[0.8125rem] font-medium text-zinc-600">
      {label}
      {children}
    </label>
  )
}

// ── Hooks ──

const PAGE_SIZE = 50
const DEBOUNCE_MS = 300

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => { const id = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(id) }, [value, delay])
  return debounced
}

function isInputFocused() {
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
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
      <AppShell onLogout={refreshSession} />
    </BrowserRouter>
  )
}

function AuthScreen({ kicker, title, message, children }: { kicker: string; title: string; message?: string; children?: React.ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center p-8 bg-zinc-50">
      <div className="w-full max-w-[380px] grid gap-4 p-6 bg-white border border-zinc-200 rounded-xl shadow-sm animate-fade-in-up">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-600 text-white shrink-0">
            <MessageSquareText className="w-4 h-4" />
          </div>
          <p className="text-[0.8125rem] font-semibold text-zinc-400">{kicker}</p>
        </div>
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
      <form className="w-full max-w-[380px] grid gap-4 p-6 bg-white border border-zinc-200 rounded-xl shadow-sm animate-fade-in-up" onSubmit={onSubmit}>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-600 text-white shrink-0">
            <MessageSquareText className="w-4 h-4" />
          </div>
          <p className="text-[0.8125rem] font-semibold text-zinc-400">First-run setup</p>
        </div>
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
      <form className="w-full max-w-[380px] grid gap-4 p-6 bg-white border border-zinc-200 rounded-xl shadow-sm animate-fade-in-up" onSubmit={onSubmit}>
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-600 text-white shrink-0">
            <MessageSquareText className="w-4 h-4" />
          </div>
          <p className="text-[0.8125rem] font-semibold text-zinc-400">Chat Archive</p>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <FieldLabel label="Password"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus className="input" /></FieldLabel>
        {error && <p className="text-[0.8125rem] text-red-600">{error}</p>}
        <Btn type="submit" disabled={busy}>{busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Signing in...</> : 'Sign in'}</Btn>
      </form>
    </div>
  )
}

// ── App shell: top bar + split pane ──

function AppShell({ onLogout }: { onLogout: () => Promise<void> }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  // Parse selected conversation from URL
  const convMatch = location.pathname.match(/^\/conversations\/(\d+)/)
  const selectedConversationId = convMatch?.[1] || null

  // Search & filter state
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [provider, setProvider] = useState(searchParams.get('provider') || '')
  const debouncedQuery = useDebounce(query, DEBOUNCE_MS)
  const isSearch = debouncedQuery.trim().length > 0

  // Conversation list state
  const [items, setItems] = useState<Array<ConversationListItem & { snippet?: string }>>([])
  const [busy, setBusy] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [listError, setListError] = useState('')

  // Dashboard stats
  const [providerCounts, setProviderCounts] = useState<Record<string, number>>({})
  const [totalStats, setTotalStats] = useState({ conversations: 0, messages: 0 })

  // Overlay state
  const [importDrawerOpen, setImportDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Search ref
  const searchRef = useRef<HTMLInputElement>(null)

  // Load dashboard
  const refreshDashboard = useCallback(() => {
    api.getDashboard().then((d) => {
      const counts: Record<string, number> = {}
      for (const p of d.providers) counts[p.provider.toLowerCase()] = p.count
      setProviderCounts(counts)
      setTotalStats({ conversations: d.conversation_count, messages: d.message_count })
    }).catch(() => {})
  }, [])

  useEffect(() => { refreshDashboard() }, [refreshDashboard])

  // Load conversations
  const load = useCallback(async (prov: string, q: string) => {
    setBusy(true)
    try {
      if (q.trim()) {
        const r = await api.searchConversations(q.trim(), prov || undefined, PAGE_SIZE)
        setItems(r)
        setHasMore(false)
      } else {
        const r = await api.listConversations(prov || undefined, PAGE_SIZE, 0)
        setItems(r)
        setHasMore(r.length >= PAGE_SIZE)
      }
      setListError('')
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load.')
    } finally {
      setBusy(false)
    }
  }, [])

  const initialLoadDone = useRef(false)
  useEffect(() => { if (!initialLoadDone.current) return; void load(provider, debouncedQuery) }, [debouncedQuery, provider, load])
  useEffect(() => { void load(provider, debouncedQuery).then(() => { initialLoadDone.current = true }) }, [])

  const loadMore = async () => {
    if (isSearch || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await api.listConversations(provider || undefined, PAGE_SIZE, items.length)
      setItems((prev) => [...prev, ...r])
      setHasMore(r.length >= PAGE_SIZE)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load more.')
    } finally {
      setLoadingMore(false)
    }
  }

  // URL sync
  const handleQueryChange = (value: string) => {
    setQuery(value)
    const params = new URLSearchParams(searchParams)
    if (value) params.set('q', value); else params.delete('q')
    setSearchParams(params, { replace: true })
  }

  const handleProviderChange = (p: string) => {
    const next = provider === p ? '' : p
    setProvider(next)
    const params = new URLSearchParams(searchParams)
    if (next) params.set('provider', next); else params.delete('provider')
    setSearchParams(params, { replace: true })
  }

  const selectConversation = (id: number) => {
    const params = new URLSearchParams(searchParams)
    navigate(`/conversations/${id}${params.toString() ? '?' + params.toString() : ''}`)
  }

  const clearSelection = () => {
    const params = new URLSearchParams(searchParams)
    navigate(`/${params.toString() ? '?' + params.toString() : ''}`)
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !isInputFocused()) {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'Escape') {
        if (importDrawerOpen) setImportDrawerOpen(false)
        else if (settingsOpen) setSettingsOpen(false)
        else if (document.activeElement === searchRef.current) searchRef.current?.blur()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [importDrawerOpen, settingsOpen])

  const handleImportComplete = () => {
    void load(provider, debouncedQuery)
    refreshDashboard()
  }

  const logout = async () => { await api.logout(); await onLogout(); navigate('/') }

  // Provider list
  const knownProviders = ['chatgpt', 'claude', 'gemini', 'googleaistudio', 'kimi', 'meta', 'pi', 'lobechat'] as const
  const providerOptions = [
    ...knownProviders.filter((item) => providerCounts[item] != null),
    ...Object.keys(providerCounts)
      .filter((item) => !knownProviders.includes(item as typeof knownProviders[number]))
      .sort((a, b) => a.localeCompare(b)),
  ]

  const highlightQuery = searchParams.get('q') || ''

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-white">
      {/* ── Top bar ── */}
      <header className="flex items-center gap-3 h-12 px-4 border-b border-zinc-200 bg-white shrink-0 z-20">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-600 text-white shrink-0">
            <MessageSquareText className="w-3.5 h-3.5" />
          </div>
          <span className="text-sm font-semibold text-zinc-900 hidden sm:block">Chat Archive</span>
        </div>

        <div className="flex-1 max-w-xl mx-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400 pointer-events-none" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="Search conversations...  /"
              className="w-full h-8 pl-8 pr-8 text-sm bg-zinc-100/80 rounded-lg border-none outline-none placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-indigo-500/20 focus:shadow-sm transition-all"
            />
            {busy && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400 animate-spin" />}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Btn variant="secondary" onClick={() => setImportDrawerOpen(true)} className="h-8 text-xs">
            <ArrowUpFromLine className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Import</span>
          </Btn>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="w-8 h-8 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-8 h-8 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
            title="Log out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* ── Split pane ── */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel: conversation list */}
        <aside className={cn(
          'w-full md:w-[380px] lg:w-[420px] border-r border-zinc-200 flex flex-col shrink-0 bg-zinc-50/40',
          selectedConversationId && 'hidden md:flex',
        )}>
          {/* Provider filter pills */}
          {providerOptions.length > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-zinc-100 overflow-x-auto shrink-0">
              {providerOptions.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => handleProviderChange(p)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-all cursor-pointer border',
                    provider === p
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                      : 'bg-white border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50',
                  )}
                >
                  <ProviderBadge provider={p} />
                  {providerCounts[p] != null && (
                    <span className="text-2xs tabular-nums opacity-70">{providerCounts[p].toLocaleString()}</span>
                  )}
                </button>
              ))}
              {provider && (
                <button
                  type="button"
                  onClick={() => handleProviderChange(provider)}
                  className="text-xs text-zinc-400 hover:text-zinc-600 px-1 shrink-0"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          {/* List heading */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-100 shrink-0">
            <span className="text-xs font-medium text-zinc-500">
              {isSearch ? `Results for "${debouncedQuery.trim()}"` : 'All conversations'}
            </span>
            <span className="text-2xs text-zinc-400 tabular-nums">{items.length}{hasMore ? '+' : ''}</span>
          </div>

          {/* Conversation list */}
          <div className="flex-1 overflow-y-auto scroll-thin">
            {listError && <p className="text-red-600 text-xs px-3 py-2">{listError}</p>}
            {items.length === 0 && !busy && !listError && (
              <div className="py-12 px-4 text-center text-xs text-zinc-400">
                {isSearch ? 'No matching conversations' : 'No conversations'}
              </div>
            )}
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => selectConversation(item.id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 border-b border-zinc-100 transition-colors cursor-pointer',
                  selectedConversationId === String(item.id)
                    ? 'bg-indigo-50/80 border-l-2 border-l-indigo-500'
                    : 'hover:bg-zinc-100/60 border-l-2 border-l-transparent',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[0.8125rem] font-medium truncate leading-snug">{item.title}</span>
                  <span className="shrink-0 mt-0.5"><ProviderBadge provider={item.provider} /></span>
                </div>
                <div className="text-xs text-zinc-400 mt-0.5 truncate" title={formatDateFull(item.updated_at || item.last_message_at)}>
                  {item.message_count} msgs · {timeAgo(item.updated_at || item.last_message_at)}
                </div>
                {isSearch && item.snippet && (
                  <span
                    className="block text-xs text-zinc-500 mt-1 leading-snug line-clamp-2 [&_mark]:bg-yellow-200 [&_mark]:text-zinc-900 [&_mark]:rounded-sm [&_mark]:px-px [&_em]:bg-yellow-200 [&_em]:not-italic [&_em]:text-zinc-900 [&_em]:rounded-sm [&_em]:px-px"
                    dangerouslySetInnerHTML={{ __html: item.snippet }}
                  />
                )}
              </button>
            ))}
            {hasMore && (
              <div className="px-3 py-3 text-center">
                <Btn variant="ghost" className="text-xs w-full" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? <><Loader2 className="w-3 h-3 animate-spin" /> Loading...</> : 'Load more'}
                </Btn>
              </div>
            )}
          </div>

          {/* Stats footer */}
          {totalStats.conversations > 0 && (
            <div className="px-3 py-1.5 border-t border-zinc-100 text-2xs text-zinc-400 shrink-0 tabular-nums">
              {totalStats.conversations.toLocaleString()} conversations · {totalStats.messages.toLocaleString()} messages
            </div>
          )}
        </aside>

        {/* Right panel: conversation detail */}
        <main className={cn(
          'flex-1 min-w-0 flex flex-col bg-white',
          !selectedConversationId && 'hidden md:flex',
        )}>
          {selectedConversationId
            ? <ConversationDetailPanel key={selectedConversationId} id={selectedConversationId} highlightQuery={highlightQuery} onBack={clearSelection} />
            : <EmptyDetailState hasData={totalStats.conversations > 0} onImport={() => setImportDrawerOpen(true)} />
          }
        </main>
      </div>

      {/* ── Overlays ── */}
      {importDrawerOpen && (
        <ImportDrawer
          onClose={() => setImportDrawerOpen(false)}
          onImportComplete={handleImportComplete}
        />
      )}
      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}

function EmptyDetailState({ hasData, onImport }: { hasData: boolean; onImport: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-xs animate-fade-in">
        {hasData ? (
          <>
            <MessageSquareText className="w-10 h-10 text-zinc-200 mx-auto mb-3" />
            <p className="text-sm font-medium text-zinc-400">Select a conversation</p>
            <p className="text-xs text-zinc-400 mt-1">Pick one from the list or search to find it</p>
          </>
        ) : (
          <>
            <Upload className="w-10 h-10 text-zinc-200 mx-auto mb-3" />
            <p className="text-sm font-medium text-zinc-500">No conversations yet</p>
            <p className="text-xs text-zinc-400 mt-1 mb-4">Import a ChatGPT, Claude, Gemini, Google AI Studio, Kimi, or Pi export to start browsing</p>
            <Btn onClick={onImport}>Import</Btn>
          </>
        )}
      </div>
    </div>
  )
}

// ── Conversation detail panel ──

function ConversationDetailPanel({ id, highlightQuery, onBack }: { id: string; highlightQuery: string; onBack: () => void }) {
  const [conversation, setConversation] = useState<ConversationDetail | null>(null)
  const [error, setError] = useState('')
  const scrolledRef = useRef(false)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrolledRef.current = false
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0
    api.getConversation(id).then(setConversation).catch((err: Error) => setError(err.message))
  }, [id])

  useEffect(() => {
    if (!conversation || !highlightQuery || scrolledRef.current) return
    scrolledRef.current = true
    requestAnimationFrame(() => {
      const el = scrollContainerRef.current?.querySelector('.search-hl')
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [conversation, highlightQuery])

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-red-600 text-sm">{error}</p>
      </div>
    )
  }

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <Loader2 className="w-5 h-5 text-zinc-300 animate-spin" />
      </div>
    )
  }

  const visibleMessages = conversation.messages.filter((msg) => shouldDisplayMessage(msg))

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Sticky header */}
      <div className="shrink-0 border-b border-zinc-200 bg-white px-6 py-3 z-10">
        <button
          type="button"
          onClick={onBack}
          className="md:hidden inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 mb-2 -ml-1"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> Back
        </button>
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold tracking-tight truncate flex-1 min-w-0">{conversation.title}</h2>
          <ProviderBadge provider={conversation.provider} />
        </div>
        <div className="text-xs text-zinc-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {conversation.created_at && <span title={formatDateFull(conversation.created_at)}>{formatDateShort(conversation.created_at)}</span>}
          <span>{conversation.messages.length} messages</span>
          {conversation.source_import && <span className="truncate">from {conversation.source_import.original_filename}</span>}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scroll-thin">
        <div className="max-w-[900px] mx-auto py-1">
          {visibleMessages.map((msg) => (
            <MessageBlock key={msg.id} msg={msg} highlightQuery={highlightQuery} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Message display ──

function MessageBlock({ msg, highlightQuery }: { msg: ConversationDetail['messages'][0]; highlightQuery: string }) {
  const presentation = getMessagePresentation(msg)
  const research = getKimiResearchData(msg.metadata)
  const thinking = getClaudeThinkingData(msg)
  const claudeBlocks = presentation.kind === 'markdown' ? getClaudeVisibleBlocks(msg) : []
  const claudeTextBlocks = claudeBlocks.filter((block): block is Extract<ClaudeVisibleBlock, { kind: 'text' }> => block.kind === 'text')
  const claudeToolBlocks = claudeBlocks.filter((block): block is Extract<ClaudeVisibleBlock, { kind: 'tool' }> => block.kind === 'tool')
  const markdownText = claudeBlocks.length > 0 ? claudeTextBlocks.map((block) => block.text).join('\n\n') : presentation.text
  const displayModel = visibleModelLabel(msg.model)
  const showBody = presentation.kind === 'code' || (presentation.kind === 'markdown' ? markdownText : presentation.text).trim().length > 0
  const borderColor = RoleBorderStyles[msg.role] || 'border-l-zinc-200'

  return (
    <div className={cn(
      'px-5 py-4 border-b border-zinc-100 last:border-b-0 border-l-2',
      borderColor,
      msg.role === 'assistant' && 'bg-zinc-50/50',
    )}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <RoleMarker role={msg.role} />
          <span className="text-[0.8125rem] font-semibold truncate">{msg.author_name || roleDisplayName(msg.role)}</span>
          {displayModel && <span className="text-2xs text-zinc-400 truncate hidden sm:inline">{displayModel}</span>}
        </div>
        <span className="text-2xs text-zinc-400 font-mono whitespace-nowrap shrink-0" title={formatDateFull(msg.created_at)}>
          #{msg.sequence}{msg.created_at ? ` · ${timeAgo(msg.created_at)}` : ''}
        </span>
      </div>
      {(thinking.length > 0 || claudeToolBlocks.length > 0) && (
        <ClaudeMetaRow thoughts={thinking} tools={claudeToolBlocks} highlightQuery={highlightQuery} />
      )}
      {showBody && (presentation.kind === 'markdown' ? (
        <MarkdownContent text={markdownText} highlightQuery={highlightQuery} className="text-[0.8125rem] leading-relaxed break-words" />
      ) : presentation.kind === 'payload' ? (
        <div className="space-y-2 rounded-md border border-zinc-200 bg-white px-3 py-3">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wider text-zinc-400">{presentation.title}</p>
            {presentation.summary && <p className="mt-1 text-[0.8125rem] text-zinc-600">{presentation.summary}</p>}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-700"><code>{presentation.text}</code></pre>
          {presentation.raw && presentation.raw !== presentation.text && (
            <details className="rounded-md border border-zinc-200 bg-white">
              <summary className="cursor-pointer list-none px-3 py-2 text-[0.8125rem] font-medium text-zinc-700">Raw payload</summary>
              <pre className="overflow-x-auto border-t border-zinc-200 px-3 py-2 text-xs leading-relaxed text-zinc-600"><code>{presentation.raw}</code></pre>
            </details>
          )}
        </div>
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

function ClaudeMetaRow({ thoughts, tools, highlightQuery }: { thoughts: ClaudeThinkingEntry[]; tools: Array<Extract<ClaudeVisibleBlock, { kind: 'tool' }>>; highlightQuery: string }) {
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {thoughts.length > 0 && <ThinkingBlock thoughts={thoughts} highlightQuery={highlightQuery} />}
      {tools.length > 0 && <ClaudeToolsBlock tools={tools} highlightQuery={highlightQuery} />}
    </div>
  )
}

function ClaudeToolsBlock({ tools, highlightQuery }: { tools: Array<Extract<ClaudeVisibleBlock, { kind: 'tool' }>>; highlightQuery: string }) {
  return (
    <details className="min-w-0 flex-1 overflow-hidden rounded-md border border-amber-200 bg-white sm:min-w-[14rem]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[0.8125rem] font-medium text-amber-800">
        <Wrench className="h-3.5 w-3.5" />
        Tool calls
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-2xs font-semibold text-amber-800">{tools.length}</span>
      </summary>
      <div className="space-y-2 border-t border-amber-200 bg-amber-50/40 p-3">
        {tools.map((tool, index) => (
          <ClaudeToolBlock key={`${tool.type}-${tool.name}-${index}`} block={tool} highlightQuery={highlightQuery} />
        ))}
      </div>
    </details>
  )
}

function ClaudeToolBlock({ block, highlightQuery }: { block: Extract<ClaudeVisibleBlock, { kind: 'tool' }>; highlightQuery: string }) {
  const title = block.type === 'tool_use' ? 'Tool use' : 'Tool result'
  return (
    <div className="overflow-hidden rounded-lg border border-amber-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-100/70 px-3 py-2 text-2xs font-semibold uppercase tracking-[0.14em] text-amber-800">
        <Wrench className="h-3.5 w-3.5" />
        <span>{title}</span>
        <span className="rounded-full bg-white/75 px-2 py-0.5 font-mono normal-case tracking-normal text-amber-900">{block.name}</span>
      </div>
      <div className="space-y-2 px-3 py-3">
        {block.text && <MarkdownContent text={block.text} highlightQuery={highlightQuery} className="text-[0.8125rem] leading-relaxed break-words text-zinc-700" />}
        {block.input != null && <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-amber-100 bg-amber-50/60 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-700"><code>{safeJson(block.input)}</code></pre>}
      </div>
    </div>
  )
}

function ThinkingBlock({ thoughts, highlightQuery }: { thoughts: ClaudeThinkingEntry[]; highlightQuery: string }) {
  return (
    <details className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-white sm:min-w-[14rem]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[0.8125rem] font-medium text-zinc-700">
        <Sparkles className="h-3.5 w-3.5" />
        Thinking
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-2xs font-semibold text-zinc-600">{thoughts.length}</span>
      </summary>
      <div className="space-y-2 border-t border-zinc-200 p-3">
        {thoughts.map((thought, index) => {
          return (
            <div key={`${thought.created_at || 'thought'}-${index}`} className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
              <MarkdownContent text={thought.text} highlightQuery={highlightQuery} className="text-[0.8125rem] leading-relaxed break-words" />
              {thought.summaries.length > 0 && <p className="mt-2 text-2xs text-zinc-500">{thought.summaries.join(' · ')}</p>}
            </div>
          )
        })}
      </div>
    </details>
  )
}

function KimiResearchBlock({ data, highlightQuery }: { data: KimiResearchData; highlightQuery: string }) {
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
            {data.markdownArtifact?.content && (
              <div>
                <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-zinc-400">Markdown Report</p>
                <MarkdownContent text={data.markdownArtifact.content} highlightQuery={highlightQuery} className="rounded-md border border-zinc-200 bg-white p-4 text-[0.8125rem] leading-relaxed break-words" />
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

// ── Attachments ──

function AttachmentItem({ attachment }: { attachment: ConversationAttachment }) {
  const preview = getExtractedContent(attachment.metadata)
  const info = describeAttachment(attachment.metadata)
  const sourceUrl = getAttachmentSourceUrl(attachment.metadata)
  const attachmentUrl = getAttachmentFileUrl(attachment)
  const isImage = isImageAttachment(attachment)
  const isPdf = isPdfAttachment(attachment)
  const isVideo = isVideoAttachment(attachment)
  const isAudio = isAudioAttachment(attachment)
  const canRichPreview = Boolean(attachmentUrl && (isImage || isPdf || isVideo || isAudio))
  const canPreview = Boolean(preview || canRichPreview)
  const missingFile = !attachmentUrl && (isImage || isPdf || isVideo || isAudio)
  const [open, setOpen] = useState(() => Boolean(attachmentUrl && isImage))

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
          ) : missingFile ? (
            <span className="text-xs text-zinc-400">File not exported</span>
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

// ── Import drawer ──

function ImportDrawer({ onClose, onImportComplete }: { onClose: () => void; onImportComplete: () => void }) {
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
      if (!items.some((i) => i.status === 'processing' || i.status === 'queued')) {
        stopPolling()
        onImportComplete()
      }
    }, 2000)
  }, [loadImports, stopPolling, onImportComplete])

  useEffect(() => { void loadImports(); return stopPolling }, [loadImports, stopPolling])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!selectedFile) return
    setBusy(true); setError('')
    try {
      await api.uploadImport(selectedFile)
      setSelectedFile(null)
      const fi = document.querySelector('.import-drawer-upload input[type="file"]') as HTMLInputElement | null
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
    setDeletingId(item.id); setError('')
    try { await api.deleteImport(item.id); await loadImports(); onImportComplete() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not delete import.') }
    finally { setDeletingId(null) }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/15 z-40 animate-fade-in" onClick={onClose} />
      {/* Drawer */}
      <div className="fixed inset-y-0 right-0 w-full max-w-lg bg-white shadow-2xl z-50 flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-12 border-b border-zinc-200 shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Import</h2>
            {hasPending && <Badge variant="processing">Processing</Badge>}
          </div>
          <button type="button" onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scroll-thin p-5 space-y-4">
          {/* Upload */}
          <form onSubmit={onSubmit}>
            <div
              className={cn('import-drawer-upload border-2 border-dashed rounded-lg p-6 text-center transition-colors', dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-zinc-300 hover:border-zinc-400')}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <label className="flex flex-col items-center gap-2 cursor-pointer">
                <ArrowUpFromLine className="w-5 h-5 text-zinc-400" />
                <span className="text-sm font-medium">{selectedFile ? selectedFile.name : 'Drop file or click to browse'}</span>
                <span className="text-xs text-zinc-400">ChatGPT, Claude, Gemini, Google AI Studio, Kimi, Pi exports (.zip, .json)</span>
                <input type="file" accept=".zip,.json" onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)} className="text-xs text-zinc-400 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border file:border-zinc-200 file:bg-white file:text-zinc-600 file:font-medium file:text-xs file:cursor-pointer" />
              </label>
              <div className="flex items-center gap-3 mt-3 justify-center">
                <Btn type="submit" disabled={busy || !selectedFile}>
                  {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading...</> : 'Upload'}
                </Btn>
              </div>
            </div>
            {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
          </form>

          {/* History */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">History</h3>
              <Btn variant="ghost" className="text-xs h-auto py-0.5 px-1.5" onClick={() => void loadImports()}>Refresh</Btn>
            </div>
            <div className="border border-zinc-200 rounded-lg overflow-hidden">
              <ImportList items={imports} deletingId={deletingId} onDelete={onDelete} />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Import list components ──

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
            {loadingSources && <div className="text-xs text-zinc-400">Loading artifacts...</div>}
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

// ── Settings modal ──

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [status, setStatus] = useState('')

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault(); setStatus('')
    try { await api.changePassword(currentPassword, newPassword); setCurrentPassword(''); setNewPassword(''); setStatus('Password updated.') }
    catch (err) { setStatus(err instanceof Error ? err.message : 'Could not update the password.') }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/15 z-40 animate-fade-in" onClick={onClose} />
      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm pointer-events-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200">
            <h2 className="text-sm font-semibold">Settings</h2>
            <button type="button" onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          <form className="p-5 space-y-3" onSubmit={onSubmit}>
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Change password</h3>
            <FieldLabel label="Current password"><input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required className="input" /></FieldLabel>
            <FieldLabel label="New password"><input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required className="input" /></FieldLabel>
            <div className="flex items-center gap-3 pt-1">
              <Btn variant="secondary" type="button" onClick={onClose}>Cancel</Btn>
              <Btn type="submit">Save</Btn>
              {status && <p className={cn('text-xs', status === 'Password updated.' ? 'text-emerald-600' : 'text-red-600')}>{status}</p>}
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

// ── Layout primitives ──

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="py-10 px-4 text-center text-[0.8125rem] text-zinc-400">{children}</div>
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

type ClaudeVisibleBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; type: 'tool_use' | 'tool_result'; name: string; text?: string; input?: unknown }

type MessagePresentation =
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; text: string; title?: string; raw?: string }
  | { kind: 'payload'; text: string; title: string; summary?: string; raw?: string }

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

function getClaudeVisibleBlocks(msg: ConversationDetail['messages'][0]): ClaudeVisibleBlock[] {
  const blocks = asArray(asRecord(msg.content)?.blocks)
    .map((item) => asRecord(item))
    .filter(isPresent)
    .map((block) => renderClaudeBlock(block))
    .filter(isPresent)

  return blocks
}

function renderClaudeBlock(block: Record<string, unknown>): ClaudeVisibleBlock | null {
  const blockType = asString(block.type).toLowerCase()
  if (blockType === 'thinking' || blockType === 'token_budget') return null
  if (blockType === 'text') {
    const text = asString(block.text)
    return text ? { kind: 'text', text } : null
  }
  if (blockType === 'voice_note') {
    const text = [asString(block.title) || 'Voice note', asString(block.text)].filter(Boolean).join('\n').trim()
    return text ? { kind: 'text', text } : null
  }
  if (blockType === 'tool_result') {
    return {
      kind: 'tool',
      type: 'tool_result',
      name: asString(block.name) || 'tool',
      text: flattenTextContent(block.content),
    }
  }
  if (blockType === 'tool_use') {
    const input = asRecord(block.input)
    const details = [asString(input?.command), asString(input?.id), asString(input?.name)].filter(Boolean).join(' - ')
    return {
      kind: 'tool',
      type: 'tool_use',
      name: asString(block.name) || 'tool',
      text: details || undefined,
      input: input || undefined,
    }
  }
  const text = flattenTextContent(block)
  return text ? { kind: 'text', text } : null
}

function getChatGptSpecialPayload(msg: ConversationDetail['messages'][0]): MessagePresentation | null {
  const content = asRecord(msg.content)
  const contentType = asString(content?.content_type).toLowerCase()
  if (contentType !== 'code') return null

  const raw = asString(content?.text) || msg.text
  if (!raw) return null
  const functionCall = parseFunctionCallPayload(raw)
  if (functionCall) {
    return {
      kind: 'payload',
      title: functionCallTitle(functionCall.name),
      summary: functionCall.name,
      text: functionCall.argsText,
      raw,
    }
  }
  const parsed = safeParseJson(raw)
  if (!parsed) return {
    kind: 'code',
    text: raw,
    title: friendlyPayloadLanguage(asString(content?.language)),
  }

  const record = asRecord(parsed)
  const path = asString(record?.path)
  const args = asRecord(record?.args)
  if (path) {
    return {
      kind: 'payload',
      title: payloadTitleFromPath(path),
      summary: path,
      text: args ? safeJson(args) : safeJson(parsed),
      raw,
    }
  }

  if (record?.session_id && (record?.connector_settings || record?.custom_sources_settings || record?.file_attachments)) {
    return {
      kind: 'payload',
      title: 'Tool session payload',
      summary: 'Connector session details',
      text: safeJson(parsed),
      raw,
    }
  }

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

function parseFunctionCallPayload(raw: string): { name: string; argsText: string } | null {
  const match = raw.trim().match(/^([A-Za-z_][\w.]*)\(([^]*)\)$/)
  if (!match) return null

  const name = match[1]
  const inner = match[2].trim()
  if (!inner) return { name, argsText: '' }

  try {
    const parsed = JSON.parse(`[${inner}]`) as unknown[]
    const argsText = parsed.length === 1
      ? formatPayloadValue(parsed[0])
      : parsed.map((value, index) => `arg${index + 1}: ${formatPayloadValue(value)}`).join('\n\n')
    return { name, argsText }
  } catch {
    return { name, argsText: inner }
  }
}

function formatPayloadValue(value: unknown): string {
  if (typeof value === 'string') return value
  return safeJson(value)
}

function functionCallTitle(name: string): string {
  const lowered = name.toLowerCase()
  if (lowered === 'search') return 'Search query'
  if (lowered === 'web.run') return 'Web tool call'
  if (lowered === 'canmore.create_textdoc') return 'Canvas draft creation'
  return `${humanizeIdentifier(name)} call`
}

function friendlyPayloadLanguage(language: string): string {
  const lowered = language.toLowerCase()
  if (!lowered || lowered === 'unknown') return 'Raw payload'
  if (lowered === 'json') return 'JSON payload'
  return `${language} payload`
}

function payloadTitleFromPath(path: string): string {
  const lowered = path.toLowerCase()
  if (lowered.includes('deep research')) return 'Deep research request'
  const parts = path.split('/').filter(Boolean)
  const tail = parts.length > 0 ? parts[parts.length - 1] : path
  return `${humanizeIdentifier(tail)} payload`
}

function humanizeIdentifier(value: string): string {
  return value
    .split(/[:./_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
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

function visibleModelLabel(model: string | null | undefined): string {
  const value = asString(model)
  if (/\(model unavailable\)$/i.test(value)) return ''
  return value
}

function formatToolSummary(tool: { name?: string; status?: string; args?: unknown; contents?: unknown }) {
  const parts = [
    tool.status ? `status: ${tool.status}` : '',
    tool.args ? `args: ${safeJson(tool.args)}` : '',
    tool.contents ? `contents: ${safeJson(tool.contents)}` : '',
  ].filter(Boolean)
  return parts.join('\n') || (tool.name || 'tool activity')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
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
