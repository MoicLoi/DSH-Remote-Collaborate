#!/usr/bin/env node
// Local demo: no DSH required. Starts the real share server against a throwaway
// workspace and plays a scripted session, so you can open the link in a browser and
// watch the structured view + file browser end to end.
//
//   node scripts/demo.mjs [--port 8848] [--bind 127.0.0.1]
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { RoomManager } from '../src/room.js'
import { createGateway } from '../src/gateway.js'
import { startCollabServer } from '../src/server.js'
import { startHub } from '../src/hub.js'
import { connectHub } from '../src/relay.js'
import { pickLanAddress } from '../src/index.js'

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
function has(name) {
  return argv.includes(`--${name}`)
}

const port = Number(flag('port', 0))
const bind = flag('bind', '127.0.0.1')
const streamMs = Number(flag('stream-ms', 45))
const delayMs = Number(flag('delay', 0))
const hubMode = has('hub')
const noDirect = has('no-direct')
const workspace = join(process.cwd(), '.demo-workspace')

const FILES = {
  'README.md': `# demo workspace

这是 dsh-collab 的演示工作区。协作者只能读，不能写。

- \`src/auth/login.ts\` 登录实现
- \`src/auth/session.ts\` 会话实现
- \`.env.local\` 被拒绝清单挡住（试试点它）
`,
  'src/auth/login.ts': `import { createSession } from './session.js'

export async function login(email: string, password: string) {
  const user = await findUser(email)
  if (!user || !(await verify(user, password))) {
    throw new Error('invalid credentials')
  }
  const session = await createSession(user.id)
  return { token: session.token, userId: user.id }
}
`,
  'src/auth/session.ts': `export async function createSession(userId: string) {
  return { token: Math.random().toString(36).slice(2), userId }
}
`,
  'src/server.ts': `import { login } from './auth/login.js'

export async function handleLogin(req: Request) {
  const { email, password } = await req.json()
  return login(email, password)
}
`,
  '.env.local': 'OPENAI_API_KEY=sk-demo-not-a-real-key-000000000000\nDB_PASSWORD=hunter2\n',
  'notes/plan.md': `# 计划

1. 把 login 拆成 challenge + verify
2. 加锁定
3. 补测试
`,
}

const SCRIPT = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '把登录流程改成两步验证，并补上锁定策略。' }] } } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  {
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '先看一下现在的实现，再决定拆分点。' }],
      },
      usage: { inputTokens: 1200, outputTokens: 40 },
    },
  },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"src/auth/login.ts"}' } },
  {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { toolCallId: 'call-1', content: [{ type: 'text', text: '40 行，单文件 login()，包含密码校验与会话创建。' }] },
    },
  },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-2', name: 'grep', arguments: '{"pattern":"verify(", "path":"src"}' } },
  {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { toolCallId: 'call-2', content: [{ type: 'text', text: 'src/auth/login.ts:5' }] } },
  },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'step/start', data: { turn: 1, step: 2 } },
  {
    type: 'tool/call',
    data: { turn: 1, step: 2, callId: 'call-3', name: 'edit', arguments: '{"path":"src/auth/login.ts","op":"replace"}' },
  },
  {
    type: 'tool/result',
    data: { turn: 1, step: 2, message: { toolCallId: 'call-3', content: [{ type: 'text', text: '已拆分为 challenge() + verify()，新增失败计数。' }] } },
  },
  {
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '拆好了：\n\n1. `challenge(email)` 只查用户与锁定状态\n2. `verify(challenge, password)` 校验并创建会话\n\n锁定策略：连续 5 次失败后锁 15 分钟，计数落在 `login_attempts` 表。' }],
      },
      usage: { inputTokens: 2400, outputTokens: 180 },
    },
  },
  { type: 'step/end', data: { turn: 1, step: 2 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } },
]

