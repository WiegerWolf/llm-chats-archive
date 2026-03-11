import { FormEvent, useEffect, useMemo, useState } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { api, type ConversationAttachment, type ConversationDetail, type ConversationListItem, type DashboardData, type ImportRecord, type SessionState } from './api'

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
    return <FullScreenMessage title="Loading archive" message={error || 'Checking the application state.'} />
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
        <p className="panel-kicker">Unified Chat Archive</p>
        <h1>{title}</h1>
        <p className="muted">{message}</p>
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
        <h1>Set the archive password</h1>
        <p className="muted">This app is single-user and LAN-only. Pick one password with at least 12 characters.</p>
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Create archive password'}</button>
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
      setError(err instanceof Error ? err.message : 'Could not log in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={onSubmit}>
        <p className="panel-kicker">Welcome back</p>
        <h1>Open your archive</h1>
        <p className="muted">Use the app password you created during setup.</p>
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <button type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
      </form>
    </div>
  )
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
        <div>
          <p className="panel-kicker">Unified Chat Archive</p>
          <h1 className="sidebar-title">Paper trail for AI chats</h1>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/">Dashboard</NavLink>
          <NavLink to="/imports">Imports</NavLink>
          <NavLink to="/conversations">Conversations</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <button className="secondary-button" type="button" onClick={() => void logout()}>
          Log out
        </button>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/imports" element={<ImportsPage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:conversationId" element={<ConversationDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  )
}

