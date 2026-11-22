// Rooms: one share link = one room = one session, held in memory and closed for good
// when it expires or is rotated. No secrets are written to disk by default.
import { EventEmitter } from 'node:events'
import { deriveKey, newSecret, secretFingerprint } from './crypto.js'
import { createInvite, newRoomCode, normalizeOrigin } from './invite.js'
import { createProjector } from './projector.js'
import { CLOSE, LIMITS, PROTOCOL } from './protocol.js'
import { E, CollabError } from './errors.js'

const HARD_MAX_MS = 8 * 60 * 60 * 1000
const IDLE_CLOSE_MS = 10 * 60 * 1000

export class Room {
  /**
   * @param {{code: string, secret: string, mode: 'lan'|'hub', sessionId: string,
   *          cwd: string, title?: string, ttlMs: number, maxPeers: number,
   *          baseUrl: string, now?: () => number}} input
   */
  constructor(input) {
    this.code = input.code
    this.secret = input.secret
    this.mode = input.mode ?? 'lan'
    this.sessionId = input.sessionId
    this.cwd = input.cwd
    this.title = input.title ?? ''
    this.ttlMs = input.ttlMs
    this.maxPeers = input.maxPeers
    this.baseUrl = normalizeOrigin(input.baseUrl)
    this.now = input.now ?? (() => Date.now())
    this.createdAt = this.now()
    this.hardExpiresAt = this.createdAt + HARD_MAX_MS
    this.lastActivityAt = this.createdAt
    this.expiresAt = Math.min(this.createdAt + this.ttlMs, this.hardExpiresAt)
    this.closed = false
    this.closeReason = ''
    this.projector = createProjector()
    /** @type {Map<string, any>} peerId 鈫?peer handle {id, name, kind, send(frame), close(code, reason)} */
    this.peers = new Map()
    this.secretHash = secretFingerprint(this.secret)
    this._key = deriveKey(this.secret, this.code)
    /** Monotonic patch counter used for resume. */
    this.patchSeq = 0
    /** Recent patches kept for reconnect replay. */
    this.ring = []
    this.maxRing = 512
    this.streamBuffer = ''
    this.streamTimer = null
    this.lastPresenceAt = 0
    this.presenceScheduled = null
    this.typingTtlMs = 6_000
    this.activityTtlMs = 60_000
    this.presenceTimer = setInterval(() => this.decayActivity(), 5_000)
    this.presenceTimer.unref?.()
    /** Peer messages kept for this room (bounded). */
    this.comments = []
    this.commentSeq = 0
    this.allowComments = input.allowComments !== false
    /** @type {import('./audit.js').createAudit | null} */
    this.audit = null
  }

  /** @returns {Buffer} derived AES key for the current secret */
  get key() {
    return this._key
  }

  get inviteLink() {
    return createInvite({ baseUrl: this.baseUrl, room: this.code, secret: this.secret, mode: this.mode }).link
  }

  get peerCount() {
    return this.peers.size
  }

  touch() {
    this.lastActivityAt = this.now()
    this.expiresAt = Math.min(this.lastActivityAt + this.ttlMs, this.hardExpiresAt)
  }

  isExpired(at = this.now()) {
    return this.closed || at >= this.expiresAt
  }

  /**
   * @param {{id: string, name: string, kind: string, send: (frame: any) => void,
   *          close: (code: number, reason: string) => void}} peer
   */
  addPeer(peer) {
    if (this.closed) throw new CollabError(E.peer, 'room is closed')
    if (this.peers.size >= this.maxPeers) throw new CollabError(E.peer, 'room is full')
    this.peers.set(peer.id, peer)
    this.touch()
    return peer
  }

  removePeer(peerId) {
    this.peers.delete(peerId)
    this.touch()
  }

  /** Broadcast one logical frame to every attached peer. */
  broadcast(frame) {
    for (const peer of this.peers.values()) {
      try {
        peer.send(frame)
      } catch {
        // A broken peer must not break the fan-out; its socket teardown removes it.
      }
    }
  }

  /**
   * Fold one session event and fan out the resulting patch.
   * @param {any} event
   */
  applyEvent(event) {
    this.flushStream()
    const ops = this.projector.apply(event)
    this.emitPatch(ops)
    return ops
  }

  /**
   * Publish one patch: bump the room cursor, keep it for resume, fan it out.
   * @param {Array<object>} ops
   */
  emitPatch(ops) {
    if (!ops || ops.length === 0) return null
    this.patchSeq += 1
    const frame = {
      v: PROTOCOL,
      t: 'patch',
      pseq: this.patchSeq,
      ops,
      sessionSeq: this.projector.seq,
    }
    this.ring.push({ pseq: this.patchSeq, ops })
    if (this.ring.length > this.maxRing) this.ring.splice(0, this.ring.length - this.maxRing)
    this.broadcast(frame)
    return frame
  }

