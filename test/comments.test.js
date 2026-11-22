import test from 'node:test'
import assert from 'node:assert/strict'
import { RoomManager } from '../src/room.js'
import { renderRoomJson, renderRoomMarkdown } from '../src/export.js'
import { LIMITS } from '../src/protocol.js'

function roomWithPeer(options = {}) {
  const rooms = new RoomManager({
    ttlMs: 60_000,
    maxPeers: 4,
    baseUrl: () => 'http://127.0.0.1:1',
    now: () => 1_000,
    allowComments: options.allowComments,
  })
  const room = rooms.ensure({ sessionId: 's-comments', cwd: process.cwd(), title: 'comments demo' })
  const frames = []
  const peer = { id: 'p1', name: 'alice', kind: 'web', since: 0, send: (frame) => frames.push(frame), close() {} }
  room.addPeer(peer)
  return { rooms, room, peer, frames }
}

test('a comment is stored, sequenced, broadcast, and included in the snapshot', () => {
  const { rooms, room, frames } = roomWithPeer()
  const first = room.addComment({ from: 'alice', text: '  looks good  ' })
  const second = room.addComment({ from: 'alice', text: 'one nit', nodeId: 'n7', kind: 'annotation' })

  assert.equal(first.seq, 1)
  assert.equal(first.text, 'looks good', 'text is trimmed')
  assert.equal(second.seq, 2)
  assert.equal(second.kind, 'annotation')
  assert.equal(second.nodeId, 'n7')

  const broadcast = frames.filter((frame) => frame.t === 'comment')
  assert.equal(broadcast.length, 2)
  assert.equal(broadcast[1].comment.text, 'one nit')

  const snapshot = room.snapshot()
  assert.equal(snapshot.comments.length, 2)
  assert.equal(snapshot.commentSeq, 2)
  assert.equal(snapshot.allowComments, true)
  rooms.dispose()
})

test('comment text is stripped of control characters and bounded', () => {
  const { rooms, room } = roomWithPeer()
  const dirty = room.addComment({ from: 'alice', text: 'a\u0000b\u0007c' })
  assert.equal(dirty.text, 'abc')

  const long = room.addComment({ from: 'alice', text: 'x'.repeat(LIMITS.maxCommentChars + 50) })
  assert.equal(long.text.length, LIMITS.maxCommentChars)
  rooms.dispose()
})

test('empty comments are rejected and comments can be disabled per room', () => {
  const { rooms, room } = roomWithPeer()
  assert.throws(() => room.addComment({ from: 'alice', text: '   ' }), /empty comment/)

  const off = roomWithPeer({ allowComments: false })
  assert.throws(() => off.room.addComment({ from: 'alice', text: 'hi' }), /comments are disabled/)
  assert.equal(off.room.snapshot().allowComments, false)
  rooms.dispose()
  off.rooms.dispose()
})

test('the room keeps only the newest comments', () => {
  const { rooms, room } = roomWithPeer()
  for (let i = 0; i < LIMITS.maxCommentsPerRoom + 5; i += 1) {
    room.addComment({ from: 'alice', text: `m${i}` })
  }
  assert.equal(room.comments.length, LIMITS.maxCommentsPerRoom)
  assert.equal(room.comments.at(-1).text, `m${LIMITS.maxCommentsPerRoom + 4}`)
  rooms.dispose()
})

test('commentsSince is a strict cursor', () => {
  const { rooms, room } = roomWithPeer()
  room.addComment({ from: 'alice', text: 'one' })
  room.addComment({ from: 'alice', text: 'two' })
  assert.deepEqual(
    room.commentsSince(1).map((comment) => comment.text),
    ['two'],
  )
  assert.equal(room.commentsSince(2).length, 0)
  rooms.dispose()
})

test('markdown export renders the timeline and the comments', () => {
  const { rooms, room } = roomWithPeer()
  room.addComment({ from: 'alice', text: 'please check step 3', nodeId: 'n2' })

  const { markdown, nodes, comments, bytes } = renderRoomMarkdown(room, { at: 1_000 })
  assert.match(markdown, /# comments demo \(.*\)/)
  assert.match(markdown, /## 协作者留言（1）/)
  assert.match(markdown, /alice.*请|alice.*please check step 3/)
  assert.match(markdown, /锚点 `n2`/)
  assert.equal(comments, 1)
  assert.equal(nodes, 0)
  assert.ok(bytes > 100)
  rooms.dispose()
})

test('json export carries the same comments and a pseq', () => {
  const { rooms, room } = roomWithPeer()
  room.addComment({ from: 'alice', text: 'hi' })
  const { json, comments } = renderRoomJson(room, { at: 1_000 })
  const payload = JSON.parse(json)
  assert.equal(payload.code, room.code)
  assert.equal(payload.comments.length, 1)
  assert.equal(comments, 1)
  assert.equal(typeof payload.pseq, 'number')
  rooms.dispose()
})
