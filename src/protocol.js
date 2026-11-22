// Wire protocol: version, limits, frame shapes, and the shared close codes.
// Everything here is transport-facing and duplicated (in spirit) by web/app.js and
// bin/collab.mjs; keep the three in sync when the version bumps.

export const PROTOCOL = 1

export const LIMITS = {
  /** Largest frame we will emit toward a peer. */
  maxFrameBytes: 64 * 1024,
  /** Largest frame we will accept from a peer. */
  maxClientFrameBytes: 16 * 1024,
  /** Nodes retained per room and sent in one snapshot. */
  maxSnapshotNodes: 300,
  /** Per-node text cap (long assistant messages are clipped, not dropped). */
  maxNodeText: 64 * 1024,
  /** Snapshot budget in bytes after JSON encoding. */
  maxSnapshotBytes: 256 * 1024,
  /** Handshake deadline. */
  joinTimeoutMs: 10_000,
  /** Heartbeat period and silence deadline. */
  pingMs: 20_000,
  quietTimeoutMs: 60_000,
  /** Calls per second per peer (token bucket, burst 10). */
  callRatePerSec: 5,
  callBurst: 10,
  /** Peer messages: chars per comment, comments kept per room, send rate. */
  maxCommentChars: 2000,
  maxCommentsPerRoom: 200,
  commentRatePerSec: 0.2,
  commentBurst: 6,
  /** Replay window for inbound sequence numbers. */
  maxSeqAhead: 8,
}

export const CLOSE = {
  auth: 4401,
  noRoom: 4404,
  roomClosed: 4408,
  tooMany: 4429,
  rate: 4410,
  protocol: 4400,
  payload: 1009,
  peerLeft: 1000,
}

export const FRAME = {
  hello: 'hello',
  challenge: 'challenge',
  join: 'join',
  ready: 'ready',
  snapshot: 'snapshot',
  patch: 'patch',
  presence: 'presence',
  call: 'call',
  result: 'result',
  ping: 'ping',
  pong: 'pong',
  bye: 'bye',
  enc: 'enc',
}

/** Rough encoded size of one frame, computed without serializing twice. */
export function frameBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Structural check for an inbound peer frame (before decryption it is a plain frame).
 * Returns an error string, or null when acceptable.
 * @param {any} value
 */
export function checkFrame(value) {
  if (!value || typeof value !== 'object') return 'frame must be an object'
  if (value.v !== PROTOCOL) return `unsupported protocol ${String(value.v)}`
  if (typeof value.t !== 'string') return 'frame needs a type'
  return null
}
