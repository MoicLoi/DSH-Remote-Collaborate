import test from 'node:test'
import assert from 'node:assert/strict'
import { readStreamEvent } from '../src/stream.js'
import { createProjector } from '../src/projector.js'
import { RoomManager } from '../src/room.js'

test('stream adapter reads the documented text-delta shape', () => {
  const payload = {
    agent: { session: { id: 's1' } },
    frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'hello' } },
  }
  const event = readStreamEvent(payload)
  assert.equal(event.kind, 'delta')
  assert.equal(event.text, 'hello')
  assert.equal(event.sessionId, 's1')
})

test('stream adapter tolerates a bare chunk and a bare delta frame', () => {
  assert.equal(readStreamEvent({ frame: { type: 'text-delta', text: 'a' } }).text, 'a')
  assert.equal(readStreamEvent({ type: 'text-delta', text: 'b' }).text, 'b')
  assert.equal(readStreamEvent({ frame: { chunk: { text: 'c' } } }).text, 'c')
})

test('stream adapter maps start/end and ignores non-text chunks', () => {
  assert.equal(readStreamEvent({ frame: { type: 'start', turn: 2, step: 3 } }).kind, 'start')
  assert.equal(readStreamEvent({ frame: { type: 'start', turn: 2, step: 3 } }).turn, 2)
  assert.equal(readStreamEvent({ frame: { type: 'end' } }).kind, 'end')
  assert.equal(readStreamEvent({ frame: { chunk: { type: 'reasoning-delta', text: 'hm' } } }).kind, 'ignore')
  assert.equal(readStreamEvent({ frame: { chunk: { type: 'usage', usage: {} } } }).kind, 'ignore')
  assert.equal(readStreamEvent(null).kind, 'ignore')
  assert.equal(readStreamEvent({ frame: {} }).kind, 'ignore')
})

test('projector streams text, then lets settlement replace it', () => {
  const projector = createProjector({ now: () => 1 })
  const startOps = projector.beginStream({ turn: 1, step: 1 })
  assert.equal(startOps[0].op, 'append')
  assert.equal(startOps[0].node.streaming, true)
  const id = startOps[0].node.id

  const deltaOps = projector.appendStream('hello ')
  assert.deepEqual(deltaOps, [{ op: 'text', id, delta: 'hello ' }])
  projector.appendStream('world')

  const settleOps = projector.apply({
    seq: 1,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'hello world!' }] }, usage: { inputTokens: 3, outputTokens: 2 } },
  })
  const update = settleOps.find((op) => op.op === 'update')
  assert.equal(update.fields.text, 'hello world!')
  assert.equal(update.fields.streaming, false)
  assert.deepEqual(update.fields.tokens, { input: 3, output: 2 })
  assert.equal(projector.snapshot().nodes.length, 1, 'no duplicate node after settlement')
})

test('projector closes a dangling stream on step/end', () => {
  const projector = createProjector({ now: () => 1 })
  projector.beginStream({ turn: 1, step: 1 })
  projector.appendStream('partial')
  const ops = projector.apply({ seq: 2, type: 'step/end', data: { turn: 1, step: 1 } })
  const final = ops.find((op) => op.op === 'update' && op.fields.streaming === false)
  assert.ok(final, 'the stream node is finalized')
  assert.equal(projector.streaming, false)
})

test('stream text is bounded by the node text cap', () => {
  const projector = createProjector({ now: () => 1, maxNodeText: 10 })
  projector.beginStream({})
  projector.appendStream('x'.repeat(8))
  const ops = projector.appendStream('yyyy')
  assert.equal(ops[0].delta, 'yy')
  const node = projector.snapshot().nodes[0]
  assert.equal(node.streaming, false)
  assert.equal(node.truncated, true)
})

test('room coalesces deltas into one patch per flush and tracks the cursor', () => {
  const rooms = new RoomManager({ baseUrl: () => 'http://127.0.0.1:1', ttlMs: 60_000 })
  const room = rooms.ensure({ sessionId: 's1', cwd: process.cwd() })
  const frames = []
  room.addPeer({ id: 'p1', name: 'peer', kind: 'web', send: (frame) => frames.push(frame), close() {} })

  room.queueStreamText('he')
  room.queueStreamText('llo')
  assert.equal(frames.length, 0, 'deltas are buffered, not sent per token')

  room.flushStream()
  const patch = frames.find((frame) => frame.t === 'patch')
  assert.ok(patch)
  assert.equal(patch.pseq, 1)
  assert.equal(patch.ops[0].op, 'append', 'the first delta opens the assistant node')
  assert.equal(patch.ops[1].op, 'text')
  assert.equal(patch.ops[1].delta, 'hello')

  room.queueStreamText('!')
  room.applyEvent({ seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } })
  const patches = frames.filter((frame) => frame.t === 'patch')
  assert.equal(patches.at(-1).pseq, 3, 'buffered text flushed before the next patch')
  rooms.dispose()
})

test('resume replays only missed patches and refuses a gap', () => {
  const rooms = new RoomManager({ baseUrl: () => 'http://127.0.0.1:1', ttlMs: 60_000 })
  const room = rooms.ensure({ sessionId: 's2', cwd: process.cwd() })
  room.applyEvent({ seq: 1, type: 'turn/start', data: { turn: 1 } })
  room.applyEvent({ seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } })

  assert.equal(room.patchSeq, 2)
  assert.deepEqual(
    room.resumeFrom(0)?.map((entry) => entry.pseq),
    [1, 2],
  )
  assert.deepEqual(room.resumeFrom(2), [])
  assert.equal(room.resumeFrom(99), null, 'a cursor ahead of the room requires a snapshot')

  room.ring = [{ pseq: 2, ops: [] }]
  assert.equal(room.resumeFrom(0), null, 'a trimmed ring cannot satisfy the cursor')
  rooms.dispose()
})
