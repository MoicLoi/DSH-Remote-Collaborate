import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from '../src/hub.js'
import { connectHub } from '../src/relay.js'
import { RoomManager } from '../src/room.js'
import { createGateway } from '../src/gateway.js'
import { startCollabServer } from '../src/server.js'
import { connectRelayPeer } from './helpers/peer.mjs'

const silent = { info() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-collab-hub-e2e-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'alpha via relay\n')
  await writeFile(join(root, '.env'), 'SECRET=1\n')

  const hub = await startHub({ bind: '127.0.0.1', port: 0, token: 'hub-secret', logger: silent })
  const rooms = new RoomManager({
    ttlMs: 60_000,
    maxPeers: 3,
    baseUrl: () => hub.origin,
  })
  const gateway = createGateway({ root })
  const server = await startCollabServer({
    rooms,
    gateway,
    bind: '127.0.0.1',
    port: 0,
    hostName: 'hub-host',
    logger: silent,
  })
  const room = rooms.ensure({ sessionId: 's1', cwd: root, title: 'relayed' })

  const link = connectHub({
    origin: hub.origin,
    token: 'hub-secret',
    room: room.code,
    name: 'hub-host',
    direct: [server.origin],
    logger: silent,
    onPeer: (peer) => server.acceptPeer(peer, { ip: 'relay', via: 'relay', room: room.code }),
  })

  for (let i = 0; i < 100 && !link.client.registered; i += 1) await sleep(20)
  assert.equal(link.client.registered, true, 'the host registered with the hub')

  t.after(async () => {
    await link.stop()
    rooms.dispose()
    await server.close()
    await hub.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, hub, rooms, server, room, link }
}

test('a peer joins through the hub and speaks the full protocol', async (t) => {
  const { hub, room } = await setup(t)
  const peer = connectRelayPeer({ hubOrigin: hub.origin, room: room.code, secret: room.secret, name: 'relay-peer' })
  t.after(() => peer.close())

  const ready = await peer.waitFor((frame) => frame.t === 'ready')
  assert.equal(ready.via, 'relay', 'the host knows this peer arrived over the relay')
  assert.equal(peer.state.hostProofOk, true, 'end-to-end proof survives the relay')
  assert.equal(peer.state.peerId, 'p1')

  const snapshot = await peer.waitFor((frame) => frame.t === 'snapshot')
  assert.ok(Array.isArray(snapshot.nodes))

  const files = await peer.waitFor((frame) => frame.t === 'files')
  assert.ok(files.root.entries.some((entry) => entry.name === 'a.txt'))
})

test('file calls and live patches work over the relay', async (t) => {
  const { hub, room } = await setup(t)
  const peer = connectRelayPeer({ hubOrigin: hub.origin, room: room.code, secret: room.secret })
  t.after(() => peer.close())
  await peer.waitFor((frame) => frame.t === 'ready')

  const file = await peer.call('files.read', { path: 'a.txt' })
  assert.equal(file.text, 'alpha via relay\n')
  await assert.rejects(() => peer.call('files.read', { path: '.env' }), (error) => error.code === 'E_DENY')

  room.applyEvent({
    seq: 1,
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: 'over the hub' }] } },
  })
  const patch = await peer.waitFor((frame) => frame.t === 'patch' && frame.ops.some((op) => op.node?.text === 'over the hub'))
  assert.ok(patch.pseq >= 1)
})

test('the invite link points at the hub while the host advertises a direct endpoint', async (t) => {
  const { hub, room, server } = await setup(t)
  assert.ok(room.inviteLink.startsWith(hub.origin), `expected hub origin, got ${room.inviteLink}`)

  const res = await fetch(`${hub.origin}/hub/room/${room.code}`)
  const meta = await res.json()
  assert.deepEqual(meta.direct, [server.origin], 'the host advertises its LAN edge for direct attempts')
  assert.equal(meta.host, 'hub-host')
})

test('rotating the link also drops relayed peers', async (t) => {
  const { hub, room } = await setup(t)
  const peer = connectRelayPeer({ hubOrigin: hub.origin, room: room.code, secret: room.secret })
  t.after(() => peer.close())
  await peer.waitFor((frame) => frame.t === 'ready')

  const oldSecret = room.secret
  room.rotateSecret()
  const closed = await peer.waitFor((frame) => frame.t === 'bye' || frame.t === 'closed', 5000)
  assert.ok([4401, 1006].includes(closed.code), `expected auth close, got ${closed.code}`)

  const stale = connectRelayPeer({ hubOrigin: hub.origin, room: room.code, secret: oldSecret })
  t.after(() => stale.close())
  const staleClosed = await stale.waitFor((frame) => frame.t === 'bye' || frame.t === 'closed', 5000)
  assert.ok([4401, 1006].includes(staleClosed.code))
})
