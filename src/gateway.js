// Read-only workspace gateway.
//
// Boundary rules (fail closed):
//  1. every path resolves under `root`; `..` and absolute escapes are refused,
//  2. symlinks are resolved and re-checked, so a link cannot walk out of the root,
//  3. a default deny list hides secrets and noise before size limits apply,
//  4. text is clipped and secret-shaped substrings are redacted before leaving.
//
// Bytes come from a port (node:fs by default, or the DSH `fs` seam), so this module
// never touches the filesystem directly.
import { basename, dirname, join, resolve, sep } from 'node:path'
import { E, CollabError } from './errors.js'
import { createNodeFsPort } from './fs-port.js'

export const DEFAULT_DENY = [
  '.git/**',
  'node_modules/**',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  '.ssh/**',
  '*.kdbx',
  '.npmrc',
  '.netrc',
  '*.log',
]

const SECRET_PATTERNS = [
  { kind: 'private-key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
]

/** Convert one `*`/`**`/`?` glob to a RegExp matched against posix relative paths. */
export function globToRegExp(glob) {
  const pattern = String(glob).replace(/\\/g, '/')
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  out += '$'
  return new RegExp(out)
}

/** Compile the deny list once per gateway. */
export function compileDeny(globs) {
  return (globs ?? []).map((glob) => {
    const normalized = String(glob).replace(/\\/g, '/')
    return {
      glob: normalized,
      re: globToRegExp(normalized),
      // `dir/**` also hides the directory entry itself, not only its children.
      dirPrefix: normalized.endsWith('/**') ? normalized.slice(0, -3) : null,
    }
  })
}

/** Does `relPath` (posix) fall under any deny entry? */
export function isDenied(relPath, compiled) {
  const path = toPosix(relPath)
  if (!path || path === '.') return false
  const name = basename(path)
  for (const entry of compiled) {
    if (entry.dirPrefix && (path === entry.dirPrefix || path.startsWith(`${entry.dirPrefix}/`))) return true
    if (entry.re.test(path)) return true
    // A bare basename pattern (no slash) also applies at any depth.
    if (!entry.glob.includes('/') && entry.re.test(name)) return true
  }
  return false
}

function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function normalizeRelative(input) {
  const raw = String(input ?? '').trim()
  if (!raw || raw === '.') return ''
  if (raw === '/') return ''
  if (raw.includes('\0')) throw new CollabError(E.badRequest, 'path contains NUL')
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new CollabError(E.scope, 'absolute paths are not allowed; paths are relative to the workspace root')
  }
  const cleaned = raw.replace(/\\/g, '/')
  const segments = []
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (segments.length === 0) throw new CollabError(E.scope, 'path escapes the workspace root')
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments.join('/')
}

/**
 * @param {{root: string, deny?: string[], maxBytes?: number, maxListEntries?: number,
 *          maxSearchFiles?: number, redact?: boolean, logger?: any,
 *          port?: ReturnType<typeof createNodeFsPort>,
 *          onAccess?: (event: {method: string, path: string, bytes?: number, outcome: string}) => void}} options
 */