function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getDashboard().then(setData).catch((err: Error) => setError(err.message))
  }, [])

  if (error) {
    return <PageState title="Dashboard" message={error} />
  }

  if (!data) {
    return <PageState title="Dashboard" message="Loading counts and recent activity." />
  }

  return (
    <section className="page-grid">
      <header className="page-header wide">
        <div>
          <p className="panel-kicker">Archive overview</p>
          <h2>One place for scattered exports</h2>
        </div>
        <p className="muted">Upload provider exports, keep the originals, and search normalized conversations across products.</p>
      </header>

      <article className="panel stat-panel">
        <span className="stat-label">Conversations</span>
        <strong>{data.conversation_count}</strong>
      </article>
      <article className="panel stat-panel">
        <span className="stat-label">Messages</span>
        <strong>{data.message_count}</strong>
      </article>
      <article className="panel stat-panel">
        <span className="stat-label">Imports</span>
        <strong>{data.import_count}</strong>
      </article>

      <article className="panel wide">
        <div className="panel-header-row">
          <h3>Provider mix</h3>
        </div>
        {data.providers.length ? (
          <ul className="plain-list">
            {data.providers.map((provider) => (
              <li key={provider.provider} className="list-row">
                <span>{provider.provider}</span>
                <strong>{provider.count}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No conversations yet. Start with an export upload.</p>
        )}
      </article>

      <article className="panel">
        <div className="panel-header-row">
          <h3>Recent imports</h3>
        </div>
        {data.recent_imports.length ? <ImportList items={data.recent_imports} compact /> : <p className="muted">No imports yet.</p>}
      </article>

      <article className="panel">
        <div className="panel-header-row">
          <h3>Recent conversations</h3>
        </div>
        {data.recent_conversations.length ? (
          <ConversationList items={data.recent_conversations} />
        ) : (
          <p className="muted">Conversations will appear here after the first successful import.</p>
        )}
      </article>
    </section>
  )
}

function ImportsPage() {
  const [imports, setImports] = useState<ImportRecord[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const loadImports = async () => {
    try {
      setImports(await api.listImports())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load imports.')
    }
  }

  useEffect(() => {
    void loadImports()
  }, [])

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedFile) {
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.uploadImport(selectedFile)
      setSelectedFile(null)
      await loadImports()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page-grid single-column">
      <header className="page-header">
        <div>
          <p className="panel-kicker">Browser upload</p>
          <h2>Import raw exports</h2>
        </div>
        <p className="muted">The original file stays untouched in storage. Parsed conversations are normalized into the archive.</p>
      </header>

      <form className="panel upload-panel" onSubmit={onSubmit}>
        <label>
          Export file
          <input
            type="file"
            accept=".zip,.json"
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            required
          />
        </label>
        <div className="upload-actions">
          <button type="submit" disabled={busy || !selectedFile}>{busy ? 'Uploading...' : 'Upload export'}</button>
          <p className="muted">Supports ChatGPT `conversations.json`, Anthropic Claude exports, and Gemini-style JSON exports.</p>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
      </form>

      <article className="panel">
        <div className="panel-header-row">
          <h3>Import history</h3>
          <button className="secondary-button" type="button" onClick={() => void loadImports()}>
            Refresh
          </button>
        </div>
        <ImportList items={imports} />
      </article>
    </section>
  )
}

function ConversationsPage() {
  const [provider, setProvider] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Array<ConversationListItem & { snippet?: string }>>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    try {
      const result = query.trim()
        ? await api.searchConversations(query.trim(), provider || undefined)
        : await api.listConversations(provider || undefined)
      setItems(result)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load conversations.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <section className="page-grid single-column">
      <header className="page-header">
        <div>
          <p className="panel-kicker">Archive viewer</p>
          <h2>Browse conversations</h2>
        </div>
        <p className="muted">Search message text across all imports, or filter the archive to a single provider.</p>
      </header>

      <form className="panel toolbar" onSubmit={(event) => { event.preventDefault(); void load() }}>
        <label>
          Search
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ask about a topic, model, or phrase" />
        </label>
        <label>
          Provider
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="">All providers</option>
            <option value="chatgpt">ChatGPT</option>
            <option value="gemini">Gemini</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Searching...' : 'Apply'}</button>
      </form>

      <article className="panel">
        <div className="panel-header-row">
          <h3>{query.trim() ? 'Search results' : 'All conversations'}</h3>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <ConversationList items={items} showSnippet />
      </article>
    </section>
  )
}

function ConversationDetailPage() {
  const { conversationId } = useParams()
  const [conversation, setConversation] = useState<ConversationDetail | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!conversationId) {
      return
    }
    api.getConversation(conversationId).then(setConversation).catch((err: Error) => setError(err.message))
  }, [conversationId])

  if (error) {
    return <PageState title="Conversation" message={error} />
  }

  if (!conversation) {
    return <PageState title="Conversation" message="Loading messages." />
  }

  return (
    <section className="page-grid single-column">
      <header className="page-header">
        <div>
          <p className="panel-kicker">Conversation record</p>
          <h2>{conversation.title}</h2>
        </div>
        <div className="header-meta-block">
          <span className="provider-tag">{conversation.provider}</span>
          <span>{conversation.messages.length} messages</span>
        </div>
      </header>

      <article className="panel provenance-panel">
        <div>
          <h3>Provenance</h3>
          <p className="muted">This is an archive view, not a live chat transcript. It shows normalized message records and the import that produced them.</p>
        </div>
        <dl className="metadata-list">
          <div>
            <dt>Created</dt>
            <dd>{formatDate(conversation.created_at)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDate(conversation.updated_at)}</dd>
          </div>
          <div>
            <dt>Source import</dt>
            <dd>{conversation.source_import?.original_filename ?? 'Unknown'}</dd>
          </div>
        </dl>
      </article>

      <article className="message-stack">
        {conversation.messages.map((message) => (
          <section className="message-record" key={message.id}>
            <header>
              <span className={`role-marker role-${message.role}`}>{message.role}</span>
              <div>
                <strong>{message.author_name || 'Unknown author'}</strong>
                <p className="muted">#{message.sequence} · {formatDate(message.created_at)}{message.model ? ` · ${message.model}` : ''}</p>
              </div>
            </header>
            <pre>{message.text}</pre>
            {message.attachments.length ? (
              <div className="message-attachments">
                <strong>Attachments</strong>
                <ul className="attachment-list">
                  {message.attachments.map((attachment) => (
                    <AttachmentItem key={attachment.id} attachment={attachment} />
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ))}
      </article>
    </section>
  )
}

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
    <section className="page-grid single-column">
      <header className="page-header">
        <div>
          <p className="panel-kicker">Settings</p>
          <h2>Single-user controls</h2>
        </div>
        <p className="muted">This MVP keeps auth intentionally small: one password, one user, server-side sessions.</p>
      </header>

      <form className="panel settings-form" onSubmit={onSubmit}>
        <h3>Change password</h3>
        <label>
          Current password
          <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
        </label>
        <label>
          New password
          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
        </label>
        <button type="submit">Save new password</button>
        {status ? <p className={status === 'Password updated.' ? 'success-text' : 'error-text'}>{status}</p> : null}
      </form>
    </section>
  )
}

function PageState({ title, message }: { title: string; message: string }) {
  return (
    <section className="page-grid single-column">
      <header className="page-header">
        <div>
          <p className="panel-kicker">{title}</p>
          <h2>{message}</h2>
        </div>
      </header>
    </section>
  )
}

function ImportList({ items, compact = false }: { items: ImportRecord[]; compact?: boolean }) {
  if (!items.length) {
    return <p className="muted">Nothing imported yet.</p>
  }

  return (
    <ul className={compact ? 'plain-list compact' : 'plain-list'}>
      {items.map((item) => (
        <li key={item.id} className="list-card">
          <div className="list-card-top">
            <div>
              <strong>{item.original_filename}</strong>
              <p className="muted">{item.provider} · {formatDate(item.created_at)}</p>
            </div>
            <span className={`status-chip status-${item.status}`}>{item.status}</span>
          </div>
          {!compact ? (
            <>
              <p className="muted">Inserted {item.summary.inserted_messages ?? 0} messages, imported {item.summary.inserted_attachments ?? 0} attachments, skipped {item.summary.duplicate_messages ?? 0} duplicates.</p>
              {item.error ? <p className="error-text">{item.error}</p> : null}
              {item.warnings.length ? <p className="muted">Warnings: {item.warnings.join(' | ')}</p> : null}
            </>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function ConversationList({ items, showSnippet = false }: { items: Array<ConversationListItem & { snippet?: string }>; showSnippet?: boolean }) {
  const navigate = useNavigate()
  const emptyState = useMemo(() => {
    if (showSnippet) {
      return 'No matching conversations.'
    }
    return 'No conversations available.'
  }, [showSnippet])

  if (!items.length) {
    return <p className="muted">{emptyState}</p>
  }

  return (
    <ul className="plain-list">
      {items.map((item) => (
        <li key={item.id}>
          <button className="conversation-link" type="button" onClick={() => navigate(`/conversations/${item.id}`)}>
            <div className="conversation-link-top">
              <strong>{item.title}</strong>
              <span className="provider-tag">{item.provider}</span>
            </div>
            <p className="muted">{item.message_count} messages · {formatDate(item.updated_at || item.last_message_at)}</p>
            {item.snippet ? <p className="snippet">{item.snippet}</p> : null}
          </button>
        </li>
      ))}
    </ul>
  )
}

function formatDate(value?: string | null) {
  if (!value) {
    return 'Unknown'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}

function describeAttachment(metadata?: Record<string, unknown> | null) {
  if (!metadata) {
    return 'Metadata only'
  }
  const source = typeof metadata.source === 'string' ? metadata.source : 'attachment'
  const fileType = typeof metadata.file_type === 'string' ? metadata.file_type : ''
  const fileSize = typeof metadata.file_size === 'number' ? `${metadata.file_size} bytes` : ''
  return [source.replace(/_/g, ' '), fileType, fileSize].filter(Boolean).join(' · ') || 'Metadata only'
}

function attachmentPreview(metadata?: Record<string, unknown> | null) {
  if (!metadata) {
    return null
  }
  const extracted = metadata.extracted_content
  return typeof extracted === 'string' && extracted.trim() ? extracted.trim() : null
}

function AttachmentItem({ attachment }: { attachment: ConversationAttachment }) {
  const [open, setOpen] = useState(false)
  const preview = attachmentPreview(attachment.metadata)

  return (
    <li className="attachment-item">
      <div className="attachment-row">
        <div>
          <strong>{attachment.filename}</strong>
          <p className="muted attachment-meta">{describeAttachment(attachment.metadata)}</p>
        </div>
        {preview ? (
          <button className="secondary-button attachment-toggle" type="button" onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide text' : 'View text'}
          </button>
        ) : (
          <span className="muted attachment-empty">No text content in export</span>
        )}
      </div>
      {open && preview ? <pre className="attachment-preview">{preview}</pre> : null}
    </li>
  )
}

export default App
