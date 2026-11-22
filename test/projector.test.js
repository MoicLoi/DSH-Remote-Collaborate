import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjector, textOf } from '../src/projector.js'

const at = (n) => 1700000000000 + n * 1000

function feed(projector, events) {
  const ops = []
  let seq = 0
  for (const [type, data] of events) {
    seq += 1
    ops.push(...projector.apply({ seq, type, data }))
  }
  return ops
}

test('textOf flattens text blocks and tool-result content', () => {
  assert.equal(textOf('plain'), 'plain')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOf([{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }]), 'ok')
  assert.equal(textOf(null), '')
})

test('a turn projects into turn, user, assistant, and tool nodes', () => {
  const projector = createProjector({ now: () => at(0) })
  const ops = feed(projector, [
    ['turn/start', { turn: 1 }],
    ['user/message', { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }],
    ['step/start', { turn: 1, step: 1 }],
    ['assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } }],
    ['tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
    ['tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] } }],
    ['step/end', { turn: 1, step: 1 }],
    ['turn/end', { turn: 1, reason: { kind: 'stop' } }],
  ])
  const kinds = ops.filter((op) => op.op === 'append').map((op) => op.node.kind)
  assert.deepEqual(kinds, ['turn', 'user', 'notice', 'assistant', 'tool', 'notice'])

  const snapshot = projector.snapshot()
  const tool = snapshot.nodes.find((node) => node.kind === 'tool')
  assert.equal(tool.tool.name, 'read')
  assert.equal(tool.tool.status, 'ok')
  assert.equal(tool.tool.resultSummary, 'done')
  assert.equal(tool.tool.argSummary, '{"path":"a.ts"}')

  const assistant = snapshot.nodes.find((node) => node.kind === 'assistant')
  assert.equal(assistant.text, 'hi there')
})

test('tool result without a prior call still produces a row', () => {
  const projector = createProjector({ now: () => at(0) })
  projector.apply({ seq: 1, type: 'tool/result', data: { message: { toolCallId: 'x', name: 'grep', content: [{ type: 'text', text: 'hit' }] } } })
  const tool = projector.snapshot().nodes.find((node) => node.kind === 'tool')
  assert.equal(tool.tool.name, 'grep')
  assert.equal(tool.tool.status, 'ok')
})

test('failed tool results carry the error reason and status', () => {
  const projector = createProjector({ now: () => at(0) })
  feed(projector, [['tool/call', { callId: 'c9', name: 'edit', arguments: '{}' }]])
  feed(projector, [
    ['tool/result', { message: { toolCallId: 'c9', isError: true, content: [] }, error: { name: 'EditError', code: 'E_NO_MATCH', reason: 'string not found' } }],
  ])
  const tool = projector.snapshot().nodes.find((node) => node.kind === 'tool')
  assert.equal(tool.tool.status, 'error')
  assert.equal(tool.tool.resultSummary, 'string not found')
})

test('unknown event types are ignored, not fatal', () => {
  const projector = createProjector({ now: () => at(0) })
  const ops = feed(projector, [
    ['some/future-event', { whatever: true }],
    ['assistant/attempt', { stream: [] }],
    ['user/message', { message: { role: 'user', content: [{ type: 'text', text: 'still works' }] } }],
  ])
  assert.equal(ops.length, 1)
  assert.equal(projector.snapshot().nodes[0].text, 'still works')
})

test('injected user messages become notices with their source', () => {
  const projector = createProjector({ now: () => at(0) })
  projector.apply({
    seq: 1,
    type: 'user/message',
    data: { message: { role: 'user', source: { type: 'agent.inject' }, content: [{ type: 'text', text: 'context' }] } },
  })
  const node = projector.snapshot().nodes[0]
  assert.equal(node.kind, 'notice')
  assert.equal(node.source, 'agent.inject')
})

test('long assistant text is clipped with a marker', () => {
  const projector = createProjector({ now: () => at(0), maxNodeText: 20 })
  projector.apply({
    seq: 1,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'x'.repeat(100) }] } },
  })
  const node = projector.snapshot().nodes[0]
  assert.match(node.text, /truncated 80 chars/)
})

test('the projector keeps a bounded window and reports truncation', () => {
  const projector = createProjector({ now: () => at(0), maxNodes: 3 })
  for (let i = 0; i < 6; i += 1) {
    projector.apply({ seq: i + 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: `m${i}` }] } } })
  }
  const snapshot = projector.snapshot()
  assert.equal(snapshot.nodes.length, 3)
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.nodes.at(-1).text, 'm5')
})
