// Minimal RFC 6455 server-side WebSocket (text frames, ping/pong, close).
//
// Why hand-rolled: this plugin must stay installable with zero runtime dependencies
// (no native modules, nothing to compile), and the surface we need is small —
// server-side text frames up to 64 KiB, a heartbeat, and a clean close handshake.
// Not supported on purpose: binary frames, extensions/permessage-deflate, client masking.
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

const CLOSE_TEXT = {
  1000: 'normal',
  1002: 'protocol error',
  1003: 'unsupported data',
  1009: 'message too big',
  1011: 'internal error',
}

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

function closePayload(code, reason) {
  const text = Buffer.from(String(reason ?? '').slice(0, 120), 'utf8')
  const buffer = Buffer.allocUnsafe(2 + text.length)
  buffer.writeUInt16BE(code, 0)
  text.copy(buffer, 2)
  return buffer
}

/** One upgraded socket. Emits `message` (string), `close` (code, reason), `error`. */
export class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{maxPayload?: number, isBinaryAllowed?: boolean}} [options]
   */
  constructor(socket, options = {}) {
    super()
    this.socket = socket
    this.maxPayload = options.maxPayload ?? 64 * 1024
    this.buffer = Buffer.alloc(0)
    this.closed = false
    this.closeCode = null
    /** @type {Buffer[]} */
    this.fragments = null
    this.fragmentBytes = 0
    this.since = Date.now()
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => this.#finish(1006, 'socket closed'))
    socket.on('error', (error) => {
      this.emit('error', error)
      this.#finish(1006, 'socket error')
    })
    socket.setNoDelay?.(true)
    socket.setTimeout?.(0)
  }

  get writable() {
    return !this.closed && this.socket.writable
  }

  /** Bytes queued for this peer; used for backpressure decisions. */
  get bufferedBytes() {
    return this.socket.writableLength ?? 0
  }

  /**
   * @param {string} text
   * @returns {boolean} false when the socket is gone
   */
  sendText(text) {
    if (!this.writable) return false
    this.#writeFrame(OP.TEXT, Buffer.from(String(text), 'utf8'))
    return true
  }

  /** Alias for `sendText` so callers can treat this like a common WebSocket surface. */
  send(data) {
    if (typeof data === 'string') return this.sendText(data)
    if (data && typeof data === 'object' && data.byteLength !== undefined) {
      return this.sendText(Buffer.from(data).toString('utf8'))
    }
    return this.sendText(String(data))
  }

  ping(payload = Buffer.alloc(0)) {
    if (!this.writable) return
    this.#writeFrame(OP.PING, Buffer.from(payload))
  }

  /**
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = 1000, reason = '') {
    if (this.closed) return
    try {
      if (this.socket.writable) this.#writeFrame(OP.CLOSE, closePayload(code, reason))
      this.socket.end()
    } catch {
      /* already gone */
    }
    this.#finish(code, reason)
  }

  destroy() {
    try {
      this.socket.destroy()
    } catch {
      /* ignore */
    }
    this.#finish(1006, 'destroyed')
  }

  #finish(code, reason) {
    if (this.closed) return
    this.closed = true
    this.closeCode = code
    this.emit('close', code, reason || CLOSE_TEXT[code] || '')
  }

  #writeFrame(opcode, payload) {
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length])
    } else if (length < 65536) {
      header = Buffer.allocUnsafe(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.allocUnsafe(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    try {
      this.socket.write(Buffer.concat([header, payload]))
    } catch {
      this.#finish(1006, 'write failed')
    }
  }

  #onData(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const rsv = first & 0x70
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2

      if (rsv !== 0) {
        this.close(1002, 'reserved bits set')
        return
      }
      if (!masked) {
        this.close(1002, 'client frames must be masked')
        return
      }
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(this.maxPayload)) {
          this.close(1009, 'frame too large')
          return
        }
        length = Number(big)
        offset = 10
      }
      if (opcode >= 0x8 && (length > 125 || !fin)) {
        this.close(1002, 'bad control frame')
        return
      }
      if (length > this.maxPayload) {
        this.close(1009, 'frame too large')
        return
      }
      if (this.buffer.length < offset + 4 + length) return

      const mask = this.buffer.subarray(offset, offset + 4)
      offset += 4
      const payload = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i += 1) payload[i] = this.buffer[offset + i] ^ mask[i & 3]
      offset += length
      this.buffer = this.buffer.subarray(offset)
      this.#onFrame(fin, opcode, payload)
    }
  }

  #onFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP.CONT: {
        if (!this.fragments) {
          this.close(1002, 'unexpected continuation')
          return
        }
        this.fragments.push(payload)
        this.fragmentBytes += payload.length
        if (this.fragmentBytes > this.maxPayload) {
          this.close(1009, 'message too large')
          return
        }
        if (fin) this.#deliver(this.fragments)
        return
      }
      case OP.TEXT: {
        if (fin) {
          if (payload.length > this.maxPayload) {
            this.close(1009, 'message too large')
            return
          }
          this.#deliver([payload])
          return
        }
        this.fragments = [payload]
        this.fragmentBytes = payload.length
        return
      }
      case OP.BINARY: {
        this.close(1003, 'binary frames are not supported')
        return
      }
      case OP.PING: {
        this.#writeFrame(OP.PONG, payload)
        return
      }
      case OP.PONG: {
        this.emit('pong', payload)
        return
      }
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        try {
          if (this.socket.writable) this.#writeFrame(OP.CLOSE, payload.length >= 2 ? closePayload(code, '') : Buffer.alloc(0))
          this.socket.end()
        } catch {
          /* ignore */
        }
        this.#finish(code, reason)
        return
      }
      default:
        this.close(1002, `unknown opcode ${opcode}`)
    }
  }

  #deliver(chunks) {
    const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
    this.fragments = null
    this.fragmentBytes = 0
    this.emit('message', buffer.toString('utf8'))
  }
}

/**
 * Attach a WebSocket endpoint to an existing HTTP server.
 * @param {import('node:http').Server} server
 * @param {{path?: string, maxPayload?: number, onConnection: (ws: WebSocketConnection, req: import('node:http').IncomingMessage) => void}} options
 * @returns {() => void} disposer
 */
export function attachWebSocket(server, options) {
  return attachWebSocketRoutes(server, {
    maxPayload: options.maxPayload,
    routes: { [options.path ?? '/ws']: options.onConnection },
  })
}

/**
 * Attach several WebSocket endpoints with one upgrade router (one socket, one owner).
 * @param {import('node:http').Server} server
 * @param {{routes: Record<string, (ws: WebSocketConnection, req: import('node:http').IncomingMessage) => void>,
 *          maxPayload?: number}} options
 * @returns {() => void} disposer
 */
export function attachWebSocketRoutes(server, options) {
  const routes = options.routes ?? {}
  const maxPayload = options.maxPayload ?? 64 * 1024

  const onUpgrade = (req, socket, head) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      /* fall through to reject */
    }
    const handler = routes[pathname]
    if (!handler) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
    if (upgrade !== 'websocket' || !key || String(version) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '',
        '',
      ].join('\r\n'),
    )
    socket.setNoDelay?.(true)
    const ws = new WebSocketConnection(socket, { maxPayload })
    if (head && head.length > 0) socket.emit('data', head)
    handler(ws, req)
  }

  server.on('upgrade', onUpgrade)
  return () => server.removeListener('upgrade', onUpgrade)
}
