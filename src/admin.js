// Host console: a loopback-only (or adminToken-gated) view of live rooms.
//
// Deliberately separate from the share page: peers must never reach this surface, so
// authorization here is about the *machine*, not the invite. No session log is exposed,
// only room codes, peer labels, expiry, and audit counters.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { renderRoomJson, renderRoomMarkdown } from './export.js'

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function isLoopback(req) {
  const ip = String(req.socket?.remoteAddress ?? '')
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

function unauthorizedPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>dsh-collab console</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.2rem;color:#e6e8ee;background:#0f1115}
code{background:#242a35;padding:.1em .35em;border-radius:4px}</style></head>
<body><h1>未授权 / Not authorized</h1>
<p>主机控制台只允许本机访问；远程访问需要配置 <code>adminToken</code> 并在 URL 带上 <code>?t=</code>。</p>
<p>This console is loopback-only; remote access needs <code>adminToken</code> and <code>?t=</code>.</p>
</body></html>`
}

/**
 * @param {{rooms: any, token?: string, info?: () => Record<string, unknown>}} options
 */
export function createAdmin(options) {
  const { rooms } = options
  const token = String(options.token ?? '')
  const info = options.info ?? (() => ({}))

  function authorized(req, url) {
    if (token) {
      const supplied =
        url.searchParams.get('t') ??
        req.headers['x-collab-admin-token'] ??
        ''
      return safeEqual(supplied, token)
    }
    return isLoopback(req)
  }

  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  function state() {
    const meta = info()
    return {
      ok: true,
      now: Date.now(),
      mode: meta.mode ?? 'lan',
      hub: meta.hub ?? null,
      direct: meta.direct ?? [],
      files: meta.files ?? 'unknown',
      streaming: meta.streaming !== false,
      rooms: rooms.list().map((room) => {
        const live = rooms.get(room.code)
        const peers = live
          ? [...live.peers.values()].map((peer) => ({
              name: peer.name,
              kind: peer.kind,
              since: peer.since ?? 0,
              activity: {
                kind: peer.activity?.kind ?? 'idle',
                detail: peer.activity?.detail ?? '',
                at: peer.activity?.at ?? 0,
              },
            }))
          : []
        return {
          ...room,
          peersList: peers,
          peerNames: peers.map((peer) => `${peer.name}${peer.kind === 'tui' ? ' (tui)' : ''}`),
          audit: live?.audit?.summary() ?? null,
          comments: live?.comments.length ?? 0,
          lastCommentSeq: live?.commentSeq ?? 0,
          latestComments: (live?.comments ?? []).slice(-3).map((comment) => ({
            seq: comment.seq,
            from: comment.from,
            text: comment.text.slice(0, 120),
          })),
        }
      }),
    }
  }

  /**
   * Handle `/collab/*`. Returns true when this request belonged to the console.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/collab/')) return false
    if (!authorized(req, url)) {
      if (url.pathname.startsWith('/collab/api/')) {
        json(res, 401, { ok: false, error: 'E_UNAUTHORIZED', message: 'admin token required' })
      } else {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(unauthorizedPage())
      }
      return true
    }

    if (url.pathname === '/collab/admin' || url.pathname === '/collab/admin/') {
      const body = await readFile(join(WEB_DIR, 'admin.html'))
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return true
    }

    if (url.pathname === '/collab/api/state' && req.method === 'GET') {
      json(res, 200, state())
      return true
    }

    const exportMatch = /^\/collab\/api\/rooms\/([0-9A-Za-z]+)\/export\.(md|json)$/.exec(url.pathname)
    if (exportMatch && req.method === 'GET') {
      const code = exportMatch[1].toUpperCase()
      const room = rooms.get(code)
      if (!room) {
        json(res, 404, { ok: false, error: 'E_NOTFOUND', message: 'room not found' })
        return true
      }
      const format = exportMatch[2]
      const rendered = format === 'json' ? renderRoomJson(room) : renderRoomMarkdown(room)
      const body = format === 'json' ? rendered.json : rendered.markdown
      res.writeHead(200, {
        'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="collab-${code}.${format}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return true
    }

    const action = /^\/collab\/api\/rooms\/([0-9A-Za-z]+)\/(rotate|close)$/.exec(url.pathname)
    if (action && req.method === 'POST') {
      // Custom-header requirement: a cross-site form cannot set it without CORS.
      if (req.headers['x-collab-admin'] !== '1') {
        json(res, 400, { ok: false, error: 'E_BADREQ', message: 'missing x-collab-admin header' })
        return true
      }
      const code = action[1].toUpperCase()
      const room = rooms.get(code)
      if (!room) {
        json(res, 404, { ok: false, error: 'E_NOTFOUND', message: 'room not found' })
        return true
      }
      if (action[2] === 'rotate') {
        const link = rooms.rotate(code)
        json(res, 200, { ok: true, code, link })
        return true
      }
      rooms.close(code, 'closed from host console')
      json(res, 200, { ok: true, code })
      return true
    }

    json(res, 404, { ok: false, error: 'E_NOTFOUND' })
    return true
  }

  return { handle, state }
}
