// Host console: polls the local admin API and renders live rooms.
// The page never touches the collaboration protocol — it only manages rooms.
import { applyStaticText, lang, t, toggleLang } from './i18n.js'

applyStaticText()

const TOKEN = new URLSearchParams(location.search).get('t') || ''
const ui = {
  rows: document.getElementById('rows'),
  table: document.getElementById('rooms'),
  empty: document.getElementById('empty'),
  badges: document.getElementById('badges'),
  toast: document.getElementById('toast'),
  refresh: document.getElementById('refresh'),
  lang: document.getElementById('lang'),
}

ui.lang.addEventListener('click', () => toggleLang())
ui.lang.textContent = t('admin.langButton')
document.title = t('admin.title')

function headers(extra = {}) {
  return { 'x-collab-admin': '1', ...(TOKEN ? { 'x-collab-admin-token': TOKEN } : {}), ...extra }
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', headers: headers(options.headers), ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(data.message || `HTTP ${response.status}`), { code: data.error, status: response.status })
  }
  return data
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function toast(message, tone = 'ok') {
  ui.toast.textContent = message
  ui.toast.className = `console-toast ${tone}`
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => {
    ui.toast.textContent = ''
  }, 4000)
}

function formatLeft(expiresAt, now) {
  const left = Number(expiresAt) - Number(now)
  if (!Number.isFinite(left)) return '—'
  if (left <= 0) return t('app.expired')
  if (left < 60_000) return t('app.expiresSoon', { n: Math.max(1, Math.floor(left / 1000)) })
  return t('app.expiresIn', { n: Math.floor(left / 60_000) })
}

function renderBadges(state) {
  ui.badges.textContent = ''
  const add = (label, value, tone) => {
    const badge = el('span', `badge ${tone ?? ''}`)
    badge.append(el('b', null, label), document.createTextNode(` ${value}`))
    ui.badges.append(badge)
  }
  add(t('admin.mode'), state.mode)
  if (state.hub?.url) add(t('admin.hub'), `${state.hub.url} · ${state.hub.registered ? t('admin.hubOn') : t('admin.hubOff')}`, state.hub.registered ? 'ok' : 'warn')
  if (state.direct?.length) add(t('admin.direct'), state.direct.join(' '))
  add(t('admin.files'), state.files)
  add(t('admin.streaming'), state.streaming ? t('admin.on') : t('admin.off'))
}

function renderRows(state) {
  ui.rows.textContent = ''
  ui.empty.hidden = state.rooms.length > 0
  ui.table.hidden = state.rooms.length === 0
  for (const room of state.rooms) {
    const row = el('tr')
    row.append(el('td', 'code', room.code))
    const session = el('td', 'session')
    session.append(el('div', null, room.title || room.sessionId))
    session.append(el('div', 'muted small', room.cwd))
    row.append(session)
    const peers = el('td', 'peers')
    peers.append(el('div', null, String(room.peers)))
    const list = room.peersList ?? []
    if (list.length === 0) {
      peers.append(el('div', 'muted small', t('admin.noPeers')))
    }
    for (const peer of list) {
      const chip = el('div', 'peer-chip')
      chip.append(el('span', 'peer-name', peer.name + (peer.kind === 'tui' ? ' (tui)' : '')))
      const badge = el('span', `activity ${peer.activity?.kind ?? 'idle'}`, t(`activity.${peer.activity?.kind ?? 'idle'}`))
      chip.append(badge)
      if (peer.activity?.detail) chip.append(el('span', 'peer-detail', peer.activity.detail))
      peers.append(chip)
    }
    row.append(peers)
    row.append(el('td', 'expires', formatLeft(room.expiresAt, state.now)))
    row.append(el('td', 'audit', room.audit ? t('admin.auditEvents', { n: room.audit.events }) : '—'))

    const actions = el('td', 'actions')
    const rotate = el('button', null, t('admin.rotate'))
    rotate.type = 'button'
    rotate.addEventListener('click', () => rotateRoom(room.code))
    const close = el('button', 'danger', t('admin.close'))
    close.type = 'button'
    close.addEventListener('click', () => closeRoom(room.code))
    actions.append(rotate, close)
    row.append(actions)
    ui.rows.append(row)
  }
}

async function load() {
  try {
    const state = await api(TOKEN ? `/collab/api/state?t=${encodeURIComponent(TOKEN)}` : '/collab/api/state')
    renderBadges(state)
    renderRows(state)
  } catch (error) {
    ui.table.hidden = true
    ui.empty.hidden = true
    toast(`${t('admin.actionFailed', { message: error.message })}`, 'error')
  }
}

async function rotateRoom(code) {
  try {
    const result = await api(`/collab/api/rooms/${code}/rotate`, { method: 'POST' })
    toast(t('admin.rotated', { link: result.link }))
    await load()
  } catch (error) {
    toast(t('admin.actionFailed', { message: error.message }), 'error')
  }
}

async function closeRoom(code) {
  if (!confirm(t('admin.confirmClose', { code }))) return
  try {
    await api(`/collab/api/rooms/${code}/close`, { method: 'POST' })
    toast(t('admin.closed'))
    await load()
  } catch (error) {
    toast(t('admin.actionFailed', { message: error.message }), 'error')
  }
}

ui.refresh.addEventListener('click', () => load())

void load()
setInterval(() => {
  if (!document.hidden) void load()
}, 2000)
