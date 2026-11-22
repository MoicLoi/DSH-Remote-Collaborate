// dsh-collab — host face.
//
// One plugin, one job: mint a link for the current session, serve a read-only
// structured view of that session plus a bounded workspace browser, and close the
// room when the link expires or the host says so.
import { networkInterfaces } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { resolveConfig, DEFAULTS } from './config.js'
import { RoomManager } from './room.js'
import { createGateway, DEFAULT_DENY } from './gateway.js'
import { createNodeFsPort, createCtxFsPort } from './fs-port.js'
import { createAudit, defaultAuditDir } from './audit.js'
import { renderRoomJson, renderRoomMarkdown } from './export.js'
import { readStreamEvent } from './stream.js'
import { startHub } from './hub.js'
import { connectHub } from './relay.js'
import { startCollabServer } from './server.js'
import { registerPanelRoute } from './panel.js'
import { findSession, primeRoom } from './feed.js'

export const name = 'dsh-collab'
export const inject = ['sessions']

export const Config = Schema.object({
  role: Schema.string().default('host'),
  mode: Schema.string().default('lan'),
  bind: Schema.string().default(DEFAULTS.bind),
  port: Schema.number().min(0).max(65535).default(DEFAULTS.port),
  advertiseHost: Schema.string().default(''),
  hostName: Schema.string().default(''),
  root: Schema.string().default(''),
  allowPeers: Schema.number().min(1).max(64).default(DEFAULTS.allowPeers),
  ttlMinutes: Schema.number().min(1).max(480).default(DEFAULTS.ttlMinutes),
  maxFileBytes: Schema.number().min(1024).max(4194304).default(DEFAULTS.maxFileBytes),
  redact: Schema.boolean().default(true),
  files: Schema.boolean().default(true),
  streaming: Schema.boolean().default(true),
  allowComments: Schema.boolean().default(true),
  audit: Schema.boolean().default(true),
  auditDir: Schema.string().default(''),
  auditMaxBytes: Schema.number().min(4096).default(DEFAULTS.auditMaxBytes),
  adminToken: Schema.string().default(''),
  denyGlobs: Schema.array(Schema.string()).default(DEFAULT_DENY),
  hubUrl: Schema.string().default(''),
  hubToken: Schema.string().default(''),
  directOrigins: Schema.array(Schema.string()).default([]),
  hubBind: Schema.string().default(DEFAULTS.hubBind),
  hubPort: Schema.number().min(0).max(65535).default(DEFAULTS.hubPort),
  hubTlsCert: Schema.string().default(''),
  hubTlsKey: Schema.string().default(''),
  hubMaxPeers: Schema.number().min(1).max(256).default(DEFAULTS.hubMaxPeers),
  hubRoomTtlMinutes: Schema.number().min(1).max(1440).default(DEFAULTS.hubRoomTtlMinutes),
})

