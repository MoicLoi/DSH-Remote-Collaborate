// Per-room audit trail: one JSONL line per file access, bounded and fail-soft.
//
// The point is a host-answerable question ("what did the invitee read?"), not
// compliance-grade logging: no message bodies, no file content, only method, path,
// byte count, outcome, and peer label.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultAuditDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-collab')
}

/**
 * @param {{dir?: string, room: string, maxBytes?: number, now?: () => number, logger?: any}} options
 */
export function createAudit(options) {
  const dir = options.dir || defaultAuditDir()
  const room = String(options.room)
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  const now = options.now ?? (() => Date.now())
  const logger = options.logger
  const file = join(dir, `audit-${room}.jsonl`)
  let ready = null
  let queue = Promise.resolve()
  let bytes = 0
  let events = 0
  let lastAt = 0
  let closed = false

  async function ensureDir() {
    if (!ready) ready = mkdir(dir, { recursive: true }).catch(() => {})
    await ready
  }

  async function rotate() {
    try {
      const info = await stat(file)
      if (info.size <= maxBytes) return
      await rename(file, `${file}.1`).catch(() => {})
      bytes = 0
    } catch {
      /* no file yet */
    }
  }

  /**
   * Record one access. Never throws, never blocks the caller.
   * @param {{peer?: string, ip?: string, method: string, path: string, bytes?: number, outcome: string}} event
   */
  function record(event) {
    if (closed) return
    const row = {
      at: now(),
      room,
      peer: String(event.peer ?? 'unknown').slice(0, 60),
      ip: event.ip ? String(event.ip) : undefined,
      method: String(event.method ?? 'unknown'),
      path: String(event.path ?? '').slice(0, 300),
      bytes: Number.isFinite(event.bytes) ? Number(event.bytes) : undefined,
      outcome: String(event.outcome ?? 'ok'),
    }
    events += 1
    lastAt = row.at
    const line = `${JSON.stringify(row)}\n`
    bytes += Buffer.byteLength(line, 'utf8')
    queue = queue
      .then(ensureDir)
      .then(() => appendFile(file, line, 'utf8'))
      .then(() => (bytes > maxBytes ? rotate() : undefined))
      .catch((error) => {
        logger?.warn?.('dsh-collab: audit write failed %s', error?.message ?? error)
      })
  }

  function summary() {
    return { room, file, events, lastAt, bytes }
  }

  async function dispose() {
    closed = true
    await queue.catch(() => {})
  }

  return { record, summary, dispose, file }
}