export function createGateway(options) {
  const root = resolve(String(options.root))
  const port = options.port ?? createNodeFsPort(root)
  const deny = compileDeny(options.deny ?? DEFAULT_DENY)
  const maxBytes = options.maxBytes ?? 262_144
  const maxListEntries = options.maxListEntries ?? 400
  const maxSearchFiles = options.maxSearchFiles ?? 2_000
  const redact = options.redact !== false
  const logger = options.logger
  const onAccess = typeof options.onAccess === 'function' ? options.onAccess : null

  function audit(event) {
    if (!onAccess) return
    try {
      onAccess(event)
    } catch {
      /* audit must never break a read */
    }
  }

  function assertInRoot(relPath) {
    const absolute = resolve(root, relPath)
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new CollabError(E.scope, 'path escapes the workspace root')
    }
    return absolute
  }

  async function checkReal(absolute) {
    const realRoot = await port.realRoot()
    let real = await port.realpath(absolute)
    if (!real) {
      // A missing target has no realpath: canonicalize its parent instead, so a
      // short/8.3 or differently-cased root does not turn E_NOTFOUND into E_SCOPE.
      const parent = await port.realpath(dirname(absolute))
      return parent ? join(parent, basename(absolute)) : absolute
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new CollabError(E.scope, 'path escapes the workspace root (symlink)')
    }
    return real
  }

  function redactText(text) {
    if (!redact) return { text, redactions: 0 }
    let count = 0
    let out = text
    for (const { kind, re } of SECRET_PATTERNS) {
      out = out.replace(re, () => {
        count += 1
        return `[redacted:${kind}]`
      })
    }
    return { text: out, redactions: count }
  }

  async function resolveTarget(input) {
    const rel = normalizeRelative(input)
    if (rel && isDenied(rel, deny)) throw new CollabError(E.denied, `path is on the deny list: ${rel}`)
    const absolute = assertInRoot(rel)
    const real = await checkReal(absolute)
    return { rel, absolute: real }
  }

  async function statOf(input) {
    const { rel, absolute } = await resolveTarget(input)
    let info
    try {
      info = await port.stat(absolute)
    } catch {
      audit({ method: 'files.stat', path: rel || '.', outcome: 'not-found' })
      throw new CollabError(E.notFound, `not found: ${rel || '.'}`)
    }
    audit({ method: 'files.stat', path: rel || '.', outcome: 'ok' })
    return {
      path: rel || '.',
      kind: info.kind,
      size: info.size,
      mtime: Math.floor(info.mtimeMs),
    }
  }

  async function list(input) {
    const { rel, absolute } = await resolveTarget(input)
    let entries
    try {
      entries = await port.list(absolute)
    } catch {
      audit({ method: 'files.list', path: rel || '.', outcome: 'not-found' })
      throw new CollabError(E.notFound, `not found: ${rel || '.'}`)
    }
    const out = []
    let truncated = false
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (isDenied(childRel, deny)) continue
      if (out.length >= maxListEntries) {
        truncated = true
        break
      }
      const row = { name: entry.name, path: childRel, kind: entry.kind }
      if (entry.kind === 'file') {
        if (Number.isFinite(entry.size)) row.size = entry.size
        if (Number.isFinite(entry.mtimeMs)) row.mtime = Math.floor(entry.mtimeMs)
      }
      out.push(row)
    }
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
    audit({ method: 'files.list', path: rel || '.', bytes: out.length, outcome: 'ok' })
    return { path: rel || '.', entries: out, truncated }
  }

  async function read(input, { offset = 0, limit } = {}) {
    const { rel, absolute } = await resolveTarget(input)
    let info
    try {
      info = await port.stat(absolute)
    } catch {
      audit({ method: 'files.read', path: rel || '.', outcome: 'not-found' })
      throw new CollabError(E.notFound, `not found: ${rel || '.'}`)
    }
    if (info.kind === 'directory') throw new CollabError(E.badRequest, `is a directory: ${rel}`)

    const want = Math.max(1, Math.min(Number(limit) || maxBytes, maxBytes))
    const headBytes = Math.min(info.size, Math.max(want + 4096, 4096))
    let buffer
    try {
      buffer = await port.readBuffer(absolute, headBytes)
    } catch (error) {
      audit({ method: 'files.read', path: rel, outcome: 'unreadable' })
      throw new CollabError(E.notFound, `unreadable: ${rel} (${error?.code ?? 'error'})`)
    }

    const probe = buffer.subarray(0, Math.min(buffer.length, 4096))
    if (probe.includes(0)) {
      audit({ method: 'files.read', path: rel, bytes: info.size, outcome: 'binary' })
      return {
        path: rel,
        binary: true,
        bytes: info.size,
        mtime: Math.floor(info.mtimeMs),
        text: '',
        truncated: true,
      }
    }

    const decoded = buffer.toString('utf8')
    const start = Math.max(0, Math.min(Number(offset) || 0, decoded.length))
    const sliced = decoded.slice(start, start + want)
    const { text, redactions } = redactText(sliced)
    const truncated = start + want < decoded.length || info.size > Buffer.byteLength(decoded, 'utf8')
    audit({ method: 'files.read', path: rel, bytes: sliced.length, outcome: 'ok' })
    return {
      path: rel,
      binary: false,
      bytes: info.size,
      mtime: Math.floor(info.mtimeMs),
      offset: start,
      text,
      truncated,
      redactions,
      headBytes: buffer.length,
    }
  }

  async function search(input, { glob, maxResults = 50 } = {}) {
    const query = String(input ?? '')
    if (query.length < 2) throw new CollabError(E.badRequest, 'search needs at least 2 characters')
    const globRe = glob ? globToRegExp(glob) : null
    const limit = Math.max(1, Math.min(Number(maxResults) || 50, 200))
    const matches = []
    let scanned = 0
    let truncated = false

    async function walk(rel) {
      if (truncated) return
      const absolute = assertInRoot(rel)
      let entries
      try {
        entries = await port.list(absolute)
      } catch {
        return
      }
      for (const entry of entries) {
        if (truncated) return
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        if (isDenied(childRel, deny)) continue
        if (entry.kind === 'directory') {
          await walk(childRel)
          continue
        }
        if (entry.kind !== 'file') continue
        if (globRe && !globRe.test(childRel)) continue
        if (scanned >= maxSearchFiles) {
          truncated = true
          return
        }
        scanned += 1
        let text
        try {
          const info = await port.stat(join(absolute, entry.name))
          if (info.size > 512 * 1024) continue
          const buffer = await port.readBuffer(join(absolute, entry.name), 512 * 1024)
          if (buffer.includes(0)) continue
          text = buffer.toString('utf8')
        } catch {
          continue
        }
        let index = text.indexOf(query)
        while (index !== -1 && matches.length < limit) {
          const before = text.slice(0, index)
          const line = before.split('\n').length
          const column = index - before.lastIndexOf('\n')
          const lineStart = text.lastIndexOf('\n', index - 1) + 1
          const lineEnd = text.indexOf('\n', index)
          const preview = text.slice(lineStart, lineEnd === -1 ? Math.min(text.length, lineStart + 240) : lineEnd).trim()
          matches.push({
            path: childRel,
            line,
            column,
            preview: redactText(preview).text.slice(0, 240),
          })
          index = text.indexOf(query, index + query.length)
        }
        if (matches.length >= limit) {
          truncated = true
          return
        }
      }
    }

    await walk('')
    audit({ method: 'files.search', path: '', bytes: matches.length, outcome: 'ok' })
    return { query, matches, scanned, truncated }
  }

  return {
    root,
    port,
    stat: statOf,
    list,
    read,
    search,
    /** Exposed for tests and audits. */
    isDenied: (rel) => isDenied(rel, deny),
    redact: redactText,
    maxBytes,
    logger,
  }
}
