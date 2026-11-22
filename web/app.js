// dsh-collab peer page: decrypts structured frames and renders them.
// No framework, no CDN, no build step — the whole page is three files served by the host.
import { applyStaticText, t, toggleLang } from './i18n.js'

const $ = (id) => document.getElementById(id)
const UI = {
  dot: $('dot'),
  room: $('room'),
  host: $('host'),
  peers: $('peers'),
  ttl: $('ttl'),
  status: $('status'),
  presence: $('presence'),
  comments: $('comments'),
  commentsList: $('comments-list'),
  commentsCount: $('comments-count'),
  composer: $('composer'),
  commentInput: $('comment-input'),
  commentSend: $('comment-send'),
  anchorChip: $('anchor-chip'),
  timeline: $('timeline'),
  drawer: $('drawer'),
  tree: $('tree'),
  search: $('search'),
  preview: $('preview'),
  previewPath: $('preview-path'),
  previewMeta: $('preview-meta'),
  previewBody: $('preview-body'),
  gate: $('gate'),
  gateTitle: $('gate-title'),
  gateBody: $('gate-body'),
  gateRetry: $('gate-retry'),
}

applyStaticText()

const ROOM = (location.pathname.split('/').filter(Boolean).pop() || '').toUpperCase()
const SECRET = new URLSearchParams(location.hash.replace(/^#/, '')).get('k') || ''
const KDF_INFO = 'dsh-collab/v1'
const PROTOCOL = 1

UI.room.textContent = ROOM || '—'

// ---------- bytes / base64url ----------

function b64urlToBytes(value) {
  const text = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4)
  const raw = atob(padded)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

function bytesToB64url(bytes) {
  let text = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i += 1) text += String.fromCharCode(view[i])
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomNonce(bytes = 24) {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return bytesToB64url(buf)
}

// ---------- crypto ----------

const encoder = new TextEncoder()
let aesKey = null
let hmacKey = null

async function initCrypto() {
  if (!SECRET) throw new Error(t('app.gate.missingBody'))
  const ikm = await crypto.subtle.importKey('raw', b64urlToBytes(SECRET), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(ROOM), info: encoder.encode(KDF_INFO) },
    ikm,
    256,
  )
  aesKey = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  hmacKey = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function proof(parts) {
  const sig = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(parts.join('|')))
  return bytesToB64url(sig)
}

async function seal(seq, value) {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const aad = encoder.encode(`${KDF_INFO}|${ROOM}|${seq}`)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    aesKey,
    encoder.encode(JSON.stringify(value)),
  )
  return { s: seq, iv: bytesToB64url(iv), ct: bytesToB64url(ct) }
}

async function openFrame(envelope) {
  const iv = b64urlToBytes(envelope.iv)
  const ct = b64urlToBytes(envelope.ct)
  const aad = encoder.encode(`${KDF_INFO}|${ROOM}|${envelope.s}`)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, aesKey, ct)
  return JSON.parse(new TextDecoder().decode(plain))
}

// ---------- timeline ----------

const nodeEls = new Map()
let pinnedToBottom = true

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function toolStatusLabel(status) {
  if (status === 'running') return t('app.toolRunning')
  if (status === 'ok') return t('app.toolDone')
  if (status === 'error') return t('app.toolFailed')
  return status || ''
}

/** Tiny safe markdown: fenced code, inline code, bold, http(s) links. */
function renderInline(text) {
  const frag = document.createDocumentFragment()
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let match
  while ((match = re.exec(text))) {
    if (match.index > last) frag.append(document.createTextNode(text.slice(last, match.index)))
    const token = match[0]
    if (token.startsWith('`')) {
      frag.append(el('code', null, token.slice(1, -1)))
    } else if (token.startsWith('**')) {
      frag.append(el('strong', null, token.slice(2, -2)))
    } else {
      const link = el('a', null, match[1])
      link.href = match[2]
      link.rel = 'noopener noreferrer'
      link.target = '_blank'
      frag.append(link)
    }
    last = match.index + token.length
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)))
  return frag
}

