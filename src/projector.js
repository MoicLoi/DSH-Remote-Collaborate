// Session → ViewNode projection.
//
// This is the "structured instead of video" core: session events are folded into a
// small, bounded list of semantic nodes that a browser or a terminal can render.
// The projector is pure with respect to the host: it never mutates the session,
// never awaits, and treats unknown events as no-ops so a DSH upgrade cannot break
// a running room.
import { LIMITS } from './protocol.js'

const TEXT_TYPES = new Set(['text'])

/** Flatten a message/`content` value into plain text. */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (typeof block === 'string') {
      out += block
      continue
    }
    if (!block || typeof block !== 'object') continue
    if (TEXT_TYPES.has(block.type) && typeof block.text === 'string') out += block.text
    else if (block.type === 'tool-result') out += textOf(block.content)
    else if (typeof block.text === 'string') out += block.text
  }
  return out
}

function clip(text, max = LIMITS.maxNodeText) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`
}

function oneLine(text, max = 200) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function eventType(event) {
  return String(event?.type ?? event?.kind ?? '')
}

function eventData(event) {
  return event?.data && typeof event.data === 'object' ? event.data : {}
}

/**
 * @param {{maxNodes?: number, maxNodeText?: number, now?: () => number}} [options]
 */
export function createProjector(options = {}) {
  const maxNodes = options.maxNodes ?? LIMITS.maxSnapshotNodes
  const maxNodeText = options.maxNodeText ?? LIMITS.maxNodeText
  const now = options.now ?? (() => Date.now())

  /** @type {any[]} */
  let nodes = []
  const byId = new Map()
  /** @type {Map<string, string>} callId → node id */
  const toolByCall = new Map()
  let seq = 0
  let turn = 0
  let step = 0
  let counter = 0
  let dropped = 0
  /** Open assistant text stream, if a token-level delta arrived. */
  let streamNode = null
  let streamBytes = 0

  function trim() {
    if (nodes.length <= maxNodes) return
    const excess = nodes.length - maxNodes
    const removed = nodes.splice(0, excess)
    dropped += removed.length
    for (const node of removed) {
      byId.delete(node.id)
      if (node.tool?.callId) toolByCall.delete(node.tool.callId)
      if (streamNode && node.id === streamNode.id) {
        streamNode = null
        streamBytes = 0
      }
    }
  }

  function append(fields) {
    counter += 1
    const node = {
      id: `n${counter}`,
      seq: seq || 0,
      at: now(),
      ...fields,
    }
    nodes.push(node)
    byId.set(node.id, node)
    trim()
    return node
  }

  function update(id, fields) {
    const node = byId.get(id)
    if (!node) return null
    Object.assign(node, fields)
    return node
  }

  /** Close the open stream node, if any. */
  function finalizeStream(fields = {}) {
    if (!streamNode) return []
    const node = byId.get(streamNode.id)
    streamNode = null
    streamBytes = 0
    if (!node) return []
    const updates = { streaming: false, ...fields }
    Object.assign(node, updates)
    return [{ op: 'update', id: node.id, fields: updates }]
  }

  /** Open an assistant node that later receives `text` deltas. */
  function beginStream(context = {}) {
    const ops = finalizeStream({})
    const node = append({
      kind: 'assistant',
      turn: Number.isFinite(context.turn) ? context.turn : turn,
      step: Number.isFinite(context.step) ? context.step : step,
      text: '',
      streaming: true,
    })
    streamNode = node
    streamBytes = 0
    ops.push({ op: 'append', node })
    return ops
  }

  /** Append one token delta (bounded by maxNodeText). */
  function appendStream(text) {
    const chunk = String(text ?? '')
    if (!chunk) return []
    if (!streamNode) return beginStream({}).concat(appendStream(chunk))
    const node = byId.get(streamNode.id)
    if (!node) {
      streamNode = null
      return []
    }
    const budget = Math.max(0, maxNodeText - streamBytes)
    if (budget === 0) return []
    const delta = chunk.length > budget ? chunk.slice(0, budget) : chunk
    node.text = (node.text ?? '') + delta
    streamBytes += delta.length
    const ops = [{ op: 'text', id: node.id, delta }]
    if (delta.length < chunk.length) ops.push(...finalizeStream({ truncated: true }))
    return ops
  }

  /** Close the stream with authoritative settlement fields. */
  function endStream(fields = {}) {
    const updates = {}
    if (typeof fields.text === 'string' && fields.text) updates.text = clip(fields.text, maxNodeText)
    if (fields.usage) {
      updates.tokens = {
        input: fields.usage.inputTokens ?? fields.usage.input,
        output: fields.usage.outputTokens ?? fields.usage.output,
      }
    }
    if (fields.interrupted) updates.interrupted = true
    return finalizeStream(updates)
  }

  /**
   * Fold one session event into view nodes.
   * @param {{seq?: number, type?: string, data?: any}} event
   * @returns {Array<object>} patch operations for connected peers
   */
  function apply(event) {
    const ops = []
    const type = eventType(event)
    const data = eventData(event)
    if (Number.isSafeInteger(event?.seq)) seq = event.seq

    switch (type) {
      case 'turn/start': {
        turn = Number(data.turn ?? turn + 1)
        step = 0
        const node = append({ kind: 'turn', turn, text: `turn ${turn}` })
        ops.push({ op: 'append', node })
        break
      }
      case 'turn/end': {
        ops.push(...finalizeStream({}))
        const reason = data.reason?.kind ?? data.reason ?? 'end'
        const node = append({ kind: 'notice', turn, text: `turn ${turn} ${reason}`, tone: 'muted' })
        ops.push({ op: 'append', node })
        break
      }
      case 'step/start': {
        step = Number(data.step ?? step + 1)
        const node = append({
          kind: 'notice',
          turn,
          step,
          text: `step ${step} · thinking`,
          tone: 'thinking',
          live: true,
        })
        ops.push({ op: 'append', node })
        break
      }
      case 'step/end': {
        const live = nodes.find((n) => n.kind === 'notice' && n.tone === 'thinking' && n.live)
        if (live) {
          live.live = false
          live.text = `step ${live.step} · done`
          live.tone = 'muted'
          ops.push({ op: 'update', id: live.id, fields: { live: false, text: live.text, tone: 'muted' } })
        }
        ops.push(...finalizeStream({}))
        break
      }
      case 'user/message': {
        const message = data.message ?? {}
        const source = message.source?.type ?? (message.source ? String(message.source) : 'human')
        const human = source === 'human' || source === undefined
        const text = clip(textOf(message.content), maxNodeText)
        if (!text) break
        const node = append({
          kind: human ? 'user' : 'notice',
          turn,
          text,
          source: String(source),
          tone: human ? 'user' : 'muted',
        })
        ops.push({ op: 'append', node })
        break
      }
      case 'assistant/message': {
        const message = data.message ?? {}
        const text = clip(textOf(message.content), maxNodeText)
        const usage = data.usage
        const tokens = usage
          ? { input: usage.inputTokens ?? usage.input, output: usage.outputTokens ?? usage.output }
          : undefined

        // Settlement is authoritative: replace whatever the token stream produced.
        if (streamNode && text) {
          const node = byId.get(streamNode.id)
          if (node) {
            const fields = { text, streaming: false, interrupted: data.interrupted === true, tokens }
            Object.assign(node, fields)
            ops.push({ op: 'update', id: node.id, fields })
            streamNode = null
            streamBytes = 0
            break
          }
        }
        ops.push(...finalizeStream({}))
        if (!text && !data.interrupted) break
        const node = append({
          kind: 'assistant',
          turn,
          step,
          text,
          streaming: false,
          interrupted: data.interrupted === true,
          tokens,
        })
        ops.push({ op: 'append', node })
        break
      }
      case 'tool/call': {
        const callId = String(data.callId ?? '')
        const node = append({
          kind: 'tool',
          turn,
          step,
          tool: {
            name: String(data.name ?? 'tool'),
            callId,
            argSummary: oneLine(data.arguments, 200),
            status: 'running',
          },
        })
        if (callId) toolByCall.set(callId, node.id)
        ops.push({ op: 'append', node })
        break
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const callId = String(message.toolCallId ?? message.callId ?? data.callId ?? '')
        let id = callId ? toolByCall.get(callId) : undefined
        if (!id) {
          // Result without a captured call (room opened mid-step): synthesize the row.
          const node = append({
            kind: 'tool',
            turn,
            step,
            tool: { name: String(message.name ?? 'tool'), callId, argSummary: '', status: 'ok' },
          })
          id = node.id
          if (callId) toolByCall.set(callId, id)
          ops.push({ op: 'append', node })
        }
        const failed = message.isError === true || data.error !== undefined
        const summary = oneLine(data.error?.reason ?? textOf(message.content), 400)
        const fields = {
          tool: {
            ...(byId.get(id)?.tool ?? {}),
            status: failed ? 'error' : 'ok',
            resultSummary: summary,
          },
        }
        update(id, fields)
        ops.push({ op: 'update', id, fields })
        break
      }
      default:
        // Unknown or non-visual event: ignored on purpose (forward compatibility).
        break
    }
    return ops
  }

  /** Bounded snapshot for a joining peer. */
  function snapshot() {
    const kept = nodes.slice()
    let bytes = 0
    let start = 0
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      bytes += Buffer.byteLength(JSON.stringify(kept[i]), 'utf8')
      if (bytes > LIMITS.maxSnapshotBytes) {
        start = i + 1
        break
      }
    }
    const visible = kept.slice(start)
    return {
      seq,
      nodes: visible,
      truncated: dropped > 0 || start > 0,
    }
  }

  return {
    apply,
    snapshot,
    beginStream,
    appendStream,
    endStream,
    finalizeStream,
    get seq() {
      return seq
    },
    get size() {
      return nodes.length
    },
    get streaming() {
      return streamNode !== null
    },
  }
}
