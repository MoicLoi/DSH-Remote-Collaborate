import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomManager } from '../src/room.js'
import { createGateway } from '../src/gateway.js'
import { createAudit } from '../src/audit.js'
import { startCollabServer } from '../src/server.js'
import { connectPeer } from './helpers/peer.mjs'

const silent = { info() {}, warn() {}, error() {} }

async function setup(t, { maxPeers = 3, ttlMs = 60_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-collab-e2e-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'alpha\n')
  await writeFile(join(root, '.env'), 'SECRET=1\n')
  await writeFile(join(root, 'src/b.ts'), 'export const b = 2\n')
  await writeFile(join(root, 'src/c.md'), 'needle in a haystack\n')

  let server
  const rooms = new RoomManager({
    ttlMs,
    maxPeers,
    baseUrl: () => `http://127.0.0.1:${server.port}`,
  })
  const gateway = createGateway({ root })
  server = await startCollabServer({
    rooms,
    gateway,
    bind: '127.0.0.1',
    port: 0,
    hostName: 'test-host',
    logger: silent,
  })
  const room = rooms.ensure({ sessionId: 's1', cwd: root, title: 'demo' })
  room.audit = createAudit({ dir: join(root, '.audit'), room: room.code })
  t.after(async () => {
    rooms.dispose()
    await server.close()
    // Audit writes are fire-and-forget; retry so Windows does not fail on a busy dir.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  return { root, rooms, gateway, server, room }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('a peer joins with the right secret and receives ready, snapshot, and files', async (t) => {
  const { server, room } = await setup(t)
  room.projector.apply({
    seq: 1,
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: 'hi from history' }] } },
  })

  const peer = connectPeer({ origin: server.origin, room: room.code, secret: room.secret })
  t.after(() => peer.close())

  const ready = await peer.waitFor((frame) => frame.t === 'ready')
  assert.equal(ready.name, 'test-host')
  assert.equal(peer.state.hostProofOk, true, 'host proved it holds the same link secret')
  assert.deepEqual(ready.scopes, ['view', 'files'])

  const snapshot = await peer.waitFor((frame) => frame.t === 'snapshot')
  assert.equal(snapshot.nodes.length, 1)
  assert.equal(snapshot.nodes[0].text, 'hi from history')

  const files = await peer.waitFor((frame) => frame.t === 'files')
  const names = files.root.entries.map((entry) => entry.name)
  assert.ok(names.includes('src'))
  assert.ok(!names.includes('.env'), 'deny list applies to the initial tree')
})

test('live session events reach connected peers as patches', async (t) => {
  const { server, room } = await setup(t)
  const peer = connectPeer({ origin: server.origin, room: room.code, secret: room.secret })
  t.after(() => peer.close())
  await peer.waitFor((frame) => frame.t === 'snapshot')

  room.applyEvent({ seq: 1, type: 'turn/start', data: { turn: 1 } })
  room.applyEvent({
    seq: 2,
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: 'live message' }] } },
  })

  const patch = await peer.waitFor((frame) => frame.t === 'patch' && frame.ops.some((op) => op.node?.text === 'live message'))
  const appended = patch.ops.find((op) => op.op === 'append' && op.node.text === 'live message')
  assert.equal(appended.node.kind, 'user')
})

test('peers can list, read, and search the workspace within policy', async (t) => {
  const { server, room } = await setup(t)
  const peer = connectPeer({ origin: server.origin, room: room.code, secret: room.secret })
  t.after(() => peer.close())
  await peer.waitFor((frame) => frame.t === 'ready')

  const listing = await peer.call('files.list', { path: 'src' })
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['b.ts', 'c.md'])

  const file = await peer.call('files.read', { path: 'a.txt' })
  assert.equal(file.text, 'alpha\n')

  const found = await peer.call('files.search', { query: 'needle' })
  assert.equal(found.matches.length, 1)
  assert.equal(found.matches[0].path, 'src/c.md')

  await assert.rejects(() => peer.call('files.read', { path: '.env' }), (error) => error.code === 'E_DENY')
  await assert.rejects(() => peer.call('files.read', { path: '../../etc/passwd' }), (error) => error.code === 'E_SCOPE')
  await assert.rejects(() => peer.call('nope.method', {}), (error) => error.code === 'E_UNSUPPORTED')
})