/** First non-internal IPv4, used to build a link when bound to 0.0.0.0. */
export function pickLanAddress(interfaces = networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

function agentOf(ctx, exec) {
  if (exec?.agent) return exec.agent
  try {
    return ctx.get?.('agents')?.currentInitiator?.() ?? undefined
  } catch {
    return undefined
  }
}

/** @param {any} agent @returns {{sessionId: string, cwd: string, title: string}|undefined} */
function sessionInfoOf(agent) {
  const session = agent?.session
  if (!session?.id) return undefined
  const cwd = session.header?.cwd
  if (!cwd) return undefined
  return { sessionId: String(session.id), cwd: String(cwd), title: String(session.title ?? '') }
}

export function apply(ctx, rawConfig = {}) {
  // Loud failure on bad config: the loader reports a FAILED fiber instead of a
  // half-working share server.
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger?.('dsh-collab') ?? console

  // --- hub role: rendezvous + relay only, no workspace, no session ----------
  if (config.role === 'hub') {
    ctx.effect(() => {
      let hub = null
      let disposed = false
      startHub({
        bind: config.hubBind,
        port: config.hubPort,
        token: config.hubToken,
        maxPeers: config.hubMaxPeers,
        roomTtlMs: config.hubRoomTtlMinutes * 60 * 1000,
        tls:
          config.hubTlsCert && config.hubTlsKey
            ? { cert: config.hubTlsCert, key: config.hubTlsKey }
            : undefined,
        logger,
      })
        .then((handle) => {
          if (disposed) {
            void handle.close()
            return
          }
          hub = handle
          logger.info('dsh-collab: hub listening on %s (token %s)', handle.origin, config.hubToken ? 'required' : 'OPEN')
          if (!config.hubToken && config.hubBind !== '127.0.0.1') {
            logger.warn('dsh-collab: hub is exposed without hubToken — set one before opening it to a network')
          }
        })
        .catch((error) => logger.error('dsh-collab: hub failed to start — %s', error?.message ?? error))
      return async () => {
        disposed = true
        if (hub) await hub.close()
        hub = null
      }
    }, 'dsh-collab: hub')
    return
  }

  let server = null
  const hostName = config.hostName || 'dsh-host'
  // The host a peer must dial: loopback stays loopback, 0.0.0.0 advertises the LAN
  // address, and `advertiseHost` covers VPN/overlay setups. In hub mode the share
  // link points at the hub; the LAN edge is still advertised for direct attempts.
  const linkHost = () => {
    if (config.mode === 'hub') return config.hubUrl
    if (config.advertiseHost) return config.advertiseHost
    if (config.bind === '0.0.0.0') return pickLanAddress()
    if (config.bind === 'localhost' || config.bind === '::1') return '127.0.0.1'
    return config.bind
  }

  const lanOrigin = () => {
    const port = server?.port ?? config.port
    const host = config.advertiseHost || (config.bind === '0.0.0.0' ? pickLanAddress() : config.bind)
    return `http://${host === 'localhost' || host === '::1' ? '127.0.0.1' : host}:${port}`
  }

  const directOrigins = () => {
    const set = new Set([lanOrigin(), ...config.directOrigins])
    if (config.hubUrl) set.delete(config.hubUrl)
    return [...set].filter(Boolean).slice(0, 8)
  }

  const rooms = new RoomManager({
    ttlMs: config.ttlMinutes * 60 * 1000,
    maxPeers: config.allowPeers,
    mode: config.mode === 'hub' ? 'hub' : 'lan',
    baseUrl: () => (config.mode === 'hub' ? config.hubUrl : lanOrigin()),
    allowComments: config.allowComments,
  })

  /** @type {Map<string, any>} room code → hub link */
  const hubLinks = new Map()

  const gateways = new Map()
  // Optional service: `ctx.get` is the only safe lookup for a non-injected service.
  const fsSeam = ctx.get?.('fs')
  function gatewayFor(room) {
    if (!config.files) return null
    const root = config.root || room?.cwd
    if (!root) return null
    let gateway = gateways.get(root)
    if (!gateway) {
      const nodePort = createNodeFsPort(root)
      const port = fsSeam ? createCtxFsPort({ fs: fsSeam, fallback: nodePort, logger }) : nodePort
      gateway = createGateway({
        root,
        deny: config.denyGlobs,
        maxBytes: config.maxFileBytes,
        redact: config.redact,
        logger,
        port,
      })
      gateways.set(root, gateway)
    }
    return gateway
  }

  function roomFor(agent) {
    const info = sessionInfoOf(agent)
    if (!info) throw new Error('当前没有可分享的会话（需要绑定到一条已知会话）')
    const session = findSession(ctx, info.sessionId)
    const room = rooms.ensure({ sessionId: info.sessionId, cwd: info.cwd, title: info.title })
    if (session) primeRoom({ room, session })
    return room
  }

  // One audit log per room, attached on creation and disposed with the room; in hub
  // mode the same hook keeps the room registered with the central machine.
  rooms.on('created', (room) => {
    if (config.audit) {
      room.audit = createAudit({
        dir: config.auditDir || undefined,
        room: room.code,
        maxBytes: config.auditMaxBytes,
        logger,
      })
    }
    attachHubFor(room)
  })

  rooms.on('closed', (room) => {
    const link = hubLinks.get(room.code)
    if (link) {
      hubLinks.delete(room.code)
      void link.stop()
    }
  })

  function attachHubFor(room) {
    if (config.mode !== 'hub' || !config.hubUrl || !server) return
    if (hubLinks.has(room.code)) return
    const link = connectHub({
      origin: config.hubUrl,
      token: config.hubToken,
      room: room.code,
      name: hostName,
      direct: directOrigins(),
      logger,
      onPeer: (peer) => server.acceptPeer(peer, { ip: 'relay', via: 'relay', room: room.code }),
    })
    hubLinks.set(room.code, link)
  }

  // Token-level live text. Transient by design: settlement still arrives through
  // `session/event`, so a missing/renamed frame only costs the typing effect.
  if (config.streaming) {
    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const sessionId = payload?.agent?.session?.id
        const room = sessionId ? rooms.forSession(sessionId) : undefined
        if (!room || !payload?.agent || payload.agent.session.id !== room.sessionId) return
        const event = readStreamEvent(payload)
        if (event.kind === 'delta') room.queueStreamText(event.text)
        else if (event.kind === 'start') room.beginAssistantStream({ turn: event.turn, step: event.step })
        else if (event.kind === 'end') room.finishAssistantStream({})
      } catch (error) {
        logger.warn?.('dsh-collab: stream frame ignored (%s)', error?.message ?? error)
      }
    })
  }

  // --- lifecycle -----------------------------------------------------------

  /** Shared posture for the admin console and the in-GUI panel. */
  const hostInfo = () => ({
    mode: config.mode,
    hub: config.hubUrl
      ? { url: config.hubUrl, registered: [...hubLinks.values()].some((link) => link.client.registered) }
      : null,
    direct: directOrigins(),
    files: config.files ? (fsSeam ? 'ctx.fs' : 'node:fs') : 'disabled',
    streaming: config.streaming,
  })

  // Same-origin route for the settings panel (loopback-only; rides ctx.inject).
  registerPanelRoute({
    ctx,
    rooms,
    info: hostInfo,
    consoleOrigin: () => (server ? `http://127.0.0.1:${server.port}` : `http://127.0.0.1:${config.port}`),
    logger,
  })

  ctx.effect(() => {
    let disposed = false
    startCollabServer({
      rooms,
      gatewayFor,
      bind: config.bind,
      port: config.port,
      hostName,
      logger,
      admin: {
        token: config.adminToken,
        info: hostInfo,
      },
    })
      .then((handle) => {
        if (disposed) {
          void handle.close()
          return
        }
        server = handle
        logger.info(
          'dsh-collab: share server on %s (bind %s, %d peers max, mode %s)',
          handle.origin,
          config.bind,
          config.allowPeers,
          config.mode,
        )
        if (config.mode === 'hub') {
          logger.info('dsh-collab: links point at %s, direct candidates: %s', config.hubUrl, directOrigins().join(', '))
          for (const room of rooms.rooms.values()) attachHubFor(room)
        }
        if (config.bind !== '0.0.0.0' && config.bind !== '127.0.0.1') {
          logger.warn('dsh-collab: bound to %s — make sure that is intentional', config.bind)
        }
      })
      .catch((error) => {
        logger.error('dsh-collab: cannot start share server on %s:%d — %s', config.bind, config.port, error?.message ?? error)
      })

    return async () => {
      disposed = true
      for (const link of hubLinks.values()) void link.stop()
      hubLinks.clear()
      rooms.dispose()
      gateways.clear()
      if (server) await server.close()
      server = null
    }
  }, 'dsh-collab: share server')

  // --- session fan-in ------------------------------------------------------

  ctx.on('session/event', (session, event) => {
    try {
      const room = rooms.forSession(session?.id)
      if (room) room.applyEvent(event)
    } catch (error) {
      logger.warn?.('dsh-collab: projection failed %s', error?.message ?? error)
    }
  })

  ctx.on('session/disposed', (session) => {
    try {
      const id = session?.id ?? session?.session?.id
      if (id) rooms.closeSession(String(id), 'session ended')
    } catch {
      /* ignore */
    }
  })

  // --- human command -------------------------------------------------------

  ctx.get?.('commands')?.register?.({
    name: 'collab',
    description: '分享当前会话的只读协作链接（/collab 创建、/collab link 取链接、/collab peers 在线、/collab stop 关闭）',
    handler: async ({ agent, rawInput }) => {
      const action = String(rawInput ?? '').trim().toLowerCase()
      try {
        const info = sessionInfoOf(agent)
        if (!info) return { kind: 'error', text: '当前没有可分享的会话。' }
        const existing = rooms.forSession(info.sessionId)

        if (action === 'stop' || action === 'close') {
          if (!existing) return { kind: 'success', text: '当前会话没有进行中的协作。' }
          rooms.close(existing.code, 'closed by host')
          return { kind: 'success', text: `已关闭协作房间 ${existing.code}，所有协作者已断开。` }
        }
        if (action === 'peers') {
          if (!existing) return { kind: 'success', text: '当前会话没有进行中的协作。' }
          const peers = existing.presence().peers
          const text = peers.length
            ? `房间 ${existing.code}：${peers.length} 位协作者\n` +
              peers.map((peer) => `· ${peer.name}${peer.kind === 'tui' ? '（TUI）' : ''}`).join('\n')
            : `房间 ${existing.code} 暂时没有协作者。`
          return { kind: 'success', text }
        }
        if (!server) {
          return { kind: 'error', text: '协作服务器未就绪，请查看 dsh-collab 日志（端口被占用？）。' }
        }
        const room = existing ?? roomFor(agent)
        const minutes = Math.max(1, Math.round((room.expiresAt - Date.now()) / 60000))
        const hint =
          config.mode === 'hub'
            ? `经中心机 ${config.hubUrl} 中转；同网段/同 VPN 会先尝试直连 ${lanOrigin()}`
            : `局域网外的同事需要能访问 ${lanOrigin()}`
        return {
          kind: 'success',
          text:
            `${existing ? '协作链接' : '已创建协作房间'}\n` +
            `${room.inviteLink}\n` +
            `有效期约 ${minutes} 分钟 · 只读（会话视图 + 工作区文件）· 上限 ${room.maxPeers} 人\n` +
            hint,
        }
      } catch (error) {
        return { kind: 'error', text: `创建协作失败：${error?.message ?? error}` }
      }
    },
  })

  // --- agent tools ---------------------------------------------------------

  const tools = [
    {
      name: 'collab_share',
      description:
        'Create (or reuse) a read-only collaboration link for the current session and return it. ' +
        'The link streams a structured view of this session (turns, messages, tool calls) and lets the ' +
        'invitee browse the workspace read-only. Use when the user wants to show their work to someone else.',
      parameters: {
        note: { type: 'string', required: false, description: 'Optional note shown to the invitee; not stored.' },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) =>
          value?.link
            ? [{ type: 'text', text: `${value.link}\n只读 · ${value.maxPeers} 人上限 · 约 ${value.minutes} 分钟后过期` }]
            : [{ type: 'text', text: value?.error ?? 'collab_share failed' }],
      },
      async execute(args, exec) {
        try {
          const agent = agentOf(ctx, exec)
          const info = sessionInfoOf(agent)
          if (!info) return { ok: false, error: '当前没有可分享的会话' }
          if (!server) return { ok: false, error: '协作服务器未就绪（端口被占用？请查看日志）' }
          const room = roomFor(agent)
          return {
            ok: true,
            room: room.code,
            link: room.inviteLink,
            expiresAt: room.expiresAt,
            minutes: Math.max(1, Math.round((room.expiresAt - Date.now()) / 60000)),
            maxPeers: room.maxPeers,
            peers: room.peerCount,
            scopes: ['view', 'files'],
            note: String(args?.note ?? '').slice(0, 200),
          }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      },
    },
    {
      name: 'collab_status',
      description: 'Report active collaboration rooms: room code, peer count, expiry, and the session each is bound to.',
      parameters: {},
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const roomsList = value?.rooms ?? []
          if (roomsList.length === 0) return [{ type: 'text', text: '当前没有进行中的协作房间。' }]
          return [
            {
              type: 'text',
              text: roomsList
                .map((room) => `${room.code} · ${room.peers} 位协作者 · ${room.sessionId} · ${new Date(room.expiresAt).toLocaleTimeString()}`)
                .join('\n'),
            },
          ]
        },
      },
      async execute() {
        const roomsList = rooms.list().map((room) => ({
          ...room,
          audit: rooms.get(room.code)?.audit?.summary() ?? null,
          relay: hubLinks.get(room.code)?.client?.registered ?? null,
          comments: rooms.get(room.code)?.comments.length ?? 0,
          lastCommentSeq: rooms.get(room.code)?.commentSeq ?? 0,
        }))
        return {
          ok: true,
          rooms: roomsList,
          listening: Boolean(server),
          mode: config.mode,
          hub: config.hubUrl ? { url: config.hubUrl, registered: [...hubLinks.values()].some((link) => link.client.registered) } : null,
          direct: directOrigins(),
          files: config.files ? (fsSeam ? 'ctx.fs' : 'node:fs') : 'disabled',
          streaming: config.streaming,
          allowComments: config.allowComments,
        }
      },
    },
    {
      name: 'collab_inbox',
      description:
        'Read collaborator messages from a share room. Pull-based on purpose: the tool result is recorded in this session, so anything the model sees is also in the log. Pass the previous cursor to get only new messages.',
      parameters: {
        room: { type: 'string', description: 'Room code (optional; omit to scan every live room).' },
        since: { type: 'number', description: 'Return messages with seq greater than this cursor (default 0).' },
        limit: { type: 'number', description: 'Max messages per room (default 20, max 50).' },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const rows = []
          for (const room of value?.rooms ?? []) {
            for (const comment of room.comments ?? []) {
              rows.push(`${room.code} · ${comment.from}${comment.nodeId ? ` @${comment.nodeId}` : ''}: ${comment.text}`)
            }
          }
          if (!rows.length) return [{ type: 'text', text: '没有新的协作者留言。' }]
          return [{ type: 'text', text: rows.join('\n') }]
        },
      },
      async execute(args) {
        const since = Number(args?.since ?? 0)
        const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 20)))
        const wanted = args?.room ? [String(args.room).toUpperCase()] : rooms.list().map((room) => room.code)
        const inbox = []
        let cursor = since
        for (const code of wanted) {
          const room = rooms.get(code)
          if (!room) continue
          const fresh = room.commentsSince(since).slice(-limit)
          cursor = Math.max(cursor, room.commentSeq)
          inbox.push({
            code: room.code,
            sessionId: room.sessionId,
            title: room.title,
            peers: room.peerCount,
            comments: fresh.map((comment) => ({
              seq: comment.seq,
              at: comment.at,
              from: comment.from,
              kind: comment.kind,
              nodeId: comment.nodeId,
              text: comment.text,
            })),
          })
        }
        return { ok: true, since, cursor, rooms: inbox }
      },
    },
    {
      name: 'collab_reply',
      description:
        'Answer collaborators inside a share room. The message is broadcast to every connected peer and kept in the room snapshot.',
      parameters: {
        room: { type: 'string', description: 'Room code.', required: true },
        text: { type: 'string', description: 'Message text (max 2000 characters).', required: true },
        nodeId: { type: 'string', description: 'Optional view-node id this message is anchored to.' },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value?.ok ? `已发送到房间 ${value.code}。` : `发送失败：${value?.error ?? 'unknown'}` }],
      },
      async execute(args) {
        const code = String(args?.room ?? '').toUpperCase()
        const room = rooms.get(code)
        if (!room) return { ok: false, error: 'room not found' }
        try {
          const comment = room.addComment({ from: 'host', text: args?.text, nodeId: args?.nodeId })
          return { ok: true, code, seq: comment.seq }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      },
    },
    {
      name: 'collab_export',
      description:
        'Export a room snapshot (structured timeline plus collaborator comments) as Markdown or JSON. Writes to $DSH_HOME/dsh-collab/exports by default and returns the absolute path.',
      parameters: {
        room: { type: 'string', description: 'Room code (optional when exactly one room is live).' },
        format: { type: 'string', description: 'markdown (default) or json.' },
        path: { type: 'string', description: 'Absolute output path (optional).' },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) =>
          value?.ok
            ? [{ type: 'text', text: `已导出 ${value.nodes} 个节点、${value.comments} 条留言 → ${value.path}（${value.bytes}B）` }]
            : [{ type: 'text', text: `导出失败：${value?.error ?? 'unknown'}` }],
      },
      async execute(args) {
        const codes = rooms.list().map((room) => room.code)
        const code = args?.room ? String(args.room).toUpperCase() : codes.length === 1 ? codes[0] : ''
        if (!code) return { ok: false, error: codes.length ? 'multiple rooms: pass room' : 'no live room' }
        const room = rooms.get(code)
        if (!room) return { ok: false, error: 'room not found' }
        const format = String(args?.format ?? 'markdown').toLowerCase() === 'json' ? 'json' : 'markdown'
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const target =
          args?.path ?? join(auditDirFor(config), 'exports', `${code}-${stamp}.${format === 'json' ? 'json' : 'md'}`)
        try {
          const rendered = format === 'json' ? renderRoomJson(room) : renderRoomMarkdown(room)
          const body = format === 'json' ? rendered.json : rendered.markdown
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, body, 'utf8')
          return {
            ok: true,
            code,
            format,
            path: target,
            bytes: Buffer.byteLength(body, 'utf8'),
            nodes: rendered.nodes,
            comments: rendered.comments,
          }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      },
    },
  ]

  const toolRegistry = ctx.get?.('tools')
  for (const tool of tools) toolRegistry?.register?.(tool)
}

export { resolveConfig } from './config.js'
export { createProjector } from './projector.js'
export { createGateway } from './gateway.js'
export { RoomManager } from './room.js'
export { parseLink, createInvite } from './invite.js'
