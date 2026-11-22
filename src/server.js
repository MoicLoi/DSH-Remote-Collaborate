// The host-side edge: one small HTTP server (share page + health) and one WebSocket
// endpoint per peer. No dependency on the DSH web server, so the GUI keeps its own
// loopback-only posture and this plugin can be bound (and firewalled) independently.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { LIMITS, PROTOCOL } from './protocol.js'
import { attachWebSocket } from './ws.js'
import { createPeerAcceptor } from './peer-acceptor.js'
import { createAdmin } from './admin.js'

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))
const ASSETS = new Map([
  ['/assets/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/assets/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
  ['/assets/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/assets/i18n.js', { file: 'i18n.js', type: 'text/javascript; charset=utf-8' }],
  ['/assets/admin.js', { file: 'admin.js', type: 'text/javascript; charset=utf-8' }],
])

function html(body, title = 'dsh-collab') {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.2rem;color:#1f2328}
code{background:#f2f3f5;padding:.1em .35em;border-radius:4px}</style></head>
<body>${body}</body></html>`
}

/**
 * Serve one share page and accept peers for the rooms in `rooms`.
 * @param {{rooms: any, gatewayFor?: (room: any) => any, gateway?: any, bind: string, port: number,
 *          hostName?: string, logger?: any, now?: () => number}} options
 */
export async function startCollabServer(options) {
  const { rooms } = options
  const gatewayFor = options.gatewayFor ?? (() => options.gateway ?? null)
  const logger = options.logger ?? console
  const now = options.now ?? (() => Date.now())
  const hostName = options.hostName || 'dsh-host'

  const acceptPeer = createPeerAcceptor({ rooms, gatewayFor, hostName, logger, now })
  const admin = options.admin
    ? createAdmin({ rooms, token: options.admin.token ?? '', info: options.admin.info })
    : null

  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res)
    } catch (error) {
      logger.warn?.('dsh-collab: http error %s', error?.message ?? error)
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end('bad request')
    }
  })

  function securityHeaders(extra = {}) {
    const host = String(extra.host ?? '')
    const connect = host ? `'self' ws://${host} wss://${host}` : "'self'"
    return {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connect}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...extra,
    }
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const host = req.headers.host ?? ''

    // The console owns /collab/*, including its POST routes; check it before the
    // generic read-only method guard.
    if (admin && (await admin.handle(req, res, url))) return

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end('method not allowed')
      return
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, name: 'dsh-collab', protocol: PROTOCOL, host: hostName, rooms: rooms.list() }))
      return
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders({ host }) })
      res.end(
        html(
          `<h1>dsh-collab</h1><p>这台机器正在运行超轻协作主机。分享链接形如
<code>http://&lt;host&gt;:&lt;port&gt;/c/&lt;room&gt;#k=…</code>，请向主机索取。</p>
<p><a href="/collab/admin">/collab/admin</a> 主机控制台 · <a href="/healthz">/healthz</a></p>`,
        ),
      )
      return
    }

    const roomMatch = /^\/c\/([0-9A-Za-z]+)\/?$/.exec(url.pathname)
    if (roomMatch) {
      const room = rooms.get(roomMatch[1])
      if (!room) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders({ host }) })
        res.end(
          html(
            `<h1>链接已失效</h1><p>这个协作房间不存在、已过期，或主机刷新了链接。</p><p>请向主机索取一条新链接。</p>`,
            '链接已失效',
          ),
        )
        return
      }
      const body = await readFile(join(WEB_DIR, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders({ host }) })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }

    const asset = ASSETS.get(url.pathname)
    if (asset) {
      const body = await readFile(join(WEB_DIR, asset.file))
      res.writeHead(200, {
        'content-type': asset.type,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }

  const detachWs = attachWebSocket(server, {
    path: '/ws',
    maxPayload: LIMITS.maxClientFrameBytes,
    onConnection: (ws, req) => {
      let room = ''
      try {
        room = String(new URL(req.url ?? '/', 'http://localhost').searchParams.get('room') ?? '')
      } catch {
        /* malformed URL: acceptPeer closes with noRoom */
      }
      acceptPeer(ws, { ip: req.socket.remoteAddress, room })
    },
  })

  const sweep = setInterval(() => {
    try {
      rooms.sweep()
    } catch (error) {
      logger.warn?.('dsh-collab: sweep failed %s', error?.message ?? error)
    }
  }, 30_000)
  sweep.unref?.()

  const port = options.port ?? 0
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
  const origin = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${actualPort}`

  return {
    server,
    port: actualPort,
    origin,
    acceptPeer,
    close: async () => {
      clearInterval(sweep)
      detachWs()
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
