// Same-origin bridge for the in-GUI panel.
//
// The share server lives on its own port, so the Web GUI page cannot call it
// directly (CORS, and the console must stay off the peer surface). This route is
// registered on the DSH web server, which makes it same-origin for the GUI:
// loopback-only, read-only, and it exposes nothing the console would not.
//
// `webServer` is optional (headless/hub compositions have no web server), so the
// registration rides `ctx.inject` and disappears cleanly when the service does.
export function registerPanelRoute(options) {
  const { ctx, rooms } = options
  const logger = options.logger ?? console

  const isLoopback = (req) => {
    const ip = String(req.socket?.remoteAddress ?? '')
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  }

  ctx.inject(['webServer'], (webCtx) => {
    const web = webCtx.webServer
    if (!web?.register) {
      logger.warn?.('dsh-collab: webServer has no register API — in-GUI panel disabled')
      return
    }

    const handler = (req, res) => {
      if (!isLoopback(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('loopback only')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const meta = options.info()
      const consoleOrigin = options.consoleOrigin()
      const payload = {
        ok: true,
        now: Date.now(),
        mode: meta.mode ?? 'lan',
        hub: meta.hub ?? null,
        direct: meta.direct ?? [],
        files: meta.files ?? 'unknown',
        streaming: meta.streaming !== false,
        rooms: rooms.list().map((room) => {
          const live = rooms.get(room.code)
          return {
            code: room.code,
            sessionId: room.sessionId,
            title: room.title,
            peers: room.peers,
            comments: live?.comments.length ?? 0,
            latestComments: (live?.comments ?? []).slice(-3).map((comment) => ({ from: comment.from, text: comment.text.slice(0, 80) })),
            expiresAt: room.expiresAt,
            link: live?.inviteLink ?? '',
            console: `${consoleOrigin}/collab/admin`,
            peersList: live
              ? [...live.peers.values()].map((peer) => ({
                  name: peer.name,
                  kind: peer.kind,
                  activity: {
                    kind: peer.activity?.kind ?? 'idle',
                    detail: peer.activity?.detail ?? '',
                  },
                }))
              : [],
          }
        }),
      }
      const body = JSON.stringify(payload)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    }

    webCtx.effect(() => web.register({ kind: 'prefix', path: '/collab-panel', handler }), 'dsh-collab: panel route')
  })
}