  /**
   * Patches a reconnecting peer missed, or null when a full snapshot is required.
   * @param {number} from last patch cursor the peer already applied
   * @returns {Array<{pseq: number, ops: object[]}> | null}
   */
  resumeFrom(from) {
    if (!Number.isSafeInteger(from) || from < 0) return null
    if (from === this.patchSeq) return []
    if (from > this.patchSeq) return null
    const first = this.ring[0]?.pseq ?? this.patchSeq + 1
    if (from + 1 < first) return null
    return this.ring.filter((entry) => entry.pseq > from)
  }

  /** Open an assistant stream node (token-level live text). */
  beginAssistantStream(context = {}) {
    this.flushStream()
    this.emitPatch(this.projector.beginStream(context))
  }

  /** Buffer one text delta; deltas are coalesced to one patch per 80 ms. */
  queueStreamText(text) {
    if (!text) return
    this.streamBuffer += text
    if (!this.streamTimer) {
      this.streamTimer = setTimeout(() => {
        this.streamTimer = null
        this.flushStream()
      }, 80)
      this.streamTimer.unref?.()
    }
  }

  /** Flush buffered deltas immediately (called before any other patch). */
  flushStream() {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer)
      this.streamTimer = null
    }
    if (!this.streamBuffer) return
    const text = this.streamBuffer
    this.streamBuffer = ''
    this.emitPatch(this.projector.appendStream(text))
  }

  /** Close the stream with settlement fields. */
  finishAssistantStream(fields = {}) {
    this.flushStream()
    this.emitPatch(this.projector.endStream(fields))
  }

  snapshot() {
    return {
      v: PROTOCOL,
      t: 'snapshot',
      ...this.projector.snapshot(),
      pseq: this.patchSeq,
      title: this.title,
      cwd: this.cwd,
      comments: this.comments.map((comment) => ({ ...comment })),
      commentSeq: this.commentSeq,
      allowComments: this.allowComments,
    }
  }

  /**
   * Record one peer message (room-level comment or a node-anchored annotation).
   * @param {{from: string, text: string, nodeId?: string, kind?: 'comment'|'annotation'}} input
   */
  addComment(input) {
    if (!this.allowComments) throw new CollabError(E.comment, 'comments are disabled for this room')
    const text = String(input.text ?? '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .trim()
    if (!text) throw new CollabError(E.comment, 'empty comment')
    const bounded = text.length > LIMITS.maxCommentChars ? text.slice(0, LIMITS.maxCommentChars) : text
    this.commentSeq += 1
    const comment = {
      seq: this.commentSeq,
      id: `c${this.commentSeq}`,
      at: this.now(),
      from: String(input.from ?? 'peer').slice(0, 40),
      kind: input.kind === 'annotation' ? 'annotation' : 'comment',
      nodeId: input.nodeId ? String(input.nodeId).slice(0, 64) : '',
      text: bounded,
    }
    this.comments.push(comment)
    if (this.comments.length > LIMITS.maxCommentsPerRoom) this.comments.shift()
    this.touch()
    this.broadcast({ v: PROTOCOL, t: 'comment', comment })
    return comment
  }

  /** Comments newer than a cursor (for the agent inbox). */
  commentsSince(seq = 0) {
    return this.comments.filter((comment) => comment.seq > Number(seq ?? 0))
  }

  presence() {
    const peers = [...this.peers.values()].map((peer) => ({
      id: peer.id,
      name: peer.name,
      kind: peer.kind,
      since: peer.since ?? this.now(),
      activity: {
        kind: peer.activity?.kind ?? 'idle',
        detail: peer.activity?.detail ?? '',
        at: peer.activity?.at ?? 0,
      },
    }))
    return { v: PROTOCOL, t: 'presence', peers }
  }

  /**
   * Update one peer's presence-machine state and fan it out (throttled: typing is chatty).
   * @param {string} peerId
   * @param {'idle'|'typing'|'reading'|'browsing'|'searching'} kind
   * @param {string} [detail]
   */
  setPeerActivity(peerId, kind, detail = '') {
    const peer = this.peers.get(peerId)
    if (!peer) return false
    const allowed = new Set(['idle', 'typing', 'reading', 'browsing', 'searching'])
    const nextKind = allowed.has(kind) ? kind : 'idle'
    peer.activity = {
      kind: nextKind,
      detail: String(detail ?? '').slice(0, 160),
      at: this.now(),
    }
    this.touch()
    this.broadcastPresence()
    return true
  }

  /** Broadcast presence at most every 200 ms; the trailing update is never lost. */
  broadcastPresence(force = false) {
    const at = this.now()
    if (!force && at - this.lastPresenceAt < 200) {
      if (!this.presenceScheduled) {
        this.presenceScheduled = setTimeout(() => {
          this.presenceScheduled = null
          this.broadcastPresence(true)
        }, 200)
        this.presenceScheduled.unref?.()
      }
      return
    }
    this.lastPresenceAt = at
    this.broadcast(this.presence())
  }

  /** Typing decays fast, other activity after a minute of silence. */
  decayActivity() {
    const at = this.now()
    let changed = false
    for (const peer of this.peers.values()) {
      const activity = peer.activity
      if (!activity || activity.kind === 'idle') continue
      const age = at - (activity.at ?? 0)
      const ttl = activity.kind === 'typing' ? this.typingTtlMs : this.activityTtlMs
      if (age > ttl) {
        peer.activity = { kind: 'idle', detail: '', at }
        changed = true
      }
    }
    if (changed) this.broadcastPresence(true)
  }

  /** Rotate the link secret: old links die, connected peers are dropped. */
  rotateSecret() {
    this.secret = newSecret()
    this.secretHash = secretFingerprint(this.secret)
    this._key = deriveKey(this.secret, this.code)
    this.closePeers(CLOSE.auth, 'link rotated by host')
    return this.inviteLink
  }

  closePeers(code, reason) {
    for (const peer of [...this.peers.values()]) {
      try {
        peer.close(code, reason)
      } catch {
        /* ignore */
      }
    }
    this.peers.clear()
  }

  close(reason = 'closed by host') {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    if (this.streamTimer) {
      clearTimeout(this.streamTimer)
      this.streamTimer = null
    }
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer)
      this.presenceTimer = null
    }
    if (this.presenceScheduled) {
      clearTimeout(this.presenceScheduled)
      this.presenceScheduled = null
    }
    this.streamBuffer = ''
    this.closePeers(CLOSE.roomClosed, reason)
    void this.audit?.dispose()
  }
}

