#!/usr/bin/env node
// Plugin-level smoke test WITHOUT a DSH host: a fake Cordis ctx exercises `apply()`,
// the /collab command, and the real WebSocket edge from a peer's point of view.
//
//   node scripts/smoke-plugin.mjs
//
// Requires @deepseek-ai/schemastery to be resolvable (a DSH profile provides it;
// locally, link it into ./node_modules/@deepseek-ai/schemastery).
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, pickLanAddress, resolveConfig } from '../src/index.js'
import { connectPeer } from '../test/helpers/peer.mjs'
import { parseLink } from '../src/invite.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-collab-smoke-'))
await writeFile(join(root, 'hello.txt'), 'hello from the workspace\n')

const disposers = []
const commands = new Map()
const tools = new Map()
const warnings = []

const session = {
  id: 'session-smoke',
  title: 'smoke',
  header: { cwd: root },
  snapshotEvents: () => [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'hello from history' }] } } },
  ],
}

const agent = { session }

const services = {
  sessions: { get: (id) => (id === session.id ? session : undefined) },
  agents: { get: (id) => (id === session.id ? agent : undefined), currentInitiator: () => agent },
  commands: {
    register(definition) {
      commands.set(definition.name, definition)
      return () => commands.delete(definition.name)
    },
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
}

const ctx = {
  logger: () => ({
    info: () => {},
    warn: (message) => warnings.push(String(message)),
    error: () => {},
  }),
  effect(factory) {
    const dispose = factory()
    disposers.push(dispose)
    return dispose
  },
  on() {
    return () => {}
  },
  // No webServer in this fake composition: Cordis would simply never run the
  // callback, so the in-GUI panel stays off while everything else works.
  inject() {},
  // Cordis only exposes undeclared services through ctx.get; mirror that here so the
  // smoke test exercises the same lookup path the real host enforces.
  get: (name) => services[name],
}

assert.ok(Config, 'Config schema must be exported for the loader')
assert.equal(typeof pickLanAddress(), 'string')
assert.equal(resolveConfig({ port: 1 }).port, 1)
assert.equal(resolveConfig({ role: 'hub' }).role, 'hub', 'hub role is a valid composition')
assert.throws(() => resolveConfig({ mode: 'hub' }), /hubUrl/, 'hub mode without a hub URL fails loud')
assert.throws(() => resolveConfig({ role: 'nope' }), /role must be/)

apply(ctx, { bind: '127.0.0.1', port: 0, hostName: 'smoke-host', ttlMinutes: 30 })
await new Promise((resolve) => setTimeout(resolve, 300))

assert.ok(commands.has('collab'), '/collab command registered')
assert.ok(tools.has('collab_share'), 'collab_share tool registered')
assert.ok(tools.has('collab_status'), 'collab_status tool registered')

const command = commands.get('collab')
const result = await command.handler({ agent, rawInput: '', signal: new AbortController().signal })
assert.equal(result.kind, 'success', result.text)
const linkMatch = /https?:\/\/\S+/.exec(result.text)
assert.ok(linkMatch, 'command returned a link')
const target = parseLink(linkMatch[0])
console.log(`link: ${linkMatch[0]}`)

const peer = connectPeer({ origin: target.origin, room: target.room, secret: target.secret, name: 'smoke-peer' })
const ready = await peer.waitFor((frame) => frame.t === 'ready')
assert.equal(ready.name, 'smoke-host')
assert.equal(peer.state.hostProofOk, true)
const snapshot = await peer.waitFor((frame) => frame.t === 'snapshot')
assert.equal(snapshot.nodes.length, 2, 'history was primed from the session log')

const file = await peer.call('files.read', { path: 'hello.txt' })
assert.equal(file.text, 'hello from the workspace\n')

const share = await tools.get('collab_share').execute({ note: 'hi' }, { agent })
assert.equal(share.ok, true)
assert.ok(share.link.startsWith('http://'))
assert.equal(share.room, target.room, 'the room is reused for the same session')

const status = await tools.get('collab_status').execute({}, { agent })
assert.equal(status.rooms.length, 1)
assert.equal(status.rooms[0].peers, 1)

peer.close()
await new Promise((resolve) => setTimeout(resolve, 100))

for (const dispose of disposers.reverse()) await dispose()
await rm(root, { recursive: true, force: true })

console.log('plugin smoke: OK (config, command, tools, share server, peer view, file read)')
