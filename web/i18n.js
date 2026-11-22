// Tiny i18n for the peer page and the host console.
// Language: ?lang=zh|en → localStorage → navigator.language. No framework, no fetch.
const STORAGE_KEY = 'dsh-collab-lang'

const DICT = {
  zh: {
    'app.title': 'dsh-collab · 协作观看',
    'app.room': '房间',
    'app.host': '主机',
    'app.peers': '在线',
    'app.files': '文件',
    'app.latest': '最新',
    'app.connected': '已连接 · 只读',
    'app.connectedRelay': '已连接 · 只读 · 经中心机',
    'app.connecting': '连接中…',
    'app.reconnecting': '重连中（{n}）…',
    'app.disconnected': '已断开',
    'app.cannotConnect': '无法建立会话',
    'app.footer': '只读 · 结构化视图（无视频流）',
    'app.searchPlaceholder': '在工作区搜索（≥2 字）',
    'app.close': '关闭',
    'app.collapse': '收起',
    'app.retry': '重试',
    'app.expiresIn': '{n}m 后到期',
    'app.expiresSoon': '{n}s 后到期',
    'app.expired': '链接已到期',
    'app.gate.interrupted': '连接中断',
    'app.gate.invalidTitle': '链接无效或已刷新',
    'app.gate.invalidBody': '请向主机索取新链接。',
    'app.gate.missingTitle': '链接缺少密钥',
    'app.gate.missingBody': '链接的 #k= 部分丢失了（常见于聊天软件截断）。请让主机重新发一次。',
    'app.gate.incompleteTitle': '链接不完整',
    'app.gate.incompleteBody': '地址里没有房间码。请使用主机分享的完整链接。',
    'app.gate.endedTitle': '链接已结束',
    'app.gate.roomGoneTitle': '房间不存在',
    'app.gate.roomGoneBody': '这个房间已过期或已被主机关闭。',
    'app.gate.tooLargeTitle': '消息过大',
    'app.gate.tooLargeBody': '连接因超出帧大小上限被关闭。',
    'app.gate.unavailableTitle': '链接不可用',
    'app.gate.hostProofTitle': '主机校验失败',
    'app.gate.hostProofBody': '对方无法证明持有同一条链接的密钥，连接已中止。',
    'app.historyTruncated': '更早的历史未发送（快照有上限）',
    'app.emptyMessage': '（空消息）',
    'app.loading': '读取中…',
    'app.reading': '读取中…',
    'app.binary': '二进制',
    'app.truncated': '已截断',
    'app.redacted': '已脱敏',
    'app.emptyFile': '（空文件）',
    'app.binaryBody': '（二进制文件，不传输内容）\n大小：{size}',
    'app.binaryBodyNoSize': '（二进制文件，不传输内容）',
    'app.readFailed': '读取失败',
    'app.searchFailed': '搜索失败：{message}',
    'app.noMatch': '没有匹配',
    'app.searchTruncated': '结果已截断',
    'app.searching': '搜索中…',
    'app.dirUnreadable': '无法读取：{message}',
    'app.toolRunning': '运行中',
    'app.toolDone': '完成',
    'app.toolFailed': '失败',
    'app.otherPeers': '其他协作者：{names}',
    'app.presence.title': '在场',
    'activity.idle': '空闲',
    'activity.typing': '输入中',
    'activity.reading': '查看文件',
    'activity.browsing': '浏览目录',
    'activity.searching': '搜索中',
    'admin.activity': '当前活动',
    'admin.noPeers': '暂无协作者',
    'app.timeout': '请求超时',
    'app.requestFailed': '请求失败',
    'app.closedByHost': '主机关闭了协作会话',
    'app.workspaceUnreadable': '无法读取工作区：{message}',
    'app.langButton': 'EN',
    'app.comments': '协作者留言',
    'app.commentPlaceholder': '说点什么（会广播给房间）…',
    'app.send': '发送',
    'app.anchor': '回复某条',
    'app.clearAnchor': '取消锚点',
    'app.commentFailed': '发送失败：{message}',
    'app.commentEmpty': '消息不能为空',
    'admin.title': 'dsh-collab 主机控制台',
    'admin.subtitle': '只读协作房间的实时状态。此页面仅本机可访问（或需要 adminToken）。',
    'admin.loading': '加载中…',
    'admin.rooms': '房间',
    'admin.noRooms': '还没有协作房间。在会话里发 /collab 创建。',
    'admin.code': '房间码',
    'admin.session': '会话',
    'admin.peers': '在线',
    'admin.expires': '到期',
    'admin.audit': '审计',
    'admin.actions': '操作',
    'admin.rotate': '刷新链接',
    'admin.close': '关闭',
    'admin.refresh': '刷新',
    'admin.mode': '模式',
    'admin.hub': '中心机',
    'admin.hubOn': '已注册',
    'admin.hubOff': '未连接',
    'admin.direct': '直连候选',
    'admin.files': '文件来源',
    'admin.streaming': '流式',
    'admin.on': '开',
    'admin.off': '关',
    'admin.unauthorized': '未授权',
    'admin.unauthorizedBody': '这个控制台只允许本机访问；远程访问需要配置 adminToken 并带上 ?t=。',
    'admin.confirmClose': '关闭房间 {code}？所有协作者会立即断开。',
    'admin.rotated': '已刷新：{link}',
    'admin.closed': '房间已关闭',
    'admin.actionFailed': '操作失败：{message}',
    'admin.auditEvents': '{n} 次访问',
    'admin.peerNames': '协作者：{names}',
    'admin.tokenRequired': '需要 adminToken',
    'admin.langButton': 'EN',
  },
  en: {
    'app.title': 'dsh-collab · live view',
    'app.room': 'Room',
    'app.host': 'Host',
    'app.peers': 'Online',
    'app.files': 'Files',
    'app.latest': 'Latest',
    'app.connected': 'Connected · read-only',
    'app.connectedRelay': 'Connected · read-only · via hub',
    'app.connecting': 'Connecting…',
    'app.reconnecting': 'Reconnecting ({n})…',
    'app.disconnected': 'Disconnected',
    'app.cannotConnect': 'Cannot establish session',
    'app.footer': 'Read-only · structured view (no video)',
    'app.searchPlaceholder': 'Search the workspace (2+ chars)',
    'app.close': 'Close',
    'app.collapse': 'Collapse',
    'app.retry': 'Retry',
    'app.expiresIn': 'expires in {n}m',
    'app.expiresSoon': 'expires in {n}s',
    'app.expired': 'Link expired',
    'app.gate.interrupted': 'Connection lost',
    'app.gate.invalidTitle': 'Link invalid or rotated',
    'app.gate.invalidBody': 'Ask the host for a new link.',
    'app.gate.missingTitle': 'Link is missing its key',
    'app.gate.missingBody': 'The #k= part was lost (chat apps often truncate it). Ask the host to resend.',
    'app.gate.incompleteTitle': 'Incomplete link',
    'app.gate.incompleteBody': 'No room code in the address. Use the full link the host shared.',
    'app.gate.endedTitle': 'Link ended',
    'app.gate.roomGoneTitle': 'Room not found',
    'app.gate.roomGoneBody': 'This room expired or was closed by the host.',
    'app.gate.tooLargeTitle': 'Frame too large',
    'app.gate.tooLargeBody': 'The connection was closed for exceeding the frame limit.',
    'app.gate.unavailableTitle': 'Link unusable',
    'app.gate.hostProofTitle': 'Host check failed',
    'app.gate.hostProofBody': 'The other side could not prove it holds the same link key; the connection was aborted.',
    'app.historyTruncated': 'Older history was not sent (snapshot limit)',
    'app.emptyMessage': '(empty message)',
    'app.loading': 'Loading…',
    'app.reading': 'Loading…',
    'app.binary': 'binary',
    'app.truncated': 'truncated',
    'app.redacted': 'redacted',
    'app.emptyFile': '(empty file)',
    'app.binaryBody': '(binary file, contents are not transferred)\nSize: {size}',
    'app.binaryBodyNoSize': '(binary file, contents are not transferred)',
    'app.readFailed': 'Read failed',
    'app.searchFailed': 'Search failed: {message}',
    'app.noMatch': 'No matches',
    'app.searchTruncated': 'Results truncated',
    'app.searching': 'Searching…',
    'app.dirUnreadable': 'Cannot read: {message}',
    'app.toolRunning': 'running',
    'app.toolDone': 'done',
    'app.toolFailed': 'failed',
    'app.presence.title': 'Here now',
    'activity.idle': 'idle',
    'activity.typing': 'typing',
    'activity.reading': 'viewing a file',
    'activity.browsing': 'browsing',
    'activity.searching': 'searching',
    'admin.activity': 'Current activity',
    'admin.noPeers': 'No collaborators yet',
    'app.timeout': 'Request timed out',
    'app.requestFailed': 'Request failed',
    'app.closedByHost': 'the host closed the collaboration session',
    'app.workspaceUnreadable': 'Cannot read the workspace: {message}',
    'app.langButton': '中',
    'app.comments': 'Collaborator messages',
    'app.commentPlaceholder': 'Say something (broadcast to the room)…',
    'app.send': 'Send',
    'app.anchor': 'Reply to a node',
    'app.clearAnchor': 'Clear anchor',
    'app.commentFailed': 'Send failed: {message}',
    'app.commentEmpty': 'Message cannot be empty',
    'admin.title': 'dsh-collab host console',
    'admin.subtitle': 'Live state of read-only collaboration rooms. Loopback-only (or requires adminToken).',
    'admin.loading': 'Loading…',
    'admin.rooms': 'Rooms',
    'admin.noRooms': 'No rooms yet. Run /collab in a session to create one.',
    'admin.code': 'Room',
    'admin.session': 'Session',
    'admin.peers': 'Online',
    'admin.expires': 'Expires',
    'admin.audit': 'Audit',
    'admin.actions': 'Actions',
    'admin.rotate': 'Rotate link',
    'admin.close': 'Close',
    'admin.refresh': 'Refresh',
    'admin.mode': 'Mode',
    'admin.hub': 'Hub',
    'admin.hubOn': 'registered',
    'admin.hubOff': 'not connected',
    'admin.direct': 'Direct candidates',
    'admin.files': 'Files',
    'admin.streaming': 'Streaming',
    'admin.on': 'on',
    'admin.off': 'off',
    'admin.unauthorized': 'Not authorized',
    'admin.unauthorizedBody': 'This console is loopback-only; remote access needs an adminToken and ?t=.',
    'admin.confirmClose': 'Close room {code}? Every collaborator is disconnected immediately.',
    'admin.rotated': 'Rotated: {link}',
    'admin.closed': 'Room closed',
    'admin.actionFailed': 'Action failed: {message}',
    'admin.auditEvents': '{n} accesses',
    'admin.peerNames': 'Collaborators: {names}',
    'admin.tokenRequired': 'adminToken required',
    'admin.langButton': 'EN',
  },
}

function detectLang() {
  try {
    const query = new URLSearchParams(location.search).get('lang')
    if (query === 'zh' || query === 'en') return query
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
    /* ignore */
  }
  const nav = String(navigator.language ?? '')
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export const lang = detectLang()

/**
 * Translate one key.
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function t(key, params) {
  const table = DICT[lang] ?? DICT.zh
  let text = table[key] ?? DICT.zh[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** Apply `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` attributes. */
export function applyStaticText(root = document) {
  document.documentElement.lang = lang === 'zh' ? 'zh' : 'en'
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.getAttribute('data-i18n'))
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')))
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    node.setAttribute('title', t(node.getAttribute('data-i18n-title')))
  }
}

/** Flip language and reload (the page is cheap to rebuild). */
export function toggleLang() {
  const next = lang === 'zh' ? 'en' : 'zh'
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* ignore */
  }
  const url = new URL(location.href)
  url.searchParams.set('lang', next)
  location.replace(url.toString())
}