function renderRichText(text) {
  const frag = document.createDocumentFragment()
  const parts = String(text ?? '').split('```')
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const pre = el('pre', 'code-block')
      pre.textContent = part.replace(/^[A-Za-z0-9_+-]*\n/, '')
      frag.append(pre)
      return
    }
    if (part) frag.append(renderInline(part))
  })
  return frag
}

function renderTool(card, tool) {
  card.textContent = ''
  const head = el('div', 'head')
  const name = el('span', 'name', tool.name || 'tool')
  const state = el('span', `state ${tool.status || ''}`, toolStatusLabel(tool.status))
  head.append(name, state)
  card.append(head)
  if (tool.argSummary) card.append(el('div', 'args', tool.argSummary))
  if (tool.resultSummary) {
    const result = el('div', `result ${tool.status === 'error' ? 'error' : ''}`, tool.resultSummary)
    card.append(result)
  }
}

function renderNode(node) {
  const wrap = el('div', `node ${node.kind}`)
  wrap.dataset.id = node.id
  if (node.kind === 'turn') {
    wrap.textContent = node.text || `turn ${node.turn ?? ''}`
    return wrap
  }
  if (node.kind === 'tool') {
    const card = el('div', 'tool')
    renderTool(card, node.tool || {})
    wrap.append(card)
    return wrap
  }
  const bubble = el('div', 'bubble')
  if (node.kind === 'notice' && node.source && node.source !== 'human') {
    bubble.append(el('span', 'tag', node.source))
  }
  if (node.kind === 'assistant') {
    if (node.text) bubble.append(renderRichText(node.text))
    else if (!node.streaming) bubble.append(document.createTextNode(t('app.emptyMessage')))
    if (node.streaming) {
      wrap.classList.add('streaming')
      bubble.append(el('span', 'caret-live', '▍'))
    }
  } else {
    bubble.append(document.createTextNode(node.text || ''))
  }
  wrap.append(bubble)
  return wrap
}

function isNearBottom() {
  const box = UI.timeline
  return box.scrollTop + box.clientHeight >= box.scrollHeight - 60
}

function scrollLatest(force = false) {
  if (force || pinnedToBottom) UI.timeline.scrollTop = UI.timeline.scrollHeight
}

UI.timeline.addEventListener('scroll', () => {
  pinnedToBottom = isNearBottom()
})

function clearTimeline() {
  nodeEls.clear()
  UI.timeline.textContent = ''
}

function upsertNode(node) {
  let element = nodeEls.get(node.id)
  if (!element) {
    element = renderNode(node)
    nodeEls.set(node.id, element)
    UI.timeline.append(element)
  }
  return element
}

function applyOps(ops) {
  for (const op of ops) {
    if (op.op === 'append') {
      remember(op.node)
      const existing = nodeEls.get(op.node.id)
      if (existing) {
        const replacement = renderNode(op.node)
        existing.replaceWith(replacement)
        nodeEls.set(op.node.id, replacement)
        continue
      }
      const element = renderNode(op.node)
      nodeEls.set(op.node.id, element)
      UI.timeline.append(element)
    } else if (op.op === 'update') {
      const merged = mergeNode(op.id, op.fields)
      const existing = nodeEls.get(op.id)
      if (!existing) continue
      const replacement = renderNode(merged)
      existing.replaceWith(replacement)
      nodeEls.set(op.id, replacement)
    } else if (op.op === 'remove') {
      const element = nodeEls.get(op.id)
      if (element) element.remove()
      nodeEls.delete(op.id)
      nodes.delete(op.id)
    } else if (op.op === 'text') {
      const node = nodes.get(op.id)
      if (node) node.text = (node.text ?? '') + op.delta
      const bubble = nodeEls.get(op.id)?.querySelector('.bubble')
      if (bubble) {
        const caret = bubble.querySelector('.caret-live')
        const chunk = document.createTextNode(op.delta)
        if (caret) bubble.insertBefore(chunk, caret)
        else bubble.append(chunk)
      }
    }
  }
  scrollLatest()
}

/** Local node cache so `update` ops can be merged into a full node before re-render. */
const nodes = new Map()
function remember(node) {
  nodes.set(node.id, node)
  return node
}
function mergeNode(id, fields) {
  const current = nodes.get(id) || { id }
  const next = { ...current, ...fields }
  nodes.set(id, next)
  return next
}

