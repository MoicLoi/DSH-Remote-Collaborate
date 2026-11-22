// dsh-collab client half — the in-conversation settings section.
//
// Plain CommonJS-style source, wrapped into the DSH client module envelope by
// `client/build.mjs`. No JSX, no bundler, no imports beyond `react` (which the
// client module table provides): one less build step between here and the GUI.
const React = require('react')

const h = React.createElement

const POLL_MS = 3000

const S = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '4px 2px 8px',
    fontSize: 13,
    lineHeight: 1.5,
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    flexWrap: 'wrap',
  },
  title: { fontWeight: 600, fontSize: 14 },
  hint: { opacity: 0.7, fontSize: 12 },
  badges: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  badge: {
    border: '1px solid rgba(127,127,127,.35)',
    borderRadius: 999,
    padding: '1px 9px',
    fontSize: 11.5,
    opacity: 0.85,
  },
  room: {
    border: '1px solid rgba(127,127,127,.3)',
    borderRadius: 10,
    padding: '9px 11px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  code: { fontFamily: 'ui-monospace, Consolas, monospace', fontWeight: 600, letterSpacing: '.5px' },
  link: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    fontSize: 11.5,
    opacity: 0.85,
    wordBreak: 'break-all',
    flex: '1 1 16ch',
    minWidth: 0,
  },
  button: {
    font: 'inherit',
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 7,
    border: '1px solid rgba(127,127,127,.4)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: {
    fontSize: 11.5,
    padding: '0 7px',
    borderRadius: 999,
    border: '1px solid rgba(127,127,127,.35)',
  },
  error: { color: '#ff8a8a', fontSize: 12 },
}

const ACTIVITY = {
  idle: '空闲',
  typing: '输入中',
  reading: '查看文件',
  browsing: '浏览目录',
  searching: '搜索中',
}

function useState(initial) {
  return React.useState(initial)
}

function usePoll() {
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)

  React.useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const response = await fetch('/collab-panel/state', { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        if (!alive) return
        setState(data)
        setError(null)
      } catch (cause) {
        if (!alive) return
        setError(cause?.message ?? 'request failed')
      }
    }
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return { state, error }
}

function formatLeft(expiresAt, now) {
  const left = Number(expiresAt) - Number(now ?? Date.now())
  if (!Number.isFinite(left)) return '—'
  if (left <= 0) return '已到期'
  if (left < 60_000) return `${Math.max(1, Math.floor(left / 1000))}s`
  return `${Math.floor(left / 60_000)}m`
}

function Room({ room, now, onCopy }) {
  const peers = room.peersList ?? []
  return h(
    'div',
    { style: S.room },
    h(
      'div',
      { style: S.row },
      h('span', { style: S.code }, room.code),
      h('span', { style: S.hint }, `${room.peers} 人在线 · ${formatLeft(room.expiresAt, now)} 后到期`),
      h('span', { style: { flex: 1 } }),
      h('button', { type: 'button', style: S.button, onClick: () => onCopy(room.link) }, '复制链接'),
      h('a', { href: room.console, target: '_blank', rel: 'noreferrer', style: { ...S.button, textDecoration: 'none' } }, '控制台'),
    ),
    h('div', { style: S.link }, room.link),
    peers.length
      ? h(
          'div',
          { style: S.chips },
          peers.map((peer) =>
            h(
              'span',
              { key: `${peer.name}-${peer.kind}`, style: S.chip },
              `${peer.name}${peer.kind === 'tui' ? ' (tui)' : ''} · ${ACTIVITY[peer.activity?.kind] ?? '空闲'}${
                peer.activity?.detail ? ` ${peer.activity.detail}` : ''
              }`,
            ),
          ),
        )
      : h('div', { style: S.hint }, '还没有协作者加入'),
  )
}

function CollabSection() {
  const { state, error } = usePoll()
  const [copied, setCopied] = useState('')

  const copy = async (link) => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(link)
      setTimeout(() => setCopied(''), 2000)
    } catch {
      setCopied('')
    }
  }

  const rooms = state?.rooms ?? []
  const now = state?.now ?? Date.now()

  return h(
    'section',
    { style: S.root },
    h(
      'div',
      { style: S.header },
      h('span', { style: S.title }, '协作'),
      h('span', { style: S.hint }, '把当前会话只读分享给别人'),
    ),
    h(
      'div',
      { style: S.badges },
      state
        ? [
            h('span', { key: 'mode', style: S.badge }, `模式 ${state.mode}`),
            h('span', { key: 'files', style: S.badge }, `文件 ${state.files}`),
            h('span', { key: 'stream', style: S.badge }, `流式 ${state.streaming ? '开' : '关'}`),
            state.hub ? h('span', { key: 'hub', style: S.badge }, `中心机 ${state.hub.registered ? '已注册' : '未连接'}`) : null,
          ].filter(Boolean)
        : h('span', { style: S.hint }, '读取中…'),
    ),
    error ? h('div', { style: S.error }, `无法读取协作状态：${error}`) : null,
    copied ? h('div', { style: S.hint }, '链接已复制') : null,
    rooms.length
      ? rooms.map((room) => h(Room, { key: room.code, room, now, onCopy: copy }))
      : h('div', { style: S.hint }, '还没有协作房间。在会话里输入 /collab，或让 agent 调用 collab_share。'),
    h('div', { style: S.hint }, '协作者只能看结构化会话视图和工作区文件，不能写、不能执行命令。'),
  )
}

module.exports = {
  name: 'dsh-collab',
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'dsh-collab',
          order: 200,
          label: () => '协作',
        },
        CollabSection,
      ),
    )
  },
}
