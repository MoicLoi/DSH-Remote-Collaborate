// Snapshot export: one room's structured view plus peer comments as Markdown.
//
// Export is read-only and host-side; it never mutates the room and reuses the
// same projection the share page renders, so a peer's view and the file agree.
const KIND_LABEL = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  turn: '轮次',
  notice: '提示',
}

function oneLine(text, limit = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * @param {any} room
 * @param {{at?: number}} [options]
 * @returns {{ markdown: string, bytes: number, nodes: number, comments: number }}
 */
export function renderRoomMarkdown(room, options = {}) {
  const snapshot = room.snapshot()
  const at = options.at ?? Date.now()
  const nodes = snapshot.nodes ?? []
  const comments = snapshot.comments ?? []
  const lines = []

  lines.push(`# ${room.title || 'dsh-collab 快照'} (${room.code})`, '')
  lines.push(`- 房间：\`${room.code}\``)
  lines.push(`- 会话：\`${room.sessionId}\``)
  lines.push(`- 工作区：\`${room.cwd}\``)
  lines.push(`- 导出时间：${new Date(at).toISOString()}`)
  lines.push(`- 节点：${nodes.length} · 留言：${comments.length}`)
  lines.push('')

  let turn = 0
  for (const node of nodes) {
    if (node.kind === 'turn') {
      turn += 1
      lines.push(`## 轮次 ${turn}`, '')
      continue
    }
    if (node.kind === 'user') {
      lines.push('**用户**', '', String(node.text ?? '').trim() || '（空）', '')
      continue
    }
    if (node.kind === 'assistant') {
      lines.push('**助手**', '', String(node.text ?? '').trim() || '（空）', '')
      continue
    }
    if (node.kind === 'tool') {
      const tool = node.tool ?? node
      const name = tool.name ?? node.name ?? 'tool'
      const status = tool.status ?? node.status
      const detail = tool.text ?? node.text
      lines.push(`- ${KIND_LABEL.tool} \`${name}\`${status ? ` · ${status}` : ''}${detail ? `：${oneLine(detail)}` : ''}`)
      continue
    }
    if (node.kind === 'notice') {
      lines.push(`> ${oneLine(node.text)}`)
      continue
    }
    lines.push(`- ${KIND_LABEL[node.kind] ?? node.kind}：${oneLine(node.text)}`)
  }
  lines.push('')

  lines.push(`## 协作者留言（${comments.length}）`, '')
  if (!comments.length) {
    lines.push('_没有留言。_')
  } else {
    for (const comment of comments) {
      const anchor = comment.nodeId ? ` · 锚点 \`${comment.nodeId}\`` : ''
      lines.push(`- **${comment.from}**${anchor}：${String(comment.text ?? '').trim()}`)
    }
  }
  lines.push('')

  const markdown = lines.join('\n')
  return { markdown, bytes: Buffer.byteLength(markdown, 'utf8'), nodes: nodes.length, comments: comments.length }
}

/** JSON variant for tooling that wants structure instead of prose. */
export function renderRoomJson(room, options = {}) {
  const snapshot = room.snapshot()
  const payload = {
    at: options.at ?? Date.now(),
    code: room.code,
    sessionId: room.sessionId,
    cwd: room.cwd,
    title: room.title,
    pseq: snapshot.pseq,
    nodes: snapshot.nodes ?? [],
    comments: snapshot.comments ?? [],
  }
  return { json: JSON.stringify(payload, null, 2), nodes: payload.nodes.length, comments: payload.comments.length }
}