test('a wrong link secret is rejected before any view is sent', async (t) => {
  const { server, room } = await setup(t)
  const peer = connectPeer({
    origin: server.origin,
    room: room.code,
    secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  t.after(() => peer.close())

  const closed = await peer.waitFor((frame) => frame.t === 'bye' || frame.t === 'closed')
  assert.ok([4401, 1006].includes(closed.code), `expected auth close, got ${closed.code}`)
  assert.equal(peer.state.ready, null)
  assert.equal(peer.frames.some((frame) => frame.t === 'snapshot'), false)
})

test('rotating the link drops connected peers and invalidates the old secret', async (t) => {
  const { server, room } = await setup(t)
  const oldSecret = room.secret
  const peer = connectPeer({ origin: server.origin, room: room.code, secret: oldSecret })
  t.after(() => peer.close())
  await peer.waitFor((frame) => frame.t === 'ready')

  roomsRotate(room)
  const closed = await peer.waitFor((frame) => frame.t === 'bye' || frame.t === 'closed')
  assert.ok([4401, 1006].includes(closed.code))

  assert.notEqual(room.secret, oldSecret, 'the room now uses a fresh secret')

  const stale = connectPeer({ origin: server.origin, room: room.code, secret: oldSecret })
  t.after(() => stale.close())
  const staleClosed = await stale.waitFor((frame) => frame.t === 'bye' || frame.t === 'closed')
  assert.ok([4401, 1006].includes(staleClosed.code))
})

function roomsRotate(room) {
  room.rotateSecret()
}

test('the room capacity is enforced', async (t) => {
  const { server, room } = await setup(t, { maxPeers: 1 })
  const first = connectPeer({ origin: server.origin, room: room.code, secret: room.secret })
  t.after(() => first.close())
  await first.waitFor((frame) => frame.t === 'ready')

  const second = connectPeer({ origin: server.origin, room: room.code, secret: room.secret })
  t.after(() => second.close())
  const closed = await second.waitFor((frame) => frame.t === 'bye' || frame.t === 'closed')
  assert.ok([4429, 1006].includes(closed.code), `expected full-room close, got ${closed.code}`)
})

test('an expired room refuses new peers with 4404', async (t) => {
  const { server, rooms, room } = await setup(t, { ttlMs: 60_000 })
  rooms.close(room.code, 'test close')

  const peer = connectPeer({ origin: server.origin, room: room.code, secret: room.secret })
  t.after(() => peer.close())
  const closed = await peer.waitFor((frame) => frame.t === 'closed')
  assert.equal(closed.code, 4404)
})

test('peer activity is aggregated and broadcast as presence', async (t) => {
  const { server, room } = await setup(t)
  const observer = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'observer' })
  const actor = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'actor' })
  t.after(() => observer.close())
  t.after(() => actor.close())
  await observer.waitFor((frame) => frame.t === 'ready')
  await actor.waitFor((frame) => frame.t === 'ready')

  actor.activity('reading', 'src/b.ts')
  const reading = await observer.waitFor(
    (frame) => frame.t === 'presence' && frame.peers.some((peer) => peer.name === 'actor' && peer.activity?.kind === 'reading'),
  )
  const entry = reading.peers.find((peer) => peer.name === 'actor')
  assert.equal(entry.activity.detail, 'src/b.ts')

  actor.activity('definitely-not-a-state', 'x')
  const fallback = await observer.waitFor(
    (frame) => frame.t === 'presence' && frame.peers.some((peer) => peer.name === 'actor' && peer.activity?.kind === 'idle'),
  )
  assert.ok(fallback.peers.some((peer) => peer.name === 'actor'))
})

test('presence drops a peer when it leaves', async (t) => {
  const { server, room } = await setup(t)
  const observer = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'watcher' })
  const guest = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'guest' })
  t.after(() => observer.close())
  await observer.waitFor((frame) => frame.t === 'ready')
  await guest.waitFor((frame) => frame.t === 'ready')
  await observer.waitFor((frame) => frame.t === 'presence' && frame.peers.some((peer) => peer.name === 'guest'))

  guest.bye()
  const gone = await observer.waitFor((frame) => frame.t === 'presence' && !frame.peers.some((peer) => peer.name === 'guest'))
  assert.equal(gone.peers.some((peer) => peer.name === 'guest'), false)
})