// ---------- connection ----------

let ws = null
let connecting = false
let outSeq = 0
let retry = 0
let retryTimer = null
let stopped = false
let pending = new Map()
let callId = 0
let expiresAt = 0
/** This peer's host-assigned id, so presence can hide ourselves. */
let selfId = ''
/** Last patch cursor applied, used to resume instead of re-snapshotting. */
let lastPseq = 0

function setStatus(text, state) {
  UI.status.textContent = text
  UI.dot.className = `dot ${state}`
}

function showGate(title, body) {
  UI.gateTitle.textContent = title
  UI.gateBody.textContent = body
  UI.gate.classList.add('on')
}

function hideGate() {
  UI.gate.classList.remove('on')
}

function setPeers(list) {
  const others = list.filter((peer) => peer.id !== selfId)
  UI.peers.textContent = String(others.length + 2)
  const names = others.map((peer) => `${peer.name}${peer.kind === 'tui' ? ' (tui)' : ''}`).join('、')
  UI.status.title = names ? t('app.otherPeers', { names }) : ''

  const strip = UI.presence
  if (!strip) return
  strip.textContent = ''
  strip.hidden = others.length === 0
  if (others.length === 0) return
  strip.append(el('span', 'presence-name', `${t('app.presence.title')}:`))
  for (const peer of others) {
    const chip = el('span', 'presence-chip')
    chip.append(el('span', 'presence-name', `${peer.name}${peer.kind === 'tui' ? ' (tui)' : ''}`))
    const kind = peer.activity?.kind ?? 'idle'
    if (kind !== 'idle') chip.append(el('span', `presence-state ${kind}`, t(`activity.${kind}`)))
    if (peer.activity?.detail) chip.append(el('span', 'presence-detail', peer.activity.detail))
    strip.append(chip)
  }
}

/** Presence machine: tell the host what this peer is doing (typing is throttled). */
let lastTypingAt = 0
let idleTimer = null
function reportActivity(kind, detail = '') {
  if (!ws || !aesKey) return
  if (kind === 'typing') {
    const at = Date.now()
    if (at - lastTypingAt < 800) return
    lastTypingAt = at
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      reportActivity('idle')
    }, 4000)
  }
  void sendLogical({ v: PROTOCOL, t: 'activity', kind, detail: String(detail).slice(0, 160) })
}

// --- collaborator messages -------------------------------------------------

/** @type {Array<any>} */
let comments = []
let allowComments = true
let anchorNodeId = ''

function upsertComment(comment) {
  if (!comment || typeof comment.seq !== 'number') return
  const index = comments.findIndex((item) => item.seq === comment.seq)
  if (index >= 0) comments[index] = comment
  else comments.push(comment)
}

function commentCard(comment) {
  const card = el('div', 'comment')
  card.append(el('span', 'from', comment.from || 'peer'))
  card.append(document.createTextNode(comment.text || ''))
  if (comment.nodeId) card.append(el('span', 'anchor', `@${comment.nodeId}`))
  return card
}

/** Attach anchored comments to their node, list the rest below the timeline. */
function renderComments() {
  if (!UI.comments) return
  for (const node of UI.timeline.querySelectorAll('.comment-anchor')) node.remove()
  UI.commentsList.textContent = ''
  const loose = []
  for (const comment of comments) {
    let target = null
    if (comment.nodeId) {
      try {
        target = UI.timeline.querySelector('.node[data-id="' + String(comment.nodeId).replace(/"/g, '') + '"]')
      } catch {
        target = null
      }
    }
    const card = commentCard(comment)
    if (target) {
      card.classList.add('comment-anchor')
      target.append(card)
    } else {
      loose.push(card)
    }
  }
  for (const card of loose) UI.commentsList.append(card)
  UI.comments.hidden = loose.length === 0
  if (UI.commentsCount) UI.commentsCount.textContent = String(comments.length)
}

function setAnchor(nodeId) {
  anchorNodeId = nodeId || ''
  if (!UI.anchorChip) return
  UI.anchorChip.hidden = !anchorNodeId
  if (anchorNodeId) UI.anchorChip.textContent = `${t('app.anchor')} @${anchorNodeId} ×`
}

function flashStatus(message) {
  const previous = UI.status.textContent
  UI.status.textContent = message
  setTimeout(() => {
    if (UI.status.textContent === message) UI.status.textContent = previous
  }, 4000)
}

async function sendComment() {
  if (!allowComments) return
  const text = String(UI.commentInput?.value ?? '').trim()
  if (!text) {
    flashStatus(t('app.commentEmpty'))
    return
  }
  await sendLogical({ v: PROTOCOL, t: 'comment', text: text.slice(0, 2000), nodeId: anchorNodeId })
  if (UI.commentInput) UI.commentInput.value = ''
  setAnchor('')
}

function sendLogical(frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !aesKey) return Promise.resolve()
  outSeq += 1
  return seal(outSeq, frame).then((envelope) => {
    ws.send(JSON.stringify({ v: PROTOCOL, t: 'enc', ...envelope }))
  })
}

