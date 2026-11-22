// Session binding helpers: locate the live session for a room and replay its log
// into the room's projector so a late joiner gets the whole story, not just new events.
//
// The session API is read in a defensive order so this keeps working across DSH
// versions: `snapshotEvents()` is the documented lossless view of the log.

/**
 * @param {any} session
 * @returns {any[]} the append-only session log, newest API first
 */
export function readSessionEvents(session) {
  if (!session) return []
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents() || []
    if (typeof session.ownEvents === 'function') return session.ownEvents() || []
    if (Array.isArray(session.events)) return session.events
  } catch {
    return []
  }
  return []
}

/**
 * Resolve a live session from whatever service the host composition provides.
 * @param {any} ctx
 * @param {string} sessionId
 */
export function findSession(ctx, sessionId) {
  const id = String(sessionId ?? '')
  if (!id) return undefined
  try {
    const direct = ctx?.get?.('sessions')?.get?.(id)
    if (direct) return direct
  } catch {
    /* service shape differs; try the agent registry */
  }
  try {
    return ctx?.get?.('agents')?.get?.(id)?.session
  } catch {
    return undefined
  }
}

/**
 * Replay everything a session already logged into the room projector.
 * Silent by design: peers joining later get this through `snapshot()`.
 * @param {{room: any, session: any}} input
 * @returns {number} number of replayed events
 */
export function primeRoom({ room, session }) {
  const events = readSessionEvents(session)
  for (const event of events) room.projector.apply(event)
  return events.length
}
