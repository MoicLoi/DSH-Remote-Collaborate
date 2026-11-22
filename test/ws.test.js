import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { attachWebSocket } from '../src/ws.js'

async function echoServer() {
  const connections = []
  const server = createServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  const detach = attachWebSocket(server, {
    path: '/ws',
    maxPayload: 4096,
    onConnection: (ws) => {
      connections.push(ws)
      ws.on('message', (text) => ws.sendText(`echo:${text}`))
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    connections,
    close: async () => {
      detach()
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

function openClient(port, path = '/ws') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    ws.onopen = () => resolve(ws)
    ws.onerror = (event) => reject(new Error(`ws failed: ${event?.message ?? 'error'}`))
  })
}

test('handshake upgrades and echoes text frames', async () => {
  const fixture = await echoServer()
  try {
    const ws = await openClient(fixture.port)
    const message = new Promise((resolve) => {
      ws.onmessage = (event) => resolve(event.data)
    })
    ws.send('hello')
    assert.equal(await message, 'echo:hello')
    ws.close()
  } finally {
    await fixture.close()
  }
})

test('ping frames are answered with pong', async () => {
  const fixture = await echoServer()
  try {
    const ws = await openClient(fixture.port)
    const connection = fixture.connections[0]
    const pong = new Promise((resolve) => connection.once('pong', resolve))
    connection.ping(Buffer.from('x'))
    await pong
    ws.close()
  } finally {
    await fixture.close()
  }
})

test('unknown paths are rejected before upgrade', async () => {
  const fixture = await echoServer()
  try {
    await assert.rejects(() => openClient(fixture.port, '/nope'))
  } finally {
    await fixture.close()
  }
})

test('a server close code reaches the client', async () => {
  const fixture = await echoServer()
  try {
    const ws = await openClient(fixture.port)
    const closed = new Promise((resolve) => {
      ws.onclose = (event) => resolve(event.code)
    })
    fixture.connections[0].close(4401, 'no')
    assert.equal(await closed, 4401)
  } finally {
    await fixture.close()
  }
})

test('oversized inbound frames close the connection with 1009', async () => {
  const fixture = await echoServer()
  try {
    const ws = await openClient(fixture.port)
    const closed = new Promise((resolve) => {
      ws.onclose = (event) => resolve(event.code)
    })
    ws.send('y'.repeat(8000))
    assert.equal(await closed, 1009)
  } finally {
    await fixture.close()
  }
})
