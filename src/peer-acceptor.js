// One authenticated peer session, independent of how bytes arrive.
//
// The transport interface is deliberately small (mirrors the WebSocket subset we use),
// so the same handshake, rate limits, resume, file calls, and audit run over:
//   - a browser/ TUI WebSocket straight to the host, and
//   - a virtual connection relayed through the hub (`src/relay.js`).
//
//   transport: EventEmitter with `message`(string) / `close`(code,reason) / `error`,
//              plus writable, bufferedBytes, sendText(text), close(code,reason), ping()
import { randomUUID } from 'node:crypto'
import { CLOSE, LIMITS, PROTOCOL, frameBytes } from './protocol.js'
import { newNonce, open, proof, seal, verifyProof } from './crypto.js'
import { CollabError, E } from './errors.js'

const CALLS = new Set(['files.list', 'files.read', 'files.stat', 'files.search'])

function tokenBucket({ rate, burst, now }) {
  let tokens = burst
  let last = now()
  return () => {
    const at = now()
    tokens = Math.min(burst, tokens + ((at - last) / 1000) * rate)
    last = at
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

/**
 * @param {{rooms: any, gatewayFor: (room: any) => any, hostName: string,
 *          logger?: any, now?: () => number}} options
 */
export function createPeerAcceptor(options) {
  const { rooms, gatewayFor } = options
  const hostName = options.hostName || 'dsh-host'
  const logger = options.logger ?? console
  const now = options.now ?? (() => Date.now())

  /**
   * @param {any} ws transport
   * @param {{room?: string, ip?: string}} [meta] room for relayed peers, client ip for audit
   */
  return function acceptPeer(ws, meta = {}) {
    const code = String(meta.room ?? '').toUpperCase()
    const room = rooms.get(code)
    if (!room) {
      ws.close(CLOSE.noRoom, 'room not found')
      return
    }
    const ip = meta.ip ?? 'unknown'

    const peer = {
      id: randomUUID(),
      name: 'peer',
      kind: 'web',
      since: now(),
      activity: { kind: 'idle', detail: '', at: now() },
      room,
      send: null,
      close: (closeCode, reason) => ws.close(closeCode, reason),
    }
    const session = {
      authed: false,
      challenge: newNonce(),
      peerNonce: '',
      inSeq: 0,
      outSeq: 0,
      lastSeen: now(),
      timer: null,
      joinDeadline: null,
      calls: tokenBucket({ rate: LIMITS.callRatePerSec, burst: LIMITS.callBurst, now }),
      comments: tokenBucket({ rate: LIMITS.commentRatePerSec, burst: LIMITS.commentBurst, now }),
    }

    const sendRaw = (frame) => {
      if (!ws.writable) return false
      if (frameBytes(frame) > LIMITS.maxFrameBytes) {
        logger.warn?.('dsh-collab: dropping oversized frame %s', frame?.t)
        return false
      }
      return ws.sendText(JSON.stringify(frame))
    }

    const sendPlain = sendRaw

    const sendSecure = (logical) => {
      if (!session.authed) return sendPlain(logical)
      if (ws.bufferedBytes > 512 * 1024 && logical?.t === 'patch') return false
      session.outSeq += 1
      const envelope = seal(room.key, room.code, session.outSeq, logical)
      return sendRaw({ v: PROTOCOL, t: 'enc', ...envelope })
    }
    peer.send = sendSecure

    const teardown = (closeCode, reason) => {
      if (session.timer) clearInterval(session.timer)
      if (session.joinDeadline) clearTimeout(session.joinDeadline)
      session.timer = null
      session.joinDeadline = null
      if (session.authed) {
        room.removePeer(peer.id)
        room.broadcastPresence(true)
        rooms.emit('peer-left', room, peer)
      }
      ws.close(closeCode, reason)
    }

    const closeWithError = (closeCode, reason) => {
      try {
        sendSecure({ v: PROTOCOL, t: 'bye', code: closeCode, reason })
      } catch {
        /* ignore */
      }
      teardown(closeCode, reason)
    }

    session.joinDeadline = setTimeout(() => {
      if (!session.authed) closeWithError(CLOSE.auth, 'handshake timeout')
    }, LIMITS.joinTimeoutMs)

    function authenticate(joinFrame) {
      const ok = verifyProof(room.key, [session.challenge, room.code, session.peerNonce], joinFrame.proof)
      if (!ok) {
        rooms.emit('auth-failed', room, { ip })
        closeWithError(CLOSE.auth, 'invalid invite secret')
        return
      }
      session.authed = true
      clearTimeout(session.joinDeadline)
      session.joinDeadline = null
      peer.name = String(joinFrame.name ?? '').slice(0, 60) || `peer-${peer.id.slice(0, 4)}`
      peer.kind = joinFrame.kind === 'tui' ? 'tui' : 'web'

      try {
        room.addPeer(peer)
      } catch (error) {
        closeWithError(CLOSE.tooMany, error?.message ?? 'room is full')
        return
      }

      sendSecure({
        v: PROTOCOL,
        t: 'ready',
        room: room.code,
        name: hostName,
        title: room.title,
        cwd: room.cwd,
        expiresAt: room.expiresAt,
        scopes: ['view', 'files'],
        pseq: room.patchSeq,
        selfId: peer.id,
        allowComments: room.allowComments,
        hostProof: proof(room.key, [session.peerNonce, room.code, 'host']),
        protocol: PROTOCOL,
        via: meta.via ?? 'direct',
      })
      const resumeFrom = Number(joinFrame.resumeFrom)
      const missed = Number.isSafeInteger(resumeFrom) && resumeFrom >= 0 ? room.resumeFrom(resumeFrom) : null
      if (missed) {
        sendSecure({ v: PROTOCOL, t: 'resume', from: resumeFrom, to: room.patchSeq, patches: missed })
      } else {
        sendSecure(room.snapshot())
      }
      const gateway = gatewayFor(room)
      if (gateway) {
        gateway
          .list('')
          .then((listing) => sendSecure({ v: PROTOCOL, t: 'files', root: listing }))
          .catch(() => sendSecure({ v: PROTOCOL, t: 'files', root: { path: '.', entries: [], truncated: false } }))
      }
      room.broadcastPresence(true)
      rooms.emit('peer-joined', room, peer)

      session.timer = setInterval(() => {
        if (now() - session.lastSeen > LIMITS.quietTimeoutMs) {
          teardown(CLOSE.peerLeft, 'peer timed out')
          return
        }
        sendSecure({ v: PROTOCOL, t: 'ping', n: session.outSeq })
        try {
          ws.ping()
        } catch {
          /* ignore */
        }
      }, LIMITS.pingMs)
      session.timer.unref?.()
    }

    async function runCall(frame) {
      const id = String(frame.id ?? '')
      if (!id) return
      if (!session.calls()) {
        sendSecure({ v: PROTOCOL, t: 'result', id, ok: false, error: { code: 'E_RATE', message: 'too many requests' } })
        return
      }
      const method = String(frame.method ?? '')
      if (!CALLS.has(method)) {
        sendSecure({ v: PROTOCOL, t: 'result', id, ok: false, error: { code: 'E_UNSUPPORTED', message: `unknown method ${method}` } })
        return
      }
      const gateway = gatewayFor(room)
      if (!gateway) {
        sendSecure({ v: PROTOCOL, t: 'result', id, ok: false, error: { code: 'E_UNSUPPORTED', message: 'file browsing is disabled on this host' } })
        return
      }
      const params = frame.params && typeof frame.params === 'object' ? frame.params : {}
      const auditPath = method === 'files.search' ? String(params.query ?? '') : String(params.path ?? '')
      const audit = (bytes, outcome) =>
        room.audit?.record({
          peer: peer.name,
          ip,
          method,
          path: auditPath,
          bytes,
          outcome,
        })
      try {
        const data =
          method === 'files.list'
            ? await gateway.list(params.path)
            : method === 'files.read'
              ? await gateway.read(params.path, { offset: params.offset, limit: params.limit })
              : method === 'files.stat'
                ? await gateway.stat(params.path)
                : await gateway.search(params.query, { glob: params.glob, maxResults: params.maxResults })
        audit(
          method === 'files.list'
            ? data?.entries?.length
            : method === 'files.search'
              ? data?.matches?.length
              : data?.bytes,
          'ok',
        )
        sendSecure({ v: PROTOCOL, t: 'result', id, ok: true, data })
      } catch (error) {
        const errorCode = error instanceof CollabError ? error.code : 'E_INTERNAL'
        const message = error instanceof CollabError ? error.message : 'internal error'
        audit(undefined, errorCode)
        if (!(error instanceof CollabError)) logger.warn?.('dsh-collab: call failed %s', error?.stack ?? error)
        sendSecure({ v: PROTOCOL, t: 'result', id, ok: false, error: { code: errorCode, message } })
      }
    }

    function onLogical(frame) {
      if (!frame || typeof frame !== 'object') return
      session.lastSeen = now()
      switch (frame.t) {
        case 'call':
          void runCall(frame)
          return
        case 'ping':
          sendSecure({ v: PROTOCOL, t: 'pong', n: frame.n ?? 0 })
          return
        case 'pong':
          return
        case 'activity': {
          const kind = String(frame.kind ?? 'idle')
          const detail = String(frame.detail ?? '').slice(0, 160)
          if (room.setPeerActivity(peer.id, kind, detail)) {
            rooms.emit('peer-activity', room, peer, { kind: peer.activity.kind, detail: peer.activity.detail })
          }
          return
        }
        case 'comment': {
          if (!session.comments()) {
            sendSecure({ v: PROTOCOL, t: 'error', code: E.rate, message: 'sending too fast' })
            return
          }
          try {
            const comment = room.addComment({
              from: peer.name,
              text: frame.text,
              nodeId: frame.nodeId,
              kind: frame.kind,
            })
            room.audit?.record({ peer: peer.name, ip, method: 'comment', path: comment.nodeId || 'room', outcome: 'ok', bytes: comment.text.length })
            rooms.emit('peer-comment', room, peer, comment)
          } catch (error) {
            sendSecure({
              v: PROTOCOL,
              t: 'error',
              code: error?.code ?? E.comment,
              message: error?.message ?? 'comment rejected',
            })
          }
          return
        }
        case 'bye':
          teardown(CLOSE.peerLeft, 'peer left')
          return
        default:
          sendSecure({ v: PROTOCOL, t: 'error', code: 'E_UNSUPPORTED', message: `unknown frame ${frame.t}` })
      }
    }

    ws.on('message', (raw) => {
      session.lastSeen = now()
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        closeWithError(CLOSE.protocol, 'invalid JSON')
        return
      }
      if (frame?.v !== PROTOCOL) {
        closeWithError(CLOSE.protocol, 'unsupported protocol')
        return
      }
      if (frame.t === 'enc') {
        if (!session.authed) {
          closeWithError(CLOSE.auth, 'not authenticated')
          return
        }
        const seq = Number(frame.s)
        if (!Number.isSafeInteger(seq) || seq <= session.inSeq || seq > session.inSeq + LIMITS.maxSeqAhead) {
          closeWithError(CLOSE.protocol, 'sequence violation')
          return
        }
        session.inSeq = seq
        let logical
        try {
          logical = open(room.key, room.code, frame)
        } catch {
          closeWithError(CLOSE.auth, 'frame authentication failed')
          return
        }
        onLogical(logical)
        return
      }
      if (frame.t === 'hello') {
        if (session.authed) return
        sendPlain({ v: PROTOCOL, t: 'challenge', room: room.code, nonce: session.challenge })
        return
      }
      if (frame.t === 'join') {
        if (session.authed) return
        session.peerNonce = String(frame.peerNonce ?? '').slice(0, 128)
        if (!session.peerNonce) {
          closeWithError(CLOSE.protocol, 'missing peer nonce')
          return
        }
        authenticate(frame)
        return
      }
      closeWithError(CLOSE.protocol, `unexpected frame ${frame.t}`)
    })

    ws.on('close', () => {
      if (session.timer) clearInterval(session.timer)
      if (session.joinDeadline) clearTimeout(session.joinDeadline)
      if (session.authed && room.peers.has(peer.id)) {
        room.removePeer(peer.id)
        room.broadcastPresence(true)
        rooms.emit('peer-left', room, peer)
      }
    })
    ws.on('error', () => {})
  }
}

