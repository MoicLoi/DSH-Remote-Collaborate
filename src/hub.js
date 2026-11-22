// The hub: rendezvous + relay for peers that cannot reach the host directly.
//
// It knows room codes, peer ids, and byte counts — never the invite secret, never a
// frame plaintext (peers seal end-to-end before the hub sees anything), and never a
// workspace path. A room exists only while its host socket is attached.
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { isRoomCode } from './invite.js'
import { PROTOCOL } from './protocol.js'
import { attachWebSocketRoutes } from './ws.js'

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))
const ASSETS = new Map([
  ['/assets/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/assets/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
  ['/assets/i18n.js', { file: 'i18n.js', type: 'text/javascript; charset=utf-8' }],
])

const HUB_LIMITS = {
  maxPayload: 64 * 1024,
  maxPeers: 32,
  registerMs: 10_000,
  pingMs: 20_000,
  quietMs: 60_000,
  ttlMs: 8 * 60 * 60 * 1000,
}

function html(body, title = 'dsh-collab hub') {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.2rem;color:#1f2328}
code{background:#f2f3f5;padding:.1em .35em;border-radius:4px}</style></head>
<body>${body}</body></html>`
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Start the hub.
 * @param {{bind?: string, port?: number, token?: string, logger?: any, now?: () => number,
 *          tls?: {cert: string, key: string}, maxPeers?: number, roomTtlMs?: number}} options
 */
export async function startHub(options = {}) {
  const logger = options.logger ?? console
  const now = options.now ?? (() => Date.now())
  const token = String(options.token ?? '')
  const maxPeers = options.maxPeers ?? HUB_LIMITS.maxPeers
  const roomTtlMs = options.roomTtlMs ?? HUB_LIMITS.ttlMs

  /** @type {Map<string, {code: string, host: any, hostName: string, direct: string[], peers: Map<string, any>, createdAt: number, expiresAt: number, seq: number}>} */
  const rooms = new Map()
  /** Upgraded sockets are not tracked by `server.close()`, so the hub owns them. */
  const clients = new Set()

  const server = options.tls?.cert && options.tls?.key
    ? createHttpsServer({ cert: await readFile(options.tls.cert), key: await readFile(options.tls.key) })
    : createHttpServer()

  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  function roomView(room) {
    return {
      room: room.code,
      host: room.hostName,
      direct: room.direct,
      peers: room.peers.size,
      expiresAt: room.expiresAt,
    }
  }

  server.on('request', async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      if (url.pathname === '/healthz') {
        json(res, 200, { ok: true, name: 'dsh-collab-hub', protocol: PROTOCOL, rooms: rooms.size })
        return
      }
      const metaMatch = /^\/hub\/room\/([0-9A-Za-z]+)$/.exec(url.pathname)
      if (metaMatch) {
        const room = rooms.get(metaMatch[1].toUpperCase())
        if (!room) {
          json(res, 404, { ok: false, error: 'room not found' })
          return
        }
        json(res, 200, { ok: true, ...roomView(room) })
        return
      }
      const pageMatch = /^\/c\/([0-9A-Za-z]+)\/?$/.exec(url.pathname)
      if (pageMatch) {
        const room = rooms.get(pageMatch[1].toUpperCase())
        if (!room) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html('<h1>房间不存在</h1><p>主机可能离线了，或链接已过期。请向主机索取新链接。</p>', '房间不存在'))
          return
        }
        const body = await readFile(join(WEB_DIR, 'index.html'))
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      const asset = ASSETS.get(url.pathname)
      if (asset) {
        const body = await readFile(join(WEB_DIR, asset.file))
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(
          html(
            `<h1>dsh-collab hub</h1><p>中心机在运行。协作者需要主机分享的链接（形如
<code>/c/&lt;room&gt;#k=…</code>）。</p><p>在线房间：${rooms.size}</p><p><a href="/healthz">/healthz</a></p>`,
          ),
        )
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (error) {
      logger.warn?.('dsh-collab-hub: http error %s', error?.message ?? error)
      if (!res.headersSent) res.writeHead(400)
      res.end()
    }
  })

  function closeRoom(room, reason) {
    if (!rooms.has(room.code)) return
    rooms.delete(room.code)
    for (const peer of room.peers.values()) {
      try {
        peer.send(JSON.stringify({ v: PROTOCOL, t: 'close', code: 4408, reason }))
        peer.close(4408, reason)
      } catch {
        /* ignore */
      }
    }
    room.peers.clear()
    logger.info?.('dsh-collab-hub: room %s closed (%s)', room.code, reason)
  }

  function attachHost(ws, req, url) {
    clients.add(ws)
    ws.once('close', () => clients.delete(ws))
    const expected = url.searchParams.get('token') ?? ''
    if (token && !safeEqual(expected, token)) {
      ws.close(4401, 'invalid hub token')
      return
    }
    let room = null
    const deadline = setTimeout(() => {
      if (!room) ws.close(4400, 'register timeout')
    }, HUB_LIMITS.registerMs)
    deadline.unref?.()

    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        ws.close(4400, 'invalid JSON')
        return
      }
      if (!room) {
        if (frame?.t !== 'register') {
          ws.close(4400, 'expected register')
          return
        }
        const code = String(frame.room ?? '').toUpperCase()
        if (!isRoomCode(code)) {
          ws.close(4400, 'bad room code')
          return
        }
        if (rooms.has(code)) {
          ws.close(4409, 'room already registered')
          return
        }
        clearTimeout(deadline)
        room = {
          code,
          host: ws,
          hostName: String(frame.name ?? 'dsh-host').slice(0, 60),
          direct: Array.isArray(frame.direct) ? frame.direct.filter((item) => typeof item === 'string').slice(0, 8) : [],
          peers: new Map(),
          createdAt: now(),
          expiresAt: now() + roomTtlMs,
          seq: 0,
          lastSeen: now(),
        }
        rooms.set(code, room)
        ws.send(JSON.stringify({ v: PROTOCOL, t: 'registered', room: code, expiresAt: room.expiresAt }))
        logger.info?.('dsh-collab-hub: room %s registered by %s (%d direct)', code, room.hostName, room.direct.length)
        return
      }
      room.lastSeen = now()
      if (frame?.t === 'relay') {
        const peer = room.peers.get(String(frame.peer ?? ''))
        if (!peer) return
        const payload = typeof frame.payload === 'string' ? frame.payload : JSON.stringify(frame.payload)
        if (payload.length > HUB_LIMITS.maxPayload) return
        peer.send(JSON.stringify({ v: PROTOCOL, t: 'relay', payload }))
        return
      }
      if (frame?.t === 'peer-close') {
        const peer = room.peers.get(String(frame.peer ?? ''))
        if (peer) {
          room.peers.delete(String(frame.peer))
          try {
            peer.send(JSON.stringify({ v: PROTOCOL, t: 'close', code: Number(frame.code) || 4408, reason: String(frame.reason ?? '') }))
            peer.close(Number(frame.code) || 4408, String(frame.reason ?? ''))
          } catch {
            /* ignore */
          }
        }
        return
      }
      if (frame?.t === 'ping') {
        ws.send(JSON.stringify({ v: PROTOCOL, t: 'pong' }))
      }
    })

    ws.on('close', () => {
      clearTimeout(deadline)
      if (room) closeRoom(room, 'host disconnected')
    })
    ws.on('error', () => {})
  }

  function attachPeer(ws, req, url) {
    clients.add(ws)
    ws.once('close', () => clients.delete(ws))
    const code = String(url.searchParams.get('room') ?? '').toUpperCase()
    const room = rooms.get(code)
    if (!room) {
      ws.close(4404, 'room not found')
      return
    }
    if (room.peers.size >= maxPeers) {
      ws.close(4429, 'room is full')
      return
    }
    room.seq += 1
    const peerId = `p${room.seq}`
    room.peers.set(peerId, ws)
    room.lastSeen = now()

    ws.send(
      JSON.stringify({
        v: PROTOCOL,
        t: 'attached',
        room: room.code,
        peer: peerId,
        host: { name: room.hostName, direct: room.direct },
        expiresAt: room.expiresAt,
      }),
    )
    try {
      room.host.send(JSON.stringify({ v: PROTOCOL, t: 'peer-open', peer: peerId }))
    } catch {
      ws.close(4408, 'host unavailable')
      return
    }

    let lastSeen = now()
    const timer = setInterval(() => {
      if (now() - lastSeen > HUB_LIMITS.quietMs) {
        ws.close(4408, 'peer idle')
      }
    }, HUB_LIMITS.pingMs)
    timer.unref?.()

    ws.on('message', (raw) => {
      lastSeen = now()
      room.lastSeen = now()
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        ws.close(4400, 'invalid JSON')
        return
      }
      if (frame?.t === 'relay') {
        const payload = typeof frame.payload === 'string' ? frame.payload : JSON.stringify(frame.payload)
        if (payload.length > HUB_LIMITS.maxPayload) {
          ws.close(1009, 'frame too large')
          return
        }
        try {
          room.host.send(JSON.stringify({ v: PROTOCOL, t: 'relay', peer: peerId, payload }))
        } catch {
          ws.close(4408, 'host unavailable')
        }
        return
      }
      if (frame?.t === 'bye') ws.close(1000, 'peer left')
    })

    ws.on('close', () => {
      clearInterval(timer)
      if (room.peers.delete(peerId)) {
        try {
          room.host.send(JSON.stringify({ v: PROTOCOL, t: 'peer-close', peer: peerId }))
        } catch {
          /* ignore */
        }
      }
    })
    ws.on('error', () => {})
  }

  const detach = attachWebSocketRoutes(server, {
    maxPayload: HUB_LIMITS.maxPayload,
    routes: {
      '/hub/host': (ws, req) => attachHost(ws, req, new URL(req.url ?? '/hub/host', 'http://localhost')),
      '/hub/peer': (ws, req) => attachPeer(ws, req, new URL(req.url ?? '/hub/peer', 'http://localhost')),
    },
  })

  const sweep = setInterval(() => {
    for (const room of [...rooms.values()]) {
      const idle = now() - room.lastSeen > HUB_LIMITS.quietMs
      if (now() > room.expiresAt || idle) closeRoom(room, idle ? 'room idle' : 'room expired')
    }
  }, 30_000)
  sweep.unref?.()

  const port = options.port ?? 8787
  const bind = options.bind ?? '127.0.0.1'
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const scheme = options.tls?.cert ? 'https' : 'http'

  return {
    server,
    port: actualPort,
    origin: `${scheme}://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${actualPort}`,
    rooms,
    close: async () => {
      clearInterval(sweep)
      detach()
      for (const room of [...rooms.values()]) closeRoom(room, 'hub shutting down')
      for (const client of clients) {
        try {
          client.destroy?.()
        } catch {
          /* ignore */
        }
      }
      clients.clear()
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
