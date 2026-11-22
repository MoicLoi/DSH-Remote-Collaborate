import test from 'node:test'
import assert from 'node:assert/strict'
import { startHub } from '../src/hub.js'

const silent = { info() {}, warn() {}, error() {} }

function connectHost({ hubOrigin, room, token, name = 'host', direct = [] }) {
  const url = new URL(`${hubOrigin.replace(/^http/, 'ws')}/hub/host`)
  url.searchParams.set('room', room)
  if (token) url.searchParams.set('token', token)
  const ws = new WebSocket(url.toString())
  const frames = []
  let waiters = []
  const settle = (frame) => {
    frames.push(frame)
    const hit = waiters.find((waiter) => waiter.predicate(frame))
    if (hit) {
      waiters = waiters.filter((item) => item !== hit)
      hit.resolve(frame)
    }
  }
  ws.onopen = () => ws.send(JSON.stringify({ v: 1, t: 'register', room, name, direct }))
  ws.onmessage = (event) => settle(JSON.parse(event.data))
  ws.onclose = (event) => settle({ t: 'closed', code: event.code, reason: event.reason })
  ws.onerror = () => {}
  return {
    ws,
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor(predicate, timeoutMs = 4000) {
      const hit = frames.find(predicate)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve }
        waiters.push(waiter)
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        timer.unref?.()
        waiter.resolve = (frame) => {
          clearTimeout(timer)
          resolve(frame)
        }
      })
    },
    close: () => ws.close(),
  }
}

function connectPeerSocket({ hubOrigin, room }) {
  const url = new URL(`${hubOrigin.replace(/^http/, 'ws')}/hub/peer`)
  url.searchParams.set('room', room)
  const ws = new WebSocket(url.toString())
  const frames = []
  let waiters = []
  const settle = (frame) => {
    frames.push(frame)
    const hit = waiters.find((waiter) => waiter.predicate(frame))
    if (hit) {
      waiters = waiters.filter((item) => item !== hit)
      hit.resolve(frame)
    }
  }
  ws.onmessage = (event) => settle(JSON.parse(event.data))
  ws.onclose = (event) => settle({ t: 'closed', code: event.code, reason: event.reason })
  ws.onerror = () => {}
  return {
    ws,
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor(predicate, timeoutMs = 4000) {
      const hit = frames.find(predicate)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve }
        waiters.push(waiter)
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        timer.unref?.()
        waiter.resolve = (frame) => {
          clearTimeout(timer)
          resolve(frame)
        }
      })
    },
    close: () => ws.close(),
  }
}

async function setup(t) {
  const hub = await startHub({ bind: '127.0.0.1', port: 0, token: 'hub-secret', logger: silent })
  t.after(() => hub.close())
  return hub
}

test('a host registers and a peer relays frames both ways', async (t) => {
  const hub = await setup(t)
  const host = connectHost({ hubOrigin: hub.origin, room: 'ABC12345', token: 'hub-secret', direct: ['http://192.168.1.9:8848'] })
  t.after(() => host.close())
  const registered = await host.waitFor((frame) => frame.t === 'registered')
  assert.equal(registered.room, 'ABC12345')

  const peer = connectPeerSocket({ hubOrigin: hub.origin, room: 'ABC12345' })
  t.after(() => peer.close())
  const attached = await peer.waitFor((frame) => frame.t === 'attached')
  assert.equal(attached.peer, 'p1')
  assert.deepEqual(attached.host.direct, ['http://192.168.1.9:8848'])

  const opened = await host.waitFor((frame) => frame.t === 'peer-open')
  assert.equal(opened.peer, 'p1')

  peer.send({ v: 1, t: 'relay', payload: '{"v":1,"t":"hello","room":"ABC12345"}' })
  const inbound = await host.waitFor((frame) => frame.t === 'relay' && frame.peer === 'p1')
  assert.equal(inbound.payload, '{"v":1,"t":"hello","room":"ABC12345"}')

  host.send({ v: 1, t: 'relay', peer: 'p1', payload: '{"v":1,"t":"challenge"}' })
  const outbound = await peer.waitFor((frame) => frame.t === 'relay')
  assert.equal(outbound.payload, '{"v":1,"t":"challenge"}')
})

test('room metadata is public and peer auth is not required for it', async (t) => {
  const hub = await setup(t)
  const host = connectHost({ hubOrigin: hub.origin, room: 'META1234', token: 'hub-secret', direct: ['http://10.0.0.2:8848'] })
  t.after(() => host.close())
  await host.waitFor((frame) => frame.t === 'registered')

  const res = await fetch(`${hub.origin}/hub/room/META1234`)
  assert.equal(res.status, 200)
  const meta = await res.json()
  assert.equal(meta.room, 'META1234')
  assert.deepEqual(meta.direct, ['http://10.0.0.2:8848'])
  assert.equal(meta.peers, 0)

  const missing = await fetch(`${hub.origin}/hub/room/NQPE1234`)
  assert.equal(missing.status, 404)
})

test('a bad hub token is refused', async (t) => {
  const hub = await setup(t)
  const host = connectHost({ hubOrigin: hub.origin, room: 'BAD12345', token: 'wrong' })
  t.after(() => host.close())
  const closed = await host.waitFor((frame) => frame.t === 'closed')
  assert.equal(closed.code, 4401)
})

test('a duplicate room code is refused', async (t) => {
  const hub = await setup(t)
  const first = connectHost({ hubOrigin: hub.origin, room: 'DVP12345', token: 'hub-secret' })
  t.after(() => first.close())
  await first.waitFor((frame) => frame.t === 'registered')

  const second = connectHost({ hubOrigin: hub.origin, room: 'DVP12345', token: 'hub-secret' })
  t.after(() => second.close())
  const closed = await second.waitFor((frame) => frame.t === 'closed')
  assert.equal(closed.code, 4409)
})

test('an unknown room rejects peers with 4404', async (t) => {
  const hub = await setup(t)
  const peer = connectPeerSocket({ hubOrigin: hub.origin, room: 'GH5T1234' })
  t.after(() => peer.close())
  const closed = await peer.waitFor((frame) => frame.t === 'closed')
  assert.equal(closed.code, 4404)
})

test('host disconnect closes the room and its peers', async (t) => {
  const hub = await setup(t)
  const host = connectHost({ hubOrigin: hub.origin, room: 'CQSE1234', token: 'hub-secret' })
  await host.waitFor((frame) => frame.t === 'registered')
  const peer = connectPeerSocket({ hubOrigin: hub.origin, room: 'CQSE1234' })
  t.after(() => peer.close())
  await peer.waitFor((frame) => frame.t === 'attached')

  host.close()
  const closed = await peer.waitFor((frame) => frame.t === 'close' || frame.t === 'closed', 5000)
  assert.ok([4408, 1006].includes(closed.code), `expected room close, got ${closed.code}`)
  const res = await fetch(`${hub.origin}/hub/room/CQSE1234`)
  assert.equal(res.status, 404)
})

test('the hub serves the share page for a live room only', async (t) => {
  const hub = await setup(t)
  const host = connectHost({ hubOrigin: hub.origin, room: 'PAGE1234', token: 'hub-secret' })
  t.after(() => host.close())
  await host.waitFor((frame) => frame.t === 'registered')

  const page = await fetch(`${hub.origin}/c/PAGE1234`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /dsh-collab/)

  const gone = await fetch(`${hub.origin}/c/NQPE1234`)
  assert.equal(gone.status, 404)

  const health = await fetch(`${hub.origin}/healthz`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)
})

