// Host-side hub client: registers this host's room with the hub and turns each relayed
// peer into a transport the ordinary peer acceptor can drive.
//
// Everything between host and peer stays sealed end-to-end; the hub only sees the
// opaque frame strings and must never be trusted with plaintext.
import { EventEmitter } from 'node:events'

const MAX_PAYLOAD = 64 * 1024
const FATAL_CLOSE = new Set([4400, 4401, 4409])

/** One remote peer, presented as the WebSocket subset the acceptor uses. */
export class RelayPeer extends EventEmitter {
  /**
   * @param {{id: string, client: HubClient}} input
   */
  constructor({ id, client }) {
    super()
    this.id = id
    this.client = client
    this.writable = true
    this.closed = false
  }

  get bufferedBytes() {
    return this.client.bufferedBytes
  }

  sendText(text) {
    if (!this.writable) return false
    const payload = String(text)
    if (payload.length > MAX_PAYLOAD) return false
    return this.client.send({ t: 'relay', peer: this.id, payload })
  }

  ping() {
    // The hub owns the relay heartbeat; nothing to do per peer.
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    this.writable = false
    this.client.send({ t: 'peer-close', peer: this.id, code, reason })
    this.emit('close', code, reason)
  }

  /** Called by the hub client when a frame addressed to this peer arrives. */
  deliver(payload) {
    if (this.closed) return
    this.emit('message', String(payload))
  }

  /** Called on hub loss: the socket is gone, so the peer session must end. */
  drop(code = 1006, reason = 'relay lost') {
    if (this.closed) return
    this.closed = true
    this.writable = false
    this.emit('close', code, reason)
  }
}

/**
 * Connect this host to a hub and keep the room registered.
 * @param {{origin: string, token?: string, room: string, name?: string, direct?: string[],
 *          logger?: any, onPeer: (peer: RelayPeer) => void, WebSocketImpl?: any}} options
 */
export function connectHub(options) {
  const logger = options.logger ?? console
  const origin = String(options.origin).replace(/\/+$/, '')
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket
  const token = String(options.token ?? '')
  const direct = Array.isArray(options.direct) ? options.direct.slice(0, 8) : []
  const peers = new Map()
  let ws = null
  let stopped = false
  let retry = 0
  let retryTimer = null
  let pingTimer = null
  let registered = false

  const wsUrl = () => {
    const url = new URL(`${origin.replace(/^http/, 'ws')}/hub/host`)
    url.searchParams.set('room', options.room)
    if (token) url.searchParams.set('token', token)
    return url.toString()
  }

  const client = {
    get bufferedBytes() {
      return ws?.bufferedAmount ?? 0
    },
    send(frame) {
      if (!ws || ws.readyState !== 1) return false
      try {
        ws.send(JSON.stringify({ v: 1, ...frame }))
        return true
      } catch {
        return false
      }
    },
    get registered() {
      return registered
    },
  }

  function dropPeers(code, reason) {
    for (const peer of peers.values()) peer.drop(code, reason)
    peers.clear()
  }

  function scheduleRetry() {
    if (stopped) return
    retry += 1
    const delay = Math.min(15000, 800 * 2 ** Math.min(retry, 4))
    logger.warn?.('dsh-collab: hub link lost, retry %d in %dms', retry, delay)
    clearTimeout(retryTimer)
    retryTimer = setTimeout(open, delay)
    retryTimer.unref?.()
  }

  function open() {
    if (stopped) return
    let socket
    try {
      socket = new WebSocketImpl(wsUrl())
    } catch (error) {
      logger.error?.('dsh-collab: cannot open hub socket (%s)', error?.message ?? error)
      scheduleRetry()
      return
    }
    ws = socket

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          v: 1,
          t: 'register',
          room: options.room,
          name: String(options.name ?? 'dsh-host').slice(0, 60),
          direct,
          protocol: 1,
        }),
      )
    }

    socket.onmessage = (event) => {
      let frame
      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }
      if (frame?.t === 'registered') {
        registered = true
        retry = 0
        logger.info?.('dsh-collab: hub room %s registered (direct: %s)', options.room, direct.join(', ') || 'none')
        clearInterval(pingTimer)
        pingTimer = setInterval(() => client.send({ t: 'ping' }), 20_000)
        pingTimer.unref?.()
        return
      }
      if (frame?.t === 'peer-open') {
        const id = String(frame.peer ?? '')
        if (!id || peers.has(id)) return
        const peer = new RelayPeer({ id, client })
        peers.set(id, peer)
        try {
          options.onPeer(peer)
        } catch (error) {
          logger.warn?.('dsh-collab: relay peer setup failed (%s)', error?.message ?? error)
          peer.close(1011, 'host error')
        }
        return
      }
      if (frame?.t === 'relay') {
        const peer = peers.get(String(frame.peer ?? ''))
        if (peer) peer.deliver(frame.payload)
        return
      }
      if (frame?.t === 'peer-close') {
        const id = String(frame.peer ?? '')
        const peer = peers.get(id)
        if (peer) {
          peers.delete(id)
          peer.drop(Number(frame.code) || 1006, String(frame.reason ?? 'peer closed'))
        }
        return
      }
      if (frame?.t === 'error') {
        logger.warn?.('dsh-collab: hub error %s %s', frame.code, frame.message)
      }
    }

    socket.onclose = (event) => {
      const wasRegistered = registered
      registered = false
      clearInterval(pingTimer)
      pingTimer = null
      dropPeers(1006, 'relay lost')
      if (stopped) return
      if (FATAL_CLOSE.has(event.code)) {
        stopped = true
        logger.error?.('dsh-collab: hub rejected the host (code %d, %s)', event.code, event.reason)
        return
      }
      if (wasRegistered) logger.warn?.('dsh-collab: hub disconnected (code %d)', event.code)
      scheduleRetry()
    }

    socket.onerror = () => {
      /* onclose schedules the retry */
    }
  }

  open()

  return {
    client,
    peers,
    get registered() {
      return registered
    },
    async stop() {
      stopped = true
      clearTimeout(retryTimer)
      clearInterval(pingTimer)
      dropPeers(1006, 'host shutting down')
      try {
        ws?.close(1000, 'host closing')
      } catch {
        /* ignore */
      }
      ws = null
    },
  }
}
