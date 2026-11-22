// Test clients for the real wire protocol: direct WebSocket and hub relay.
import { deriveKey, newNonce, open, proof, seal } from '../../src/crypto.js'

function parse(data) {
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

/**
 * @param {{url: string, room: string, secret: string, kind?: 'web'|'tui', name?: string,
 *          resumeFrom?: number, relay?: boolean}} input
 */
function openPeer({ url, room, secret, kind = 'web', name = 'tester', resumeFrom, relay = false }) {
  const key = deriveKey(secret, room)
  const ws = new WebSocket(url)
  /** @type {any[]} */
  const frames = []
  /** @type {{predicate: (frame:any)=>boolean, resolve: (frame:any)=>void}[]} */
  let waiters = []
  let peerNonce = ''
  let outSeq = 0
  const pending = new Map()
  const state = { ready: null, closed: null, key, room, relay, peerId: null }
  let callId = 0
  let closedByHub = false

  const settle = (frame) => {
    frames.push(frame)
    const hit = waiters.find((waiter) => waiter.predicate(frame))
    if (hit) {
      waiters = waiters.filter((waiter) => waiter !== hit)
      hit.resolve(frame)
    }
  }

  const sendJson = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    ws.send(relay ? JSON.stringify({ v: 1, t: 'relay', payload: text }) : text)
  }

  ws.onopen = () => {
    // In relay mode the hub answers with `attached`; the protocol hello is sent anyway
    // so the host sees it as soon as the relay route is live.
    sendJson({ v: 1, t: 'hello', room, client: { kind, name } })
  }

  ws.onmessage = async (event) => {
    const outer = parse(event.data)
    if (!outer) return
    if (relay) {
      if (outer.t === 'attached') {
        state.peerId = outer.peer
        state.attached = outer
        return
      }
      if (outer.t === 'close') {
        closedByHub = true
        state.closed = { code: outer.code, reason: outer.reason }
        settle({ t: 'closed', code: outer.code, reason: outer.reason })
        ws.close()
        return
      }
      if (outer.t !== 'relay') return
    }
    const frame = relay ? parse(outer.payload) : outer
    if (!frame) return

    if (frame.t === 'challenge') {
      peerNonce = newNonce()
      sendJson({
        v: 1,
        t: 'join',
        room,
        proof: proof(key, [frame.nonce, room, peerNonce]),
        peerNonce,
        resumeFrom: Number.isSafeInteger(resumeFrom) ? resumeFrom : undefined,
        kind,
        name,
      })
      return
    }
    if (frame.t === 'bye') {
      state.closed = state.closed ?? { code: frame.code, reason: frame.reason }
      settle(frame)
      return
    }
    if (frame.t === 'enc') {
      const logical = open(key, room, frame)
      if (logical.t === 'ready') {
        state.ready = logical
        state.hostProofOk = logical.hostProof === proof(key, [peerNonce, room, 'host'])
      }
      if (logical.t === 'result') {
        const entry = pending.get(logical.id)
        if (entry) {
          pending.delete(logical.id)
          if (logical.ok) entry.resolve(logical.data)
          else entry.reject(Object.assign(new Error(logical.error?.message ?? 'error'), { code: logical.error?.code }))
        }
      }
      settle(logical)
    }
  }

  ws.onclose = (event) => {
    state.closed = state.closed ?? { code: event.code, reason: event.reason }
    settle({ t: 'closed', code: event.code, reason: event.reason })
  }

  ws.onerror = () => {}

  function waitFor(predicate, timeoutMs = 4000) {
    const hit = frames.find(predicate)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve }
      waiters.push(waiter)
      const timer = setTimeout(() => {
        waiters = waiters.filter((item) => item !== waiter)
        reject(new Error('timed out waiting for a frame'))
      }, timeoutMs)
      timer.unref?.()
      waiter.resolve = (frame) => {
        clearTimeout(timer)
        resolve(frame)
      }
    })
  }

  function sendLogical(frame) {
    outSeq += 1
    sendJson({ v: 1, t: 'enc', ...seal(key, room, outSeq, frame) })
  }

  function call(method, params = {}, timeoutMs = 4000) {
    callId += 1
    const id = `c${callId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('call timed out'))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      sendLogical({ v: 1, t: 'call', id, method, params })
    })
  }

  return {
    ws,
    state,
    frames,
    waitFor,
    call,
    ping: () => sendLogical({ v: 1, t: 'ping', n: 1 }),
    activity: (kind, detail) => sendLogical({ v: 1, t: 'activity', kind, detail }),
    comment: (text, nodeId) => sendLogical({ v: 1, t: 'comment', text, nodeId }),
    bye: () => sendLogical({ v: 1, t: 'bye' }),
    close: () => ws.close(),
    get closedByHub() {
      return closedByHub
    },
  }
}

/** Direct WebSocket to the host's own edge. */
export function connectPeer({ origin, room, secret, kind = 'web', name = 'tester', resumeFrom }) {
  const url = `${origin.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(room)}`
  return openPeer({ url, room, secret, kind, name, resumeFrom, relay: false })
}

/** Relayed through the hub. */
export function connectRelayPeer({ hubOrigin, room, secret, kind = 'web', name = 'tester', resumeFrom }) {
  const url = `${hubOrigin.replace(/^http/, 'ws')}/hub/peer?room=${encodeURIComponent(room)}`
  return openPeer({ url, room, secret, kind, name, resumeFrom, relay: true })
}
