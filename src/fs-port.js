// Filesystem ports: the gateway owns policy, a port owns bytes.
//
// Two implementations:
//  - nodeFsPort: plain node:fs, used when the host composition has no `ctx.fs`
//    (or as a fallback when a seam call fails).
//  - ctxFsPort: routes through the DSH `fs` seam (`resolve`/`stat`/`listDir`/
//    `readBytes`) so host file policy and observation hooks see the access.
//
// Paths handed to a port are absolute and already accepted by the gateway's root
// containment check; the port itself never decides policy.
import { realpath, readdir, stat } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'

function kindOf(info) {
  if (!info) return 'other'
  if (info.isDirectory?.() || info.kind === 'directory') return 'directory'
  if (info.isFile?.() || info.kind === 'file') return 'file'
  return 'other'
}

/** @param {string} root absolute workspace root */
export function createNodeFsPort(root) {
  return {
    kind: 'node',
    root,
    async realRoot() {
      return realpath(root).catch(() => root)
    },
    async realpath(path) {
      try {
        return await realpath(path)
      } catch {
        return null
      }
    },
    async stat(path) {
      const info = await stat(path)
      return { kind: kindOf(info), size: info.size, mtimeMs: info.mtimeMs }
    },
    async list(path) {
      const entries = await readdir(path, { withFileTypes: true })
      const out = []
      for (const entry of entries) {
        const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
        const row = { name: entry.name, kind }
        if (kind === 'file') {
          try {
            const info = await stat(`${path}/${entry.name}`)
            row.size = info.size
            row.mtimeMs = info.mtimeMs
          } catch {
            /* raced away */
          }
        }
        out.push(row)
      }
      return out
    },
    /** Read at most `maxBytes` from the head of a file. */
    async readBuffer(path, maxBytes) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.allocUnsafe(Math.max(1, maxBytes))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        return buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    },
  }
}

/**
 * Wrap the host `ctx.fs` seam. Every method degrades to `fallback` on error so an
 * unexpected seam shape cannot take file browsing down; the caller keeps working
 * with node:fs semantics.
 * @param {{fs: any, fallback: ReturnType<typeof createNodeFsPort>, logger?: any}} input
 */
export function createCtxFsPort({ fs, fallback, logger }) {
  const targets = new Map()
  let warned = false

  function warnOnce(method, error) {
    if (warned) return
    warned = true
    logger?.warn?.('dsh-collab: ctx.fs.%s failed (%s); using node:fs fallback', method, error?.message ?? error)
  }

  async function targetOf(path) {
    if (targets.has(path)) return targets.get(path)
    const target = await fs.resolve(path)
    targets.set(path, target)
    return target
  }

  function entryKind(entry) {
    if (!entry || typeof entry !== 'object') return 'other'
    if (entry.kind === 'directory' || entry.isDirectory === true || entry.type === 'directory') return 'directory'
    if (entry.kind === 'file' || entry.isFile === true || entry.type === 'file') return 'file'
    return 'other'
  }

  return {
    kind: 'ctx.fs',
    root: fallback.root,
    async realRoot() {
      try {
        const rootTarget = await targetOf(fallback.root)
        const resolved = fs.processPath?.(rootTarget)
        return typeof resolved === 'string' && resolved ? resolved : fallback.realRoot()
      } catch (error) {
        warnOnce('resolve', error)
        return fallback.realRoot()
      }
    },
    async realpath(path) {
      try {
        const target = await targetOf(path)
        const resolved = fs.processPath?.(target)
        return typeof resolved === 'string' && resolved ? resolved : null
      } catch (error) {
        warnOnce('resolve', error)
        return null
      }
    },
    async stat(path) {
      try {
        const info = await fs.stat(await targetOf(path))
        if (!info) throw new Error('no stat')
        return {
          kind: info.kind === 'directory' || info.isDirectory ? 'directory' : 'file',
          size: Number(info.size ?? 0),
          mtimeMs: Number(info.mtimeMs ?? info.mtime ?? Date.now()),
        }
      } catch (error) {
        warnOnce('stat', error)
        return fallback.stat(path)
      }
    },
    async list(path) {
      try {
        const entries = await fs.listDir(await targetOf(path))
        if (!Array.isArray(entries)) throw new Error('listDir did not return an array')
        return entries.map((entry) => ({
          name: String(entry.name ?? entry.path ?? basename(String(entry.path ?? ''))),
          kind: entryKind(entry),
          size: entry.size === undefined ? undefined : Number(entry.size),
          mtimeMs: entry.mtimeMs === undefined ? undefined : Number(entry.mtimeMs),
        }))
      } catch (error) {
        warnOnce('listDir', error)
        return fallback.list(path)
      }
    },
    async readBuffer(path, maxBytes) {
      try {
        const bytes = await fs.readBytes(await targetOf(path), undefined, maxBytes)
        return Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)
      } catch (error) {
        warnOnce('readBytes', error)
        return fallback.readBuffer(path, maxBytes)
      }
    },
  }
}
