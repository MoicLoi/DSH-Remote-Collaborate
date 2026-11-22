import test from 'node:test'
import assert from 'node:assert/strict'
import { RoomManager } from '../src/room.js'

function roomWithPeer({ nowRef }) {
  const rooms = new RoomManager({
    ttlMs: 60_000,
    maxPeers: 4,
    baseUrl: () => 'http://127.0.0.1:1',
    now: () => nowRef.value,
  })
  const room = rooms.ensure({ sessionId: 's-presence', cwd: process.cwd() })
  const frames = []
  const peer = { id: 'p1', name: 'alice', kind: 'web', since: 0, send: (frame) => frames.push(frame), close() {} }
  room.addPeer(peer)
  return { rooms, room, peer, frames }
}

test('presence carries each peer activity state', () => {
  const nowRef = { value: 1_000 }
  const { rooms, room, frames } = roomWithPeer({ nowRef })
  room.setPeerActivity('p1', 'reading', 'src/auth/login.ts')
  room.broadcastPresence(true)

  const frame = frames.filter((item) => item.t === 'presence').at(-1)
  assert.ok(frame)
  assert.equal(frame.peers.length, 1)
  assert.equal(frame.peers[0].name, 'alice')
  assert.equal(frame.peers[0].activity.kind, 'reading')
  assert.equal(frame.peers[0].activity.detail, 'src/auth/login.ts')
  assert.equal(frame.peers[0].activity.at, 1_000)
  rooms.dispose()
})

test('unknown activity kinds fall back to idle and details are bounded', () => {
  const nowRef = { value: 1_000 }
  const { rooms, room, peer } = roomWithPeer({ nowRef })
  room.setPeerActivity('p1', 'hacking', 'x')
  assert.equal(peer.activity.kind, 'idle')
  room.setPeerActivity('p1', 'reading', 'x'.repeat(500))
  assert.equal(peer.activity.detail.length, 160)
  rooms.dispose()
})

test('typing decays after ~6s and other activity after 60s', () => {
  const nowRef = { value: 1_000 }
  const { rooms, room, peer } = roomWithPeer({ nowRef })

  room.setPeerActivity('p1', 'typing', 'search')
  nowRef.value = 1_000 + 5_000
  room.decayActivity()
  assert.equal(peer.activity.kind, 'typing', 'still within the typing window')

  nowRef.value = 1_000 + 7_000
  room.decayActivity()
  assert.equal(peer.activity.kind, 'idle', 'typing decays quickly')

  room.setPeerActivity('p1', 'browsing', 'src')
  nowRef.value = 1_000 + 7_000 + 30_000
  room.decayActivity()
  assert.equal(peer.activity.kind, 'browsing', 'browsing lives longer than typing')

  nowRef.value = 1_000 + 7_000 + 61_000
  room.decayActivity()
  assert.equal(peer.activity.kind, 'idle', 'any activity goes idle after a minute')
  rooms.dispose()
})

test('presence fan-out is throttled but the trailing update still lands', async () => {
  const nowRef = { value: 1_000 }
  const { rooms, room, frames } = roomWithPeer({ nowRef })
  room.setPeerActivity('p1', 'typing', 'a')
  const first = frames.filter((item) => item.t === 'presence').length
  room.setPeerActivity('p1', 'typing', 'b')
  room.setPeerActivity('p1', 'typing', 'c')
  assert.equal(frames.filter((item) => item.t === 'presence').length, first, 'burst is coalesced')
  await new Promise((resolve) => setTimeout(resolve, 260))
  assert.ok(frames.filter((item) => item.t === 'presence').length > first, 'trailing update flushed')
  rooms.dispose()
})

test('activity from an unknown peer is ignored', () => {
  const nowRef = { value: 1_000 }
  const { rooms, room } = roomWithPeer({ nowRef })
  assert.equal(room.setPeerActivity('nobody', 'typing', 'x'), false)
  rooms.dispose()
})
