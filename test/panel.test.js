import test from 'node:test'
import assert from 'node:assert/strict'
import { RoomManager } from '../src/room.js'
import { registerPanelRoute } from '../src/panel.js'

function fakeCtx(routes) {
  return {
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      callback({
        webServer: {
          register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        },
        effect(factory) {
          factory()
        },
      })
    },
  }
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
    },
    end(body) {
      if (body !== undefined) res.body = String(body)
    },
  }
  return res
}

function fakeReq({ method = 'GET', ip = '127.0.0.1' } = {}) {
  return { method, socket: { remoteAddress: ip }, headers: {} }
}

function setup() {
  const routes = new Map()
  const rooms = new RoomManager({ ttlMs: 60_000, baseUrl: () => 'http://127.0.0.1:8848' })
  const room = rooms.ensure({ sessionId: 's-panel', cwd: process.cwd(), title: 'panel demo' })
  registerPanelRoute({
    ctx: fakeCtx(routes),
    rooms,
    info: () => ({ mode: 'lan', hub: null, direct: ['http://127.0.0.1:8848'], files: 'ctx.fs', streaming: true }),
    consoleOrigin: () => 'http://127.0.0.1:8848',
    logger: { warn() {} },
  })
  return { routes, rooms, room }
}

test('the panel route is a prefix route on /collab-panel', () => {
  const { routes, rooms } = setup()
  assert.ok(routes.has('/collab-panel'))
  assert.equal(routes.get('/collab-panel').kind, 'prefix')
  rooms.dispose()
})

test('the panel route exposes live rooms and peer activity', () => {
  const { routes, rooms, room } = setup()
  const peer = { id: 'p1', name: 'alice', kind: 'web', since: 1, send() {}, close() {} }
  room.addPeer(peer)
  room.setPeerActivity('p1', 'reading', 'src/a.ts')

  const res = fakeRes()
  routes.get('/collab-panel').handler(fakeReq(), res)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.mode, 'lan')
  assert.equal(payload.files, 'ctx.fs')
  assert.equal(payload.rooms.length, 1)
  assert.equal(payload.rooms[0].code, room.code)
  assert.match(payload.rooms[0].link, /#k=/)
  assert.equal(payload.rooms[0].console, 'http://127.0.0.1:8848/collab/admin')
  assert.equal(payload.rooms[0].peersList[0].name, 'alice')
  assert.equal(payload.rooms[0].peersList[0].activity.kind, 'reading')
  rooms.dispose()
})

test('the panel route refuses non-loopback callers and non-GET methods', () => {
  const { routes, rooms } = setup()
  const denied = fakeRes()
  routes.get('/collab-panel').handler(fakeReq({ ip: '192.168.1.20' }), denied)
  assert.equal(denied.status, 403)

  const wrongMethod = fakeRes()
  routes.get('/collab-panel').handler(fakeReq({ method: 'POST' }), wrongMethod)
  assert.equal(wrongMethod.status, 405)
  rooms.dispose()
})

test('a missing webServer service leaves the plugin silent, not broken', () => {
  const ctx = { inject(deps, callback) { callback({ effect() {} }) } }
  const warnings = []
  registerPanelRoute({
    ctx,
    rooms: { list: () => [], get: () => undefined },
    info: () => ({}),
    consoleOrigin: () => '',
    logger: { warn: (message) => warnings.push(message) },
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /webServer/)
})
