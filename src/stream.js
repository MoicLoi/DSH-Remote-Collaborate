// `agent/assistant-stream` → text deltas.
//
// The frame type is process-local and not part of the durable log, so this adapter
// is deliberately shape-tolerant: it recognizes the documented `StreamChunk`
// vocabulary (`text-delta` / `block-start` / `block-end` / `finish`) wherever the
// host nests it, and reports anything else as `ignore` instead of throwing.
//
// Unknown shapes degrade to "no token streaming" — settlement still arrives through
// `session/event` as `assistant/message`, so the view stays correct.

const IGNORED_CHUNKS = new Set(['reasoning-delta', 'usage', 'finish', 'block-start', 'block-end', 'tool-call-delta', 'error'])

function chunkOf(frame) {
  if (!frame || typeof frame !== 'object') return null
  const inner = frame.chunk ?? frame.delta ?? frame.data ?? frame
  return inner && typeof inner === 'object' ? inner : null
}

function typeOf(value) {
  return String(value?.type ?? value?.kind ?? '')
}

/**
 * @param {any} payload the `agent/assistant-stream` payload ({agent, frame})
 * @returns {{kind: 'start'|'delta'|'end'|'ignore', text?: string, sessionId?: string, turn?: number, step?: number}}
 */
export function readStreamEvent(payload) {
  const sessionId = payload?.agent?.session?.id ? String(payload.agent.session.id) : undefined
  const frame = payload?.frame ?? payload

  if (!frame || typeof frame !== 'object') {
    const text = payload?.text
    return typeof text === 'string' && text ? { kind: 'delta', text, sessionId } : { kind: 'ignore', sessionId }
  }

  const frameType = typeOf(frame)
  const chunk = chunkOf(frame)
  const chunkType = typeOf(chunk)

  if (frameType === 'start' || chunkType === 'start') {
    return {
      kind: 'start',
      sessionId,
      turn: numberOrUndefined(frame.turn ?? chunk?.turn ?? payload?.turn),
      step: numberOrUndefined(frame.step ?? chunk?.step ?? payload?.step),
    }
  }
  if (frameType === 'end' || frameType === 'finish' || chunkType === 'end' || chunkType === 'finish') {
    return { kind: 'end', sessionId }
  }

  if (chunkType === 'text-delta' && typeof chunk.text === 'string') {
    return chunk.text ? { kind: 'delta', text: chunk.text, sessionId } : { kind: 'ignore', sessionId }
  }
  if (IGNORED_CHUNKS.has(chunkType)) return { kind: 'ignore', sessionId }

  // A bare {type:'text-delta'} frame, or a chunk with a text payload only.
  if (frameType === 'text-delta' && typeof frame.text === 'string') {
    return frame.text ? { kind: 'delta', text: frame.text, sessionId } : { kind: 'ignore', sessionId }
  }
  if (typeof chunk.text === 'string' && chunk.text && !chunkType) {
    return { kind: 'delta', text: chunk.text, sessionId }
  }

  return { kind: 'ignore', sessionId }
}

function numberOrUndefined(value) {
  return Number.isFinite(value) ? Number(value) : undefined
}