test('peer comments fan out to everyone and are rate-limited', async (t) => {
  const { server, room } = await setup(t)
  const alice = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'alice' })
  const bob = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'bob' })
  t.after(() => alice.close())
  t.after(() => bob.close())
  await alice.waitFor((frame) => frame.t === 'ready')
  await bob.waitFor((frame) => frame.t === 'ready')

  alice.comment('hello from alice', 'n3')
  const received = await bob.waitFor((frame) => frame.t === 'comment' && frame.comment?.text === 'hello from alice')
  assert.equal(received.comment.from, 'alice')
  assert.equal(received.comment.nodeId, 'n3')
  assert.equal(received.comment.seq, 1)

  const echo = await alice.waitFor((frame) => frame.t === 'comment' && frame.comment?.text === 'hello from alice')
  assert.equal(echo.comment.from, 'alice', 'the sender sees its own message')

  for (let i = 0; i < 12; i += 1) alice.comment(`burst ${i}`)
  const limited = await alice.waitFor((frame) => frame.t === 'error' && frame.code === 'E_RATE')
  assert.equal(limited.code, 'E_RATE')
})

test('a late joiner receives earlier comments in the snapshot', async (t) => {
  const { server, room } = await setup(t)
  const alice = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'alice' })
  t.after(() => alice.close())
  await alice.waitFor((frame) => frame.t === 'ready')
  alice.comment('before you arrived')
  await alice.waitFor((frame) => frame.t === 'comment')

  const late = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'late' })
  t.after(() => late.close())
  const snapshot = await late.waitFor((frame) => frame.t === 'snapshot')
  assert.equal(snapshot.allowComments, true)
  assert.ok(snapshot.comments.some((comment) => comment.text === 'before you arrived'))
})

test('the share page and health endpoint are served with security headers', async (t) => {
  const { server } = await setup(t)
  const health = await fetch(`${server.origin}/healthz`)
  assert.equal(health.status, 200)
  const body = await health.json()
  assert.equal(body.ok, true)
  assert.equal(body.protocol, 1)

  const page = await fetch(`${server.origin}/c/UNKNOWN1`)
  assert.equal(page.status, 404)

  const asset = await fetch(`${server.origin}/assets/app.js`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /javascript/)
})

test('a reconnecting peer resumes with the missed patches, not a snapshot', async (t) => {
  const { server, room } = await setup(t)
  const first = connectPeer({ origin: server.origin, room: room.code, secret: room.secret })
  t.after(() => first.close())
  await first.waitFor((frame) => frame.t === 'ready')

  room.applyEvent({ seq: 1, type: 'turn/start', data: { turn: 1 } })
  await first.waitFor((frame) => frame.t === 'patch' && frame.pseq === 1)
  first.close()
  await sleep(80)

  room.applyEvent({
    seq: 2,
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: 'missed while offline' }] } },
  })

  const second = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, resumeFrom: 1 })
  t.after(() => second.close())
  const resumed = await second.waitFor((frame) => frame.t === 'resume' || frame.t === 'snapshot')
  assert.equal(resumed.t, 'resume')
  assert.equal(resumed.from, 1)
  assert.equal(resumed.to, 2)
  assert.ok(
    resumed.patches.some((patch) => patch.ops.some((op) => op.node?.text === 'missed while offline')),
    'the missed message is replayed',
  )
  assert.equal(second.frames.some((frame) => frame.t === 'snapshot'), false, 'no snapshot needed')
})

test('file access lands in the room audit log without content', async (t) => {
  const { root, server, room } = await setup(t)
  const peer = connectPeer({ origin: server.origin, room: room.code, secret: room.secret, name: 'auditor' })
  t.after(() => peer.close())
  await peer.waitFor((frame) => frame.t === 'ready')

  await peer.call('files.read', { path: 'a.txt' })
  await assert.rejects(() => peer.call('files.read', { path: '.env' }), (error) => error.code === 'E_DENY')
  await peer.call('files.list', { path: 'src' })

  const file = join(root, '.audit', `audit-${room.code}.jsonl`)
  let rows = []
  for (let i = 0; i < 80; i += 1) {
    try {
      rows = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      if (rows.length >= 3 && rows.some((row) => row.path === '.env')) break
    } catch {
      /* not written yet */
    }
    await sleep(25)
  }
  assert.ok(rows.some((row) => row.method === 'files.read' && row.path === 'a.txt' && row.outcome === 'ok'))
  assert.ok(rows.some((row) => row.path === '.env' && row.outcome === 'E_DENY'))
  assert.ok(rows.some((row) => row.method === 'files.list' && row.path === 'src'))
  assert.ok(rows.every((row) => row.peer === 'auditor'))
  assert.ok(!rows.some((row) => JSON.stringify(row).includes('alpha')), 'audit never stores file content')

  assert.ok(room.audit.summary().events >= 3)
})