/**
 * The host-side room table.
 * Emits: `created`, `closed`, `peer-joined`, `peer-left`, `rotated`.
 */
export class RoomManager extends EventEmitter {
  /**
   * @param {{ttlMs?: number, maxPeers?: number, now?: () => number,
   *          baseUrl: () => string, mode?: 'lan'|'hub', idleCloseMs?: number}} options
   */
  constructor(options) {
    super()
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000
    this.maxPeers = options.maxPeers ?? 8
    this.baseUrl = options.baseUrl
    this.mode = options.mode ?? 'lan'
    this.idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS
    this.allowComments = options.allowComments !== false
    /** @type {Map<string, Room>} */
    this.rooms = new Map()
    /** @type {Map<string, Room>} sessionId 鈫?room */
    this.bySessionId = new Map()
  }

  /** @param {string} sessionId */
  forSession(sessionId) {
    return this.bySessionId.get(String(sessionId))
  }

  /** @param {string} code */
  get(code) {
    const room = this.rooms.get(String(code ?? '').toUpperCase())
    return room && !room.closed ? room : undefined
  }

  /**
   * Create (or return) the room bound to one session.
   * @param {{sessionId: string, cwd: string, title?: string}} input
   */
  ensure(input) {
    const sessionId = String(input.sessionId)
    const existing = this.bySessionId.get(sessionId)
    if (existing && !existing.closed) {
      existing.touch()
      return existing
    }
    if (existing?.closed) this.bySessionId.delete(sessionId)

    let code = newRoomCode()
    while (this.rooms.has(code)) code = newRoomCode()
    const room = new Room({
      code,
      secret: newSecret(),
      mode: this.mode,
      sessionId,
      cwd: String(input.cwd),
      title: input.title,
      ttlMs: this.ttlMs,
      maxPeers: this.maxPeers,
      baseUrl: this.baseUrl(),
      now: this.now,
      allowComments: this.allowComments,
    })
    this.rooms.set(code, room)
    this.bySessionId.set(sessionId, room)
    this.emit('created', room)
    return room
  }

  /** Refresh the link for one session's room (drops current peers). */
  rotate(code) {
    const room = this.get(code)
    if (!room) return undefined
    room.baseUrl = normalizeOrigin(this.baseUrl())
    const link = room.rotateSecret()
    this.emit('rotated', room)
    return link
  }

  /** Destroy one room by code. */
  close(code, reason = 'closed by host') {
    const room = this.get(code)
    if (!room) return false
    room.close(reason)
    this.rooms.delete(room.code)
    if (this.bySessionId.get(room.sessionId) === room) this.bySessionId.delete(room.sessionId)
    this.emit('closed', room)
    return true
  }

  /** Destroy every room bound to a session (e.g. the session ended). */
  closeSession(sessionId, reason = 'session ended') {
    const room = this.bySessionId.get(String(sessionId))
    if (!room) return false
    return this.close(room.code, reason)
  }

  /** Expire due rooms; returns the codes that closed. */
  sweep(at = this.now()) {
    const closed = []
    for (const room of [...this.rooms.values()]) {
      const idle = room.peerCount === 0 && at - room.lastActivityAt > this.idleCloseMs
      if (room.isExpired(at) || idle) {
        this.close(room.code, room.expiresAt <= at ? 'link expired' : 'room idle')
        closed.push(room.code)
      }
    }
    return closed
  }

  list() {
    return [...this.rooms.values()].map((room) => ({
      code: room.code,
      sessionId: room.sessionId,
      peers: room.peerCount,
      title: room.title,
      expiresAt: room.expiresAt,
      cwd: room.cwd,
    }))
  }

  dispose() {
    for (const code of [...this.rooms.keys()]) this.close(code, 'host shutting down')
    this.removeAllListeners()
  }
}