function call(method, params = {}) {
  callId += 1
  const id = `c${callId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(t('app.timeout')))
    }, 15000)
    pending.set(id, { resolve, reject, timer })
    sendLogical({ v: PROTOCOL, t: 'call', id, method, params })
  })
}

function updateTtl() {
  if (!expiresAt) {
    UI.ttl.textContent = '—'
    return
  }
  const left = expiresAt - Date.now()
  if (left <= 0) {
    UI.ttl.textContent = t('app.expired')
    return
  }
  const minutes = Math.floor(left / 60000)
  UI.ttl.textContent =
    minutes >= 1
      ? t('app.expiresIn', { n: minutes })
      : t('app.expiresSoon', { n: Math.max(1, Math.floor(left / 1000)) })
}

function handleLogical(frame) {
  switch (frame.t) {
    case 'ready': {
      hideGate()
      UI.host.textContent = frame.name || 'host'
      selfId = String(frame.selfId ?? '')
      allowComments = frame.allowComments !== false
      if (UI.composer) UI.composer.hidden = !allowComments
      if (frame.title) document.title = `${frame.title} · dsh-collab`
      expiresAt = Number(frame.expiresAt) || 0
      updateTtl()
      setStatus(t('app.connected'), 'online')
      retry = 0
      break
    }
    case 'snapshot': {
      clearTimeline()
      nodes.clear()
      lastPseq = Number(frame.pseq) || 0
      for (const node of frame.nodes || []) applyOps([{ op: 'append', node: remember(node) }])
      if (frame.truncated) {
        const note = { id: 'truncated', kind: 'notice', text: t('app.historyTruncated') }
        applyOps([{ op: 'append', node: remember(note) }])
      }
      comments = Array.isArray(frame.comments) ? frame.comments.slice() : []
      allowComments = frame.allowComments !== false
      if (UI.composer) UI.composer.hidden = !allowComments
      renderComments()
      scrollLatest(true)
      pinnedToBottom = true
      break
    }
    case 'resume': {
      for (const patch of frame.patches || []) {
        if (patch.pseq <= lastPseq) continue
        applyOps(patch.ops || [])
        lastPseq = patch.pseq
      }
      if (Number.isFinite(frame.to)) lastPseq = Math.max(lastPseq, frame.to)
      scrollLatest()
      break
    }
    case 'patch': {
      const pseq = Number(frame.pseq)
      if (Number.isSafeInteger(pseq) && pseq > 0) {
        if (pseq <= lastPseq) break
        lastPseq = pseq
      }
      applyOps(frame.ops || [])
      break
    }
    case 'presence':
      setPeers(frame.peers || [])
      break
    case 'files':
      renderRoot(frame.root)
      break
    case 'result': {
      const entry = pending.get(frame.id)
      if (!entry) break
      pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.ok) entry.resolve(frame.data)
      else entry.reject(Object.assign(new Error(frame.error?.message || t('app.requestFailed')), { code: frame.error?.code }))
      break
    }
    case 'ping':
      void sendLogical({ v: PROTOCOL, t: 'pong', n: frame.n ?? 0 })
      break
    case 'comment':
      upsertComment(frame.comment)
      renderComments()
      break
    case 'error':
      console.warn('dsh-collab:', frame.code, frame.message)
      if (frame.code === 'E_COMMENT' || frame.code === 'E_RATE') flashStatus(t('app.commentFailed', { message: frame.message }))
      break
    case 'bye':
      stopped = true
      showGate(t('app.gate.endedTitle'), frame.reason || t('app.closedByHost'))
      setStatus(t('app.disconnected'), 'offline')
      break
    default:
      break
  }
}

function scheduleReconnect() {
  if (stopped) return
  retry += 1
  const delay = Math.min(15000, 800 * 2 ** Math.min(retry, 4))
  setStatus(t('app.reconnecting', { n: retry }), 'pending')
  clearTimeout(retryTimer)
  retryTimer = setTimeout(connect, delay)
}

/**
 * Where can this peer reach the host?
 * 1. same origin (the host served this page over LAN),
 * 2. any direct candidate the hub advertises,
 * 3. the hub relay itself (works through NAT).
 */
async function candidateUrls() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const urls = [`${scheme}://${location.host}/ws?room=${encodeURIComponent(ROOM)}`]
  try {
    const response = await fetch(`/hub/room/${encodeURIComponent(ROOM)}`, { cache: 'no-store' })
    if (response.ok) {
      const meta = await response.json()
      for (const origin of meta.direct || []) {
        urls.push(`${String(origin).replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(ROOM)}`)
      }
      urls.push(`${scheme}://${location.host}/hub/peer?room=${encodeURIComponent(ROOM)}`)
    }
  } catch {
    /* no hub here: same-origin is the only candidate */
  }
  return [...new Set(urls)]
}

