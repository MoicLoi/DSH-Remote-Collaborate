import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomManager } from '../src/room.js'
import { createGateway } from '../src/gateway.js'
import { startCollabServer } from '../src/server.js'
import { connectPeer } from './helpers/peer.mjs'

const silent = { info() {}, warn() {}, error() {} }

async function setup(t, { token = 'admin-secret' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-collab-admin-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'alpha\n')

  let server
  const rooms = new RoomManager({ ttlMs: 60_000, maxPeers: 3, baseUrl: () => `http://127.0.0.1:${server.port}` })
  server = await startCollabServer({
    rooms,
    gateway: createGateway({ root }),
    bind: '127.0.0.1',
    port: 0,
    hostName: 'admin-host',
    logger: silent,
    admin: {
      token,
      info: () => ({
        mode: 'hub',
        hub: { url: 'https://hub.example.test', registered: true },
        direct: ['http://192.168.1.9:8848'],
        files: 'ctx.fs',
        streaming: true,
      }),
    },
  })
  const room = rooms.ensure({ sessionId: 's1', cwd: root, title: 'admin demo' })
  t.after(async () => {
    rooms.dispose()
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, rooms, server, room }
}

function stateUrl(origin, token) {
  return `${origin}/collab/api/state${token ? `?t=${encodeURIComponent(token)}` : ''}`
}

test('the console requires the admin token when one is configured', async (t) => {
  const { server } = await setup(t)
  const denied = await fetch(stateUrl(server.origin))
  assert.equal(denied.status, 401)
  assert.equal((await denied.json()).error, 'E_UNAUTHORIZED')

  const pageDenied = await fetch(`${server.origin}/collab/admin`)
  assert.equal(pageDenied.status, 401)
  assert.match(await pageDenied.text(), /Not authorized/)

  const ok = await fetch(stateUrl(server.origin, 'admin-secret'))
  assert.equal(ok.status, 200)
})

test('state reports rooms, peers, audit, and host posture', async (t) => {
  const { server, room } = await setup(t)
  const response = await fetch(stateUrl(server.origin, 'admin-secret'))
  const state = await response.json()
  assert.equal(state.ok, true)
  assert.equal(state.mode, 'hub')
  assert.equal(state.hub.registered, true)
  assert.equal(state.files, 'ctx.fs')
  assert.equal(state.rooms.length, 1)
  assert.equal(state.rooms[0].code, room.code)
  assert.equal(state.rooms[0].title, 'admin demo')
  assert.equal(state.rooms[0].peers, 0)
  assert.ok(state.rooms[0].expiresAt > Date.now())
})

test('the console page is served to an authorized operator', async (t) => {
  const { server } = await setup(t)
  const response = await fetch(`${server.origin}/collab/admin?t=admin-secret`)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /dsh-collab/)
  assert.match(html, /data-i18n="admin\.title"/)
  assert.match(html, /\/assets\/admin\.js/)
})

test('rotate changes the secret and close removes the room', async (t) => {
  const { server, rooms, room } = await setup(t)
  const oldSecret = room.secret
  const rotate = await fetch(`${server.origin}/collab/api/rooms/${room.code}/rotate`, {
    method: 'POST',
    headers: { 'x-collab-admin': '1', 'x-collab-admin-token': 'admin-secret' },
  })
  assert.equal(rotate.status, 200)
  const rotated = await rotate.json()
  assert.ok(rotated.link.startsWith('http'))
  assert.notEqual(rotated.link.includes(oldSecret), true, 'the old secret is gone from the link')
  assert.notEqual(room.secret, oldSecret)

  const close = await fetch(`${server.origin}/collab/api/rooms/${room.code}/close`, {
    method: 'POST',
    headers: { 'x-collab-admin': '1', 'x-collab-admin-token': 'admin-secret' },
  })
  assert.equal(close.status, 200)
  assert.equal(rooms.get(room.code), undefined)
})

test('state-changing calls need the custom header (CSRF guard)', async (t) => {
  const { server, room } = await setup(t)
  const missingHeader = await fetch(`${server.origin}/collab/api/rooms/${room.code}/rotate?t=admin-secret`, {
    method: 'POST',
  })
  assert.equal(missingHeader.status, 400)
  assert.equal((await missingHeader.json()).error, 'E_BADREQ')
})

test('unknown rooms are reported as 404 and unauthenticated posts never mutate', async (t) => {
  const { server } = await setup(t)
  const missing = await fetch(`${server.origin}/collab/api/rooms/ZZZZ9999/close`, {
    method: 'POST',
    headers: { 'x-collab-admin': '1', 'x-collab-admin-token': 'admin-secret' },
  })
  assert.equal(missing.status, 404)

  const anonymous = await fetch(`${server.origin}/collab/api/rooms/ZZZZ9999/close`, {
    method: 'POST',
    headers: { 'x-collab-admin': '1' },
  })
  assert.equal(anonymous.status, 401)
})

test('without a token the console is loopback-only', async (t) => {
  const { server } = await setup(t, { token: '' })
  const state = await fetch(stateUrl(server.origin))
  assert.equal(state.status, 200, 'loopback callers are trusted')
  assert.equal((await state.json()).ok, true)
})

test('the i18n bundle is served for both pages', async (t) => {
  const { server } = await setup(t)
  const response = await fetch(`${server.origin}/assets/i18n.js`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /javascript/)
  const body = await response.text()
  assert.match(body, /applyStaticText/)
  assert.match(body, /admin\.title/)
})

test('the console shows who is online and what each peer is doing', async (t) => {
  const { server, room } = await setup(t)
  const peer = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'alice' })
  t.after(() => peer.close())
  await peer.waitFor((frame) => frame.t === 'ready')

  peer.activity('reading', 'src/a.ts')
  let state
  for (let i = 0; i < 40; i += 1) {
    const response = await fetch(stateUrl(server.origin, 'admin-secret'))
    state = await response.json()
    const entry = state.rooms[0]?.peersList?.[0]
    if (entry?.activity?.kind === 'reading') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(state.rooms[0].peers, 1)
  assert.equal(state.rooms[0].peersList[0].name, 'alice')
  assert.equal(state.rooms[0].peersList[0].activity.kind, 'reading')
  assert.equal(state.rooms[0].peersList[0].activity.detail, 'src/a.ts')
  assert.deepEqual(state.rooms[0].peerNames, ['alice'])
})