async function prepareWorkspace() {
  await rm(workspace, { recursive: true, force: true })
  for (const [path, content] of Object.entries(FILES)) {
    const target = join(workspace, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

async function main() {
  await prepareWorkspace()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const hub = hubMode ? await startHub({ bind: '127.0.0.1', port: 0, token: 'demo', logger: { info: () => {}, warn: () => {}, error: console.error } }) : null
  const rooms = new RoomManager({
    ttlMs: 60 * 60 * 1000,
    maxPeers: 8,
    baseUrl: () => (hub ? hub.origin : `http://${bind === '0.0.0.0' ? pickLanAddress() : bind}:${server.port}`),
  })

  const gateway = createGateway({ root: workspace, maxBytes: 262_144 })
  let link = null
  const server = await startCollabServer({
    rooms,
    gatewayFor: () => gateway,
    bind,
    port,
    hostName: 'demo-host',
    logger: { info: () => {}, warn: () => {}, error: console.error },
    admin: {
      token: '',
      info: () => ({
        mode: hub ? 'hub' : 'lan',
        hub: hub ? { url: hub.origin, registered: link?.client?.registered ?? false } : null,
        direct: hub ? (noDirect ? [] : [server.origin]) : [server.origin],
        files: 'node:fs',
        streaming: true,
      }),
    },
  })

  const room = rooms.ensure({ sessionId: 'demo-session', cwd: workspace, title: 'dsh-collab demo' })

  if (hub) {
    link = connectHub({
      origin: hub.origin,
      token: 'demo',
      room: room.code,
      name: 'demo-host',
      direct: noDirect ? [] : [server.origin],
      logger: { info: () => {}, warn: () => {}, error: console.error },
      onPeer: (peer) => server.acceptPeer(peer, { ip: 'relay', via: 'relay', room: room.code }),
    })
    for (let i = 0; i < 100 && !link.client.registered; i += 1) await sleep(20)
  }

  console.log('')
  console.log('  dsh-collab demo is running')
  console.log('')
  console.log(`  分享链接  ${room.inviteLink}`)
  console.log(`  健康检查  ${server.origin}/healthz`)
  if (hub) {
    console.log(`  中心机    ${hub.origin}（${noDirect ? '不提供直连，走中继' : `直连候选 ${server.origin}`}）`)
  }
  console.log('')
  console.log('  浏览器打开上面的链接即可；Ctrl+C 结束。')
  console.log('')

  let seq = 0
  let stopped = false
  const play = async () => {
    for (const step of SCRIPT) {
      if (stopped) return
      seq += 1
      if (step.type === 'assistant/message') {
        // Simulate token streaming: deltas first, then the authoritative settlement.
        const full = step.data?.message?.content?.[0]?.text ?? ''
        room.beginAssistantStream({ turn: step.data.turn, step: step.data.step })
        for (let i = 0; i < full.length; i += 6) {
          if (stopped) return
          room.queueStreamText(full.slice(i, i + 6))
          await sleep(streamMs)
        }
        await sleep(160)
      }
      room.applyEvent({ seq, type: step.type, data: step.data })
      await sleep(step.type === 'tool/call' ? 1200 : 900)
    }
    await new Promise((resolve) => setTimeout(resolve, 2500))
    if (!stopped) {
      seq += 1
      room.applyEvent({
        seq,
        type: 'notice',
        data: {},
      })
      room.broadcast({
        v: 1,
        t: 'patch',
        ops: [{ op: 'append', node: { id: `demo-${seq}`, kind: 'notice', at: Date.now(), text: '演示结束（脚本已播完）' } }],
      })
    }
  }
  void (async () => {
    if (delayMs > 0) {
      console.log(`  ${Math.round(delayMs / 1000)} 秒后开始播放（方便先打开页面）`)
      await sleep(delayMs)
    }
    await play()
  })()

  const shutdown = async () => {
    stopped = true
    if (link) await link.stop()
    await server.close()
    rooms.dispose()
    if (hub) await hub.close()
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