function handleSocketClosed(event) {
  ws = null
  if (event.code === 4401) {
    stopped = true
    showGate(t('app.gate.invalidTitle'), t('app.gate.invalidBody'))
    setStatus(t('app.disconnected'), 'offline')
    return
  }
  if (event.code === 4404) {
    stopped = true
    showGate(t('app.gate.roomGoneTitle'), t('app.gate.roomGoneBody'))
    setStatus(t('app.disconnected'), 'offline')
    return
  }
  if (event.code === 1009) {
    stopped = true
    showGate(t('app.gate.tooLargeTitle'), t('app.gate.tooLargeBody'))
    return
  }
  scheduleReconnect()
}

/** Try one candidate; resolves once the encrypted handshake completes. */
function attempt(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const relay = url.includes('/hub/peer')
    let peerNonce = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      reject(new Error('handshake timeout'))
    }, timeoutMs)

    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      reject(error)
    }

    /** Relay candidates wrap every protocol frame in the hub envelope. */
    const sendFrame = (frame) => {
      const text = JSON.stringify(frame)
      socket.send(relay ? JSON.stringify({ v: PROTOCOL, t: 'relay', payload: text }) : text)
    }

    socket.onopen = () => {
      sendFrame({ v: PROTOCOL, t: 'hello', room: ROOM, client: { kind: 'web', name: 'web', caps: ['files'] } })
    }

    socket.onmessage = async (event) => {
      let frame
      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }
      if (relay) {
        if (frame.t === 'attached') return
        if (frame.t === 'close') {
          stopped = true
          showGate(t('app.gate.endedTitle'), frame.reason || t('app.closedByHost'))
          setStatus(t('app.disconnected'), 'offline')
          fail(new Error('relay closed'))
          return
        }
        if (frame.t !== 'relay') return
        try {
          frame = JSON.parse(frame.payload)
        } catch {
          return
        }
      }
      if (frame.t === 'challenge') {
        peerNonce = randomNonce()
        const signature = await proof([frame.nonce, ROOM, peerNonce])
        sendFrame({
          v: PROTOCOL,
          t: 'join',
          room: ROOM,
          proof: signature,
          peerNonce,
          resumeFrom: lastPseq,
          kind: 'web',
          name: 'web',
        })
        return
      }
      if (frame.t === 'enc') {
        let logical
        try {
          logical = await openFrame(frame)
        } catch {
          return
        }
        if (logical.t === 'ready' && !settled) {
          const expected = await proof([peerNonce, ROOM, 'host'])
          if (logical.hostProof !== expected) {
            fail(new Error('host proof mismatch'))
            return
          }
          settled = true
          clearTimeout(timer)
          retry = 0
          ws = socket
          socket.onclose = handleSocketClosed
          resolve(logical)
          handleLogical(logical)
          return
        }
        handleLogical(logical)
        return
      }
      if (frame.t === 'close') {
        stopped = true
        showGate(t('app.gate.endedTitle'), frame.reason || t('app.closedByHost'))
        setStatus(t('app.disconnected'), 'offline')
        try {
          socket.close()
        } catch {
          /* ignore */
        }
      }
    }

    socket.onclose = (event) => {
      if (!settled) fail(new Error(`closed ${event.code}`))
    }
    socket.onerror = () => {}
  })
}

