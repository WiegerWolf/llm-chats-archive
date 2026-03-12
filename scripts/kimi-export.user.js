// ==UserScript==
// @name         Unified Chat Archive - Kimi Export
// @namespace    https://github.com/
// @version      0.1.0
// @description  Capture Kimi history and chats into a JSON bundle for the Unified Chat Archive
// @match        https://www.kimi.com/chat/history*
// @grant        none
// ==/UserScript==

(function () {
  const SCRIPT_ID = 'unified-chat-archive-kimi-export'
  if (window[SCRIPT_ID]) return
  window[SCRIPT_ID] = true

  const API_BASE = 'https://www.kimi.com/apiv2'
  const PAGE_SIZE = 1000
  const CONCURRENCY = 3

  function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`))
    return match ? decodeURIComponent(match[1]) : ''
  }

  function getStoredToken(storage) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (!key || !/kimi|token|auth/i.test(key)) continue
        const rawValue = storage.getItem(key)
        if (!rawValue) continue
        if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(rawValue)) return rawValue
        try {
          const parsed = JSON.parse(rawValue)
          for (const candidateKey of ['token', 'access_token', 'accessToken', 'kimi-auth']) {
            const candidateValue = parsed?.[candidateKey]
            if (typeof candidateValue === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidateValue)) {
              return candidateValue
            }
          }
        } catch {
          // Ignore non-JSON storage values.
        }
      }
    } catch {
      // Ignore storage access issues.
    }
    return ''
  }

  function guessFilename(url, fallback) {
    try {
      const parsed = new URL(url)
      const filename = parsed.searchParams.get('filename') || parsed.pathname.split('/').pop() || fallback
      return filename.trim() || fallback
    } catch {
      return fallback
    }
  }

  function buildHeaders() {
    const token = getCookie('kimi-auth') || getStoredToken(window.localStorage) || getStoredToken(window.sessionStorage)
    const headers = {
      'accept': 'application/json, text/plain, */*',
      'connect-protocol-version': '1',
      'content-type': 'application/json',
      'r-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      'x-language': navigator.language || 'en-US',
      'x-msh-platform': 'web',
      'x-msh-version': '1.0.0',
    }
    if (token) headers.authorization = `Bearer ${token}`
    return headers
  }

  async function apiCall(path, payload) {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`${path} failed with ${response.status}: ${text.slice(0, 300)}`)
    }

    return response.json()
  }

  function textOf(element, selector) {
    return element.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() || ''
  }

  function collectHistory() {
    const groups = []
    const seen = new Set()
    const groupEls = document.querySelectorAll('.group-list-container > div')

    groupEls.forEach((groupEl) => {
      const label = textOf(groupEl, '.group-name') || 'Ungrouped'
      const items = []
      groupEl.querySelectorAll('.history-item-container').forEach((itemEl) => {
        const link = itemEl.querySelector('a.history-link[href*="/chat/"]')
        if (!link) return
        const href = new URL(link.getAttribute('href'), location.origin)
        const match = href.pathname.match(/\/chat\/([^/?#]+)/)
        const chatId = match ? match[1] : ''
        if (!chatId || seen.has(chatId)) return
        seen.add(chatId)

        const attachments = Array.from(itemEl.querySelectorAll('.history-attachment-list img')).map((img) => ({
          type: 'image',
          url: img.getAttribute('src') || '',
          filename: guessFilename(img.getAttribute('src') || '', 'image'),
        })).filter((item) => item.url)

        items.push({
          chat_id: chatId,
          href: href.toString(),
          title: textOf(itemEl, '.title'),
          date_label: textOf(itemEl, '.date'),
          preview_text: textOf(itemEl, '.content'),
          icon_url: itemEl.querySelector('.title-wrapper img')?.getAttribute('src') || '',
          attachments,
          group_label: label,
        })
      })

      if (items.length) groups.push({ label, items })
    })

    return groups
  }

  function flattenValue(value) {
    if (value == null) return ''
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) return value.map(flattenValue).filter(Boolean).join('\n\n').trim()
    if (typeof value === 'object') {
      const type = String(value.type || '').toLowerCase()
      if (['image', 'file', 'audio', 'video'].includes(type)) {
        return String(value.filename || value.name || value.title || '').trim()
      }
      const parts = []
      for (const key of ['text', 'markdown', 'content', 'display_content', 'summary', 'answer', 'query', 'body', 'value']) {
        if (value[key]) {
          const rendered = flattenValue(value[key])
          if (rendered) parts.push(rendered)
        }
      }
      for (const key of ['contents', 'parts', 'segments', 'children']) {
        if (value[key]) {
          const rendered = flattenValue(value[key])
          if (rendered) parts.push(rendered)
        }
      }
      return [...new Set(parts)].join('\n\n').trim()
    }
    return ''
  }

  function isLikelyMessage(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const keys = new Set(Object.keys(candidate))
    if (!keys.size) return false
    if (keys.has('chat_id') && keys.size <= 3) return false
    const hasRole = ['role', 'sender', 'sender_type', 'message_type', 'is_bot', 'is_user'].some((key) => keys.has(key))
    const hasText = ['text', 'content', 'contents', 'parts', 'segments', 'answer', 'query', 'markdown', 'display_content'].some((key) => keys.has(key))
    const hasId = ['message_id', 'msg_id', 'id', 'uuid'].some((key) => keys.has(key))
    const hasTime = ['created_at', 'updated_at', 'timestamp', 'time'].some((key) => keys.has(key))
    return (hasRole && hasText) || (hasId && hasText) || (hasId && hasTime && hasRole)
  }

  function collectMessageCandidates(value, output) {
    if (!value) return
    if (Array.isArray(value)) {
      value.forEach((item) => collectMessageCandidates(item, output))
      return
    }
    if (typeof value !== 'object') return
    if (isLikelyMessage(value)) output.push(value)
    Object.values(value).forEach((nested) => collectMessageCandidates(nested, output))
  }

  function extractSourceUrl(candidate) {
    for (const key of ['url', 'src', 'image_url', 'download_url', 'file_url', 'thumbnail_url', 'thumb_url']) {
      const value = candidate?.[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  function extractAttachments(rawMessage) {
    const seen = new Set()
    const attachments = []

    function visit(value) {
      if (!value) return
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (typeof value !== 'object') return

      const sourceUrl = extractSourceUrl(value)
      if (sourceUrl) {
        const filename = String(value.filename || value.file_name || value.name || value.title || guessFilename(sourceUrl, 'attachment')).trim() || 'attachment'
        if (!seen.has(sourceUrl)) {
          seen.add(sourceUrl)
          attachments.push({
            filename,
            mime_type: typeof value.mime_type === 'string' ? value.mime_type : null,
            metadata: {
              source: 'kimi_remote_attachment',
              source_url: sourceUrl,
            },
          })
        }
      }

      Object.values(value).forEach(visit)
    }

    for (const key of ['attachments', 'files', 'images']) {
      if (rawMessage[key]) visit(rawMessage[key])
    }
    if (!attachments.length) visit(rawMessage)
    return attachments
  }

  function normalizeRole(rawMessage) {
    if (rawMessage.is_user === true) return 'user'
    if (rawMessage.is_bot === true) return 'assistant'
    for (const key of ['role', 'sender', 'sender_type', 'message_type']) {
      const value = String(rawMessage[key] || '').toLowerCase().trim()
      if (['user', 'human', 'prompt', 'questioner'].includes(value)) return 'user'
      if (['assistant', 'bot', 'kimi', 'model', 'answer'].includes(value)) return 'assistant'
      if (['system', 'developer'].includes(value)) return 'system'
      if (['tool', 'function'].includes(value)) return 'tool'
    }
    return 'unknown'
  }

  function normalizeMessage(rawMessage) {
    const parts = []
    for (const key of ['text', 'display_content', 'markdown', 'summary', 'answer', 'query', 'content', 'contents', 'parts', 'segments', 'message', 'body']) {
      if (rawMessage[key]) {
        const rendered = flattenValue(rawMessage[key])
        if (rendered) parts.push(rendered)
      }
    }
    const text = [...new Set(parts)].join('\n\n').trim()
    const attachments = extractAttachments(rawMessage)
    if (!text && !attachments.length) return null
    const role = normalizeRole(rawMessage)
    return {
      message_id: rawMessage.message_id || rawMessage.msg_id || rawMessage.id || rawMessage.uuid || '',
      role,
      author_name: role === 'user' ? 'You' : role === 'assistant' ? 'Kimi' : null,
      created_at: rawMessage.created_at || rawMessage.create_time || rawMessage.timestamp || rawMessage.time || rawMessage.updated_at || null,
      updated_at: rawMessage.updated_at || null,
      text,
      attachments,
      raw: rawMessage,
    }
  }

  function getNextCursor(page) {
    if (!page || typeof page !== 'object') return ''
    for (const key of ['next_cursor', 'nextCursor', 'cursor', 'page_token', 'next_page_token']) {
      const value = page[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    for (const nested of Object.values(page)) {
      const cursor = getNextCursor(nested)
      if (cursor) return cursor
    }
    return ''
  }

  function extractNormalizedMessages(pages) {
    const candidates = []
    pages.forEach((page) => collectMessageCandidates(page, candidates))
    const seen = new Set()
    const normalized = []
    for (const candidate of candidates) {
      const normalizedMessage = normalizeMessage(candidate)
      if (!normalizedMessage) continue
      const key = normalizedMessage.message_id || `${normalizedMessage.role}:${normalizedMessage.created_at || ''}:${normalizedMessage.text.slice(0, 120)}`
      if (seen.has(key)) continue
      seen.add(key)
      normalized.push(normalizedMessage)
    }
    return normalized
  }

  async function fetchChatBundle(chat, updateStatus) {
    updateStatus(`Fetching ${chat.title || chat.chat_id}`)
    const getChat = await apiCall('/kimi.gateway.chat.v1.ChatService/GetChat', { chat_id: chat.chat_id })
    const pages = []
    const seenCursors = new Set()
    let cursor = ''

    while (true) {
      const payload = { chat_id: chat.chat_id, page_size: PAGE_SIZE }
      if (cursor) payload.cursor = cursor
      const page = await apiCall('/kimi.gateway.chat.v1.ChatService/ListMessages', payload)
      pages.push(page)
      const nextCursor = getNextCursor(page)
      const normalizedMessages = extractNormalizedMessages([page])
      if (!nextCursor || seenCursors.has(nextCursor) || normalizedMessages.length < PAGE_SIZE) break
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    return {
      chat_id: chat.chat_id,
      history: chat,
      chat: getChat,
      message_pages: pages,
      messages: extractNormalizedMessages(pages),
      warnings: [],
    }
  }

  async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length)
    let index = 0
    async function worker() {
      while (index < items.length) {
        const currentIndex = index
        index += 1
        results[currentIndex] = await mapper(items[currentIndex], currentIndex)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return results
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  function createButton() {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Export Kimi'
    button.style.position = 'fixed'
    button.style.right = '16px'
    button.style.bottom = '16px'
    button.style.zIndex = '99999'
    button.style.border = '0'
    button.style.borderRadius = '999px'
    button.style.padding = '10px 14px'
    button.style.background = '#6d28d9'
    button.style.color = '#fff'
    button.style.font = '600 13px/1.2 sans-serif'
    button.style.boxShadow = '0 8px 20px rgba(0,0,0,0.18)'
    button.style.cursor = 'pointer'
    document.body.appendChild(button)
    return button
  }

  const button = createButton()

  async function runExport() {
    const historyGroups = collectHistory()
    const chats = historyGroups.flatMap((group) => group.items)
    if (!chats.length) throw new Error('No chats found on the history page.')

    let completed = 0
    const updateStatus = (message) => {
      button.textContent = `${message} (${completed}/${chats.length})`
    }

    button.disabled = true
    button.style.opacity = '0.85'
    updateStatus('Starting')

    const warnings = []
    const capturedChats = await mapLimit(chats, CONCURRENCY, async (chat) => {
      try {
        const result = await fetchChatBundle(chat, updateStatus)
        completed += 1
        updateStatus('Captured')
        return result
      } catch (error) {
        completed += 1
        warnings.push(`${chat.chat_id}: ${error instanceof Error ? error.message : String(error)}`)
        updateStatus('Warning')
        return {
          chat_id: chat.chat_id,
          history: chat,
          chat: null,
          message_pages: [],
          messages: [],
          warnings: [error instanceof Error ? error.message : String(error)],
        }
      }
    })

    const bundle = {
      provider: 'kimi',
      schema_version: 'kimi-capture-v1',
      captured_at: new Date().toISOString(),
      source: {
        history_url: location.href,
        origin: location.origin,
        user_agent: navigator.userAgent,
      },
      history_groups: historyGroups,
      chats: capturedChats,
      warnings,
    }

    downloadJson(`kimi-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, bundle)
    button.textContent = `Exported ${capturedChats.length} chats`
    button.disabled = false
    button.style.opacity = '1'
  }

  button.addEventListener('click', () => {
    runExport().catch((error) => {
      console.error('Kimi export failed', error)
      button.textContent = 'Export failed - check console'
      button.disabled = false
      button.style.opacity = '1'
    })
  })

  window.kimiArchiveExport = runExport
})()
