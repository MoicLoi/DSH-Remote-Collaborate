// Config resolution: defaults + loud validation.
// The Schemastery `Config` in index.js is the loader-facing schema; this module is the
// runtime half (also usable from tests and the demo script without DSH).
import { isIP } from 'node:net'
import { DEFAULT_DENY } from './gateway.js'

export const DEFAULTS = {
  role: 'host',
  /** 'lan' serves links from this host; 'hub' serves them from the central hub. */
  mode: 'lan',
  bind: '127.0.0.1',
  port: 8848,
  /** Extra host name to advertise in links (VPN / overlay address). Empty = auto. */
  advertiseHost: '',
  hostName: '',
  /** Workspace root override. Empty = the bound session's cwd. */
  root: '',
  allowPeers: 8,
  ttlMinutes: 30,
  maxFileBytes: 262_144,
  redact: true,
  files: true,
  /** Token-level live text through `agent/assistant-stream`. */
  streaming: true,
  /** Peers may leave comments/annotations (room-level, capped and rate-limited). */
  allowComments: true,
  /** One JSONL access log per room under $DSH_HOME/dsh-collab. */
  audit: true,
  auditDir: '',
  auditMaxBytes: 2 * 1024 * 1024,
  /** Loopback-only host console; a token opens it to remote operators. */
  adminToken: '',
  denyGlobs: DEFAULT_DENY,
  /** Central hub (host mode 'hub'). `hubUrl` is both the WS target and the link origin. */
  hubUrl: '',
  hubToken: '',
  /** Extra origins advertised to peers for a direct attempt before falling back to relay. */
  directOrigins: [],
  /** Hub role settings. */
  hubBind: '127.0.0.1',
  hubPort: 8787,
  hubTlsCert: '',
  hubTlsKey: '',
  hubMaxPeers: 32,
  hubRoomTtlMinutes: 480,
}

/**
 * @param {Record<string, unknown>} [raw]
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS, ...input }

  if (cfg.role !== 'host' && cfg.role !== 'hub') {
    throw new Error(`dsh-collab: role must be "host" or "hub", got "${cfg.role}"`)
  }

  if (cfg.role === 'host' && cfg.mode !== 'lan' && cfg.mode !== 'hub') {
    throw new Error(`dsh-collab: mode must be "lan" or "hub", got "${cfg.mode}"`)
  }

  const hubUrl = String(cfg.hubUrl ?? '').trim().replace(/\/+$/, '')
  if (cfg.role === 'host' && cfg.mode === 'hub') {
    if (!/^https?:\/\/[^\s]+$/.test(hubUrl)) {
      throw new Error(`dsh-collab: mode "hub" needs an http(s) hubUrl, got "${cfg.hubUrl}"`)
    }
  }
  if (hubUrl && !/^https?:\/\/[^\s]+$/.test(hubUrl)) {
    throw new Error(`dsh-collab: hubUrl must be an http(s) origin, got "${cfg.hubUrl}"`)
  }

  const port = Number(cfg.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`dsh-collab: port must be an integer 0..65535, got ${cfg.port}`)
  }

  const bind = String(cfg.bind ?? '').trim()
  const loopback = bind === 'localhost' || bind === '::1'
  if (!loopback && bind !== '0.0.0.0' && isIP(bind) === 0) {
    throw new Error(`dsh-collab: bind must be 127.0.0.1, 0.0.0.0, or an IP address, got "${cfg.bind}"`)
  }

  const allowPeers = Number(cfg.allowPeers)
  if (!Number.isInteger(allowPeers) || allowPeers < 1 || allowPeers > 64) {
    throw new Error(`dsh-collab: allowPeers must be 1..64, got ${cfg.allowPeers}`)
  }

  const ttlMinutes = Number(cfg.ttlMinutes)
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 480) {
    throw new Error(`dsh-collab: ttlMinutes must be 1..480, got ${cfg.ttlMinutes}`)
  }

  const maxFileBytes = Number(cfg.maxFileBytes)
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1024 || maxFileBytes > 4 * 1024 * 1024) {
    throw new Error(`dsh-collab: maxFileBytes must be 1024..4194304, got ${cfg.maxFileBytes}`)
  }

  const denyGlobs = Array.isArray(cfg.denyGlobs) ? cfg.denyGlobs.map((glob) => String(glob)) : DEFAULTS.denyGlobs
  if (denyGlobs.some((glob) => glob.length === 0)) {
    throw new Error('dsh-collab: denyGlobs entries must be non-empty globs')
  }

  const auditMaxBytes = Number(cfg.auditMaxBytes)
  if (!Number.isInteger(auditMaxBytes) || auditMaxBytes < 4096) {
    throw new Error(`dsh-collab: auditMaxBytes must be an integer >= 4096, got ${cfg.auditMaxBytes}`)
  }

  const hubPort = Number(cfg.hubPort)
  if (!Number.isInteger(hubPort) || hubPort < 0 || hubPort > 65535) {
    throw new Error(`dsh-collab: hubPort must be an integer 0..65535, got ${cfg.hubPort}`)
  }

  const hubBind = String(cfg.hubBind ?? '').trim()
  if (hubBind !== '0.0.0.0' && hubBind !== 'localhost' && hubBind !== '::1' && isIP(hubBind) === 0) {
    throw new Error(`dsh-collab: hubBind must be an IP address or 0.0.0.0, got "${cfg.hubBind}"`)
  }

  const hubMaxPeers = Number(cfg.hubMaxPeers)
  if (!Number.isInteger(hubMaxPeers) || hubMaxPeers < 1 || hubMaxPeers > 256) {
    throw new Error(`dsh-collab: hubMaxPeers must be 1..256, got ${cfg.hubMaxPeers}`)
  }

  const hubRoomTtlMinutes = Number(cfg.hubRoomTtlMinutes)
  if (!Number.isFinite(hubRoomTtlMinutes) || hubRoomTtlMinutes < 1 || hubRoomTtlMinutes > 1440) {
    throw new Error(`dsh-collab: hubRoomTtlMinutes must be 1..1440, got ${cfg.hubRoomTtlMinutes}`)
  }

  const directOrigins = Array.isArray(cfg.directOrigins)
    ? cfg.directOrigins
        .map((origin) => String(origin).trim().replace(/\/+$/, ''))
        .filter((origin) => /^https?:\/\/[^\s]+$/.test(origin))
        .slice(0, 8)
    : []

  return {
    ...cfg,
    port,
    bind,
    allowPeers,
    ttlMinutes,
    maxFileBytes,
    denyGlobs,
    auditMaxBytes,
    redact: cfg.redact !== false,
    files: cfg.files !== false,
    streaming: cfg.streaming !== false,
    allowComments: cfg.allowComments !== false,
    audit: cfg.audit !== false,
    advertiseHost: String(cfg.advertiseHost ?? '').trim(),
    hostName: String(cfg.hostName ?? '').trim(),
    root: String(cfg.root ?? '').trim(),
    auditDir: String(cfg.auditDir ?? '').trim(),
    hubUrl,
    hubToken: String(cfg.hubToken ?? '').trim(),
    directOrigins,
    hubBind,
    hubPort,
    hubMaxPeers,
    hubRoomTtlMinutes,
    hubTlsCert: String(cfg.hubTlsCert ?? '').trim(),
    hubTlsKey: String(cfg.hubTlsKey ?? '').trim(),
    adminToken: String(cfg.adminToken ?? '').trim(),
  }
}