async function connect() {
  clearTimeout(retryTimer)
  if (connecting || stopped) return
  connecting = true
  try {
    if (!aesKey) {
      try {
        await initCrypto()
      } catch (error) {
        stopped = true
        showGate(t('app.gate.unavailableTitle'), error.message)
        setStatus(t('app.cannotConnect'), 'offline')
        return
      }
    }
    if (ws) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      ws = null
    }
    setStatus(retry === 0 ? t('app.connecting') : t('app.reconnecting', { n: retry }), 'pending')
    for (const url of await candidateUrls()) {
      if (stopped) return
      const relay = url.includes('/hub/peer')
      try {
        const ready = await attempt(url, relay ? 6000 : 1800)
        setStatus(ready?.via === 'relay' ? t('app.connectedRelay') : t('app.connected'), 'online')
        hideGate()
        return
      } catch {
        /* try the next candidate */
      }
    }
    scheduleReconnect()
  } finally {
    connecting = false
  }
}

// ---------- file drawer ----------

const treeState = new Map() // path → {open, loaded, entries}

function renderRoot(root) {
  UI.tree.textContent = ''
  treeState.clear()
  if (!root) return
  treeState.set('', { open: true, loaded: true, entries: root.entries || [] })
  const fragment = document.createDocumentFragment()
  appendEntries(fragment, '', root.entries || [], 0)
  UI.tree.append(fragment)
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function appendEntries(container, parent, entries, depth) {
  for (const entry of entries) {
    const row = el('div', `row ${entry.kind === 'directory' ? 'dir' : 'file'}`)
    row.style.paddingLeft = `${8 + depth * 14}px`
    row.dataset.path = entry.path
    const caret = el('span', 'caret', entry.kind === 'directory' ? '▸' : '')
    const icon = el('span', 'ico', entry.kind === 'directory' ? '📁' : '📄')
    const label = el('span', 'label', entry.name)
    row.append(caret, icon, label)
    if (entry.kind === 'file') row.append(el('span', 'size', formatSize(entry.size)))
    container.append(row)

    if (entry.kind === 'directory') {
      const holder = el('div', 'children')
      holder.hidden = true
      container.append(holder)
      row.addEventListener('click', () => toggleDir(row, holder, entry.path, depth + 1))
    } else {
      row.addEventListener('click', () => openFile(entry.path))
    }
  }
}

async function toggleDir(row, holder, path, depth) {
  const caret = row.querySelector('.caret')
  const state = treeState.get(path)
  if (state?.open) {
    state.open = false
    holder.hidden = true
    if (caret) caret.textContent = '▸'
    reportActivity('browsing', path || '.')
    return
  }
  reportActivity('browsing', path || '.')
  if (!state?.loaded) {
    row.style.opacity = '.6'
    try {
      const listing = await call('files.list', { path })
      treeState.set(path, { open: true, loaded: true, entries: listing.entries || [] })
      holder.textContent = ''
      appendEntries(holder, path, listing.entries || [], depth)
    } catch (error) {
      row.style.opacity = '1'
      holder.hidden = false
      holder.textContent = ''
      holder.append(el('div', 'row muted', t('app.dirUnreadable', { message: error.message })))
      return
    } finally {
      row.style.opacity = '1'
    }
  } else {
    treeState.set(path, { ...state, open: true })
  }
  holder.hidden = false
  if (caret) caret.textContent = '▾'
}

async function openFile(path) {
  reportActivity('reading', path)
  UI.preview.hidden = false
  UI.previewPath.textContent = path
  UI.previewMeta.textContent = t('app.reading')
  UI.previewBody.textContent = ''
  try {
    const file = await call('files.read', { path })
    UI.previewMeta.textContent = file.binary
      ? `${t('app.binary')} · ${formatSize(file.bytes)}`
      : `${formatSize(file.bytes)}${file.truncated ? ` · ${t('app.truncated')}` : ''}${file.redactions ? ` · ${t('app.redacted')}` : ''}`
    UI.previewBody.textContent = file.binary
      ? t('app.binaryBody', { size: formatSize(file.bytes) })
      : file.text || t('app.emptyFile')
  } catch (error) {
    UI.previewMeta.textContent = t('app.readFailed')
    UI.previewBody.textContent = `${error.code || 'ERROR'}: ${error.message}`
  }
}

async function runSearch(query) {
  if (!query || query.trim().length < 2) return
  reportActivity('searching', query.trim())
  UI.tree.textContent = ''
  UI.tree.append(el('div', 'row muted', t('app.searching')))
  try {
    const data = await call('files.search', { query: query.trim(), maxResults: 50 })
    UI.tree.textContent = ''
    if (!data.matches.length) {
      UI.tree.append(el('div', 'row muted', t('app.noMatch')))
      return
    }
    for (const match of data.matches) {
      const row = el('div', 'row file')
      row.append(el('span', 'ico', '🔎'), el('span', 'label', `${match.path}:${match.line}`))
      row.title = match.preview
      row.addEventListener('click', () => openFile(match.path))
      UI.tree.append(row)
    }
    if (data.truncated) UI.tree.append(el('div', 'row muted', t('app.searchTruncated')))
  } catch (error) {
    UI.tree.textContent = ''
    UI.tree.append(el('div', 'row err', t('app.searchFailed', { message: error.message })))
  }
}

// ---------- wiring ----------

$('toggle-files').addEventListener('click', async () => {
  UI.drawer.hidden = !UI.drawer.hidden
  if (!UI.drawer.hidden && !treeState.get('')?.loaded) {
    try {
      const listing = await call('files.list', { path: '' })
      renderRoot(listing)
    } catch (error) {
      UI.tree.textContent = ''
      UI.tree.append(el('div', 'row err', t('app.workspaceUnreadable', { message: error.message })))
    }
  }
})

$('close-files').addEventListener('click', () => {
  UI.drawer.hidden = true
})

$('close-preview').addEventListener('click', () => {
  UI.preview.hidden = true
})

$('jump-latest').addEventListener('click', () => {
  pinnedToBottom = true
  scrollLatest(true)
})

if (UI.commentSend) UI.commentSend.addEventListener('click', () => void sendComment())
if (UI.commentInput) {
  UI.commentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendComment()
    }
  })
  UI.commentInput.addEventListener('input', () => reportActivity('typing', 'comment'))
}
if (UI.anchorChip) UI.anchorChip.addEventListener('click', () => setAnchor(''))
UI.timeline.addEventListener('click', (event) => {
  if (!allowComments) return
  const node = event.target instanceof Element ? event.target.closest('.node') : null
  if (!node || !node.dataset.id) return
  if (event.target.closest('.comment')) return
  setAnchor(node.dataset.id)
  reportActivity('typing', 'comment')
})

UI.search.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void runSearch(UI.search.value)
  }
})

UI.search.addEventListener('input', () => {
  reportActivity('typing', 'search')
})

document.addEventListener('visibilitychange', () => {
  if (document.hidden) reportActivity('idle')
})

const langButton = $('lang')
if (langButton) langButton.addEventListener('click', () => toggleLang())

UI.gateRetry.addEventListener('click', () => {
  stopped = false
  retry = 0
  hideGate()
  void connect()
})

setInterval(updateTtl, 10000)

if (!ROOM) {
  showGate(t('app.gate.incompleteTitle'), t('app.gate.incompleteBody'))
} else if (!SECRET) {
  showGate(t('app.gate.missingTitle'), t('app.gate.missingBody'))
} else {
  void connect()
}
