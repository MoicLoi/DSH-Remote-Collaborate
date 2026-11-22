#!/usr/bin/env node
// dsh-collab TUI client — terminal face of the same structured protocol the browser uses.
//
//   npx dsh-collab join "http://192.168.1.20:8848/c/7K3M9Q2X#k=..."
//
// Zero dependencies: readline + ANSI + the global WebSocket (Node 22+).
import { createInterface } from 'node:readline'
import process from 'node:process'
import { newNonce, open, proof, seal, verifyProof, deriveKey } from '../src/crypto.js'
import { parseLink } from '../src/invite.js'

const PROTOCOL = 1
const dim = (text) => `\u001b[2m${text}\u001b[0m`
const bold = (text) => `\u001b[1m${text}\u001b[0m`
const green = (text) => `\u001b[32m${text}\u001b[0m`
const yellow = (text) => `\u001b[33m${text}\u001b[0m`
const red = (text) => `\u001b[31m${text}\u001b[0m`
const cyan = (text) => `\u001b[36m${text}\u001b[0m`

const width = () => Math.max(40, Math.min(process.stdout.columns || 100, 140))

function wrap(text, indent = '') {
  const limit = width() - indent.length
  const out = []
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph.length <= limit) {
      out.push(indent + paragraph)
      continue
    }
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (line.length + word.length > limit) {
        out.push(indent + line.trimEnd())
        line = word.trimStart()
      } else {
        line += word
      }
    }
    if (line) out.push(indent + line.trimEnd())
  }
  return out.join('\n')
}

function clock(at) {
  const date = at ? new Date(at) : new Date()
  return date.toTimeString().slice(0, 8)
}

function usage() {
  console.log(`用法：
  dsh-collab join "<链接>"     加入一个协作房间
  dsh-collab "<链接>"          同上

示例：
  dsh-collab join "http://192.168.1.20:8848/c/7K3M9Q2X#k=..."`)
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
  usage()
  process.exit(argv.length === 0 ? 1 : 0)
}
const linkArg = argv[0] === 'join' ? argv[1] : argv[0]
if (!linkArg) {
  usage()
  process.exit(1)
}

let target
try {
  target = parseLink(linkArg)
} catch (error) {
  console.error(red(`链接无法解析：${error.message}`))
  process.exit(1)
}

const room = target.room
const key = deriveKey(target.secret, room)

let ws = null
let outSeq = 0
let stopped = false
let peerNonce = ''
let joined = false
let pending = new Map()
let callId = 0
const seen = new Set()
const typing = new Set()
let lastPseq = 0
let selfId = ''

const ACTIVITY_LABEL = {
  idle: '空闲',
  typing: '输入中',
  reading: '查看文件',
  browsing: '浏览目录',
  searching: '搜索中',
}

function reportActivity(kind, detail = '') {
  if (!joined) return
  sendLogical({ v: PROTOCOL, t: 'activity', kind, detail: String(detail).slice(0, 160) })
}

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' })
let rlClosed = false
rl.on('close', () => {
  rlClosed = true
})

function say(line = '') {
  process.stdout.write(`\r\u001b[2K${line}\n`)
  if (!rlClosed) {
    try {
      rl.prompt(true)
    } catch {
      rlClosed = true
    }
  }
}

function header() {
  console.log(bold(`dsh-collab`) + dim(`  room ${room}  ${target.origin}`))
  console.log(dim('只读 · 结构化视图（无视频流）· /help 查看命令'))
}

function sendLogical(frame) {
  if (!ws || ws.readyState !== 1 || !joined) return
  outSeq += 1
  const envelope = seal(key, room, outSeq, frame)
  ws.send(JSON.stringify({ v: PROTOCOL, t: 'enc', ...envelope }))
}

function call(method, params = {}) {
  callId += 1
  const id = `t${callId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('请求超时'))
    }, 15000)
    pending.set(id, { resolve, reject, timer })
    sendLogical({ v: PROTOCOL, t: 'call', id, method, params })
  })
}

function renderNode(node, prefix = '') {
  const at = clock(node.at)
  switch (node.kind) {
    case 'turn':
      say(dim(`\n── ${node.text || `turn ${node.turn ?? ''}`} `.padEnd(8, '─')))
      break
    case 'notice':
      say(dim(`${at} · ${node.source ? `[${node.source}] ` : ''}${node.text ?? ''}`))
      break
    case 'user':
      say(`${dim(`${at} you?`)} ${bold('用户')}\n${wrap(node.text, '   ')}`)
      break
    case 'assistant':
      say(`${dim(at)} ${green('助手')}${node.interrupted ? red(' (中断)') : ''}\n${wrap(node.text, '   ')}`)
      break
    case 'tool': {
      const tool = node.tool || {}
      const mark = tool.status === 'error' ? red('✗') : tool.status === 'ok' ? green('✓') : yellow('…')
      say(`${dim(at)} ${cyan(`⚙ ${tool.name || 'tool'}`)} ${mark} ${dim(tool.argSummary || '')}`)
      if (tool.resultSummary) say(dim(`   ${tool.resultSummary}`))
      break
    }
    default:
      break
  }
}

function applyPatchOps(ops) {
  for (const op of ops || []) {
    if (op.op === 'append') {
      if (seen.has(op.node.id)) continue
      seen.add(op.node.id)
      renderNode(op.node)
    } else if (op.op === 'update') {
      const fields = op.fields || {}
      if (fields.tool) {
        const tool = fields.tool
        const mark = tool.status === 'error' ? red('✗') : tool.status === 'ok' ? green('✓') : yellow('…')
        say(dim(`   ${cyan(tool.name || 'tool')} ${mark} ${tool.resultSummary || ''}`))
      } else if (fields.text && fields.streaming === false) {
        typing.delete(op.id)
        say(`${dim(clock())} ${green('助手')}\n${wrap(fields.text, '   ')}`)
      }
    } else if (op.op === 'text') {
      if (!typing.has(op.id)) {
        typing.add(op.id)
        say(dim('… 正在输出'))
      }
    }
  }
}

function handleLogical(frame) {
  switch (frame.t) {
    case 'ready':
      joined = true
      selfId = String(frame.selfId ?? '')
      console.log(bold(`已连接：${frame.name}`) + dim(`  ${frame.cwd ?? ''}`))
      say(dim('握手完成，等待结构化视图…'))
      break
    case 'comment':
      if (frame.comment) {
        const comment = frame.comment
        const anchor = comment.nodeId ? dim(` @${comment.nodeId}`) : ''
        say(cyan(`${comment.from}：`) + comment.text + anchor)
      }
      break
    case 'snapshot':
      if (frame.pseq) lastPseq = frame.pseq
      if (frame.truncated) say(dim('（更早的历史未发送）'))
      for (const node of frame.nodes || []) {
        if (seen.has(node.id)) continue
        seen.add(node.id)
        renderNode(node)
      }
      say(dim('—— 以上为历史，以下为实时 ——'))
      break
    case 'resume':
      for (const patch of frame.patches || []) {
        if (patch.pseq <= lastPseq) continue
        applyPatchOps(patch.ops)
        lastPseq = patch.pseq
      }
      if (Number.isFinite(frame.to)) lastPseq = Math.max(lastPseq, frame.to)
      say(dim(`已续传 ${(frame.patches || []).length} 个补丁`))
      break
    case 'patch':
      if (Number.isSafeInteger(frame.pseq) && frame.pseq > 0) {
        if (frame.pseq <= lastPseq) break
        lastPseq = frame.pseq
      }
      applyPatchOps(frame.ops)
      break
    case 'presence': {
      const peers = (frame.peers || []).filter((peer) => peer.id !== selfId)
      const rendered = peers.map((peer) => {
        const activity = peer.activity ?? { kind: 'idle', detail: '' }
        const label = ACTIVITY_LABEL[activity.kind] ?? activity.kind
        const detail = activity.detail ? ` ${activity.detail}` : ''
        return activity.kind === 'idle' ? peer.name : `${peer.name}（${label}${detail}）`
      })
      say(dim(`在线：主机 + ${rendered.join('、') || '你'}`))
      break
    }
    case 'files':
      say(dim(`工作区：${(frame.root?.entries || []).length} 项顶层条目（/files 查看）`))
      break
    case 'result': {
      const entry = pending.get(frame.id)
      if (!entry) break
      pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.ok) entry.resolve(frame.data)
      else entry.reject(Object.assign(new Error(frame.error?.message || '请求失败'), { code: frame.error?.code }))
      break
    }
    case 'ping':
      sendLogical({ v: PROTOCOL, t: 'pong', n: frame.n ?? 0 })
      break
    case 'bye':
      stopped = true
      say(red(`连接结束：${frame.reason || ''}`))
      process.exit(0)
      break
    default:
      break
  }
}

async function candidateUrls() {
  const base = target.origin.replace(/^http/, 'ws')
  const urls = [`${base}/ws?room=${encodeURIComponent(room)}`]
  try {
    const response = await fetch(`${target.origin}/hub/room/${encodeURIComponent(room)}`)
    if (response.ok) {
      const meta = await response.json()
      for (const origin of meta.direct || []) {
        urls.push(`${String(origin).replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(room)}`)
      }
      urls.push(`${base}/hub/peer?room=${encodeURIComponent(room)}`)
    }
  } catch {
    /* not a hub origin: direct only */
  }
  return [...new Set(urls)]
}

function attempt(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const relay = url.includes('/hub/peer')
    let localNonce = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      reject(new Error('handshake timeout'))
    }, timeoutMs)

    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      reject(error)
    }

    const sendFrame = (frame) => {
      const text = JSON.stringify(frame)
      socket.send(relay ? JSON.stringify({ v: PROTOCOL, t: 'relay', payload: text }) : text)
    }

    socket.onopen = () => {
      sendFrame({ v: PROTOCOL, t: 'hello', room, client: { kind: 'tui', name: 'tui', caps: ['files'] } })
    }
    socket.onmessage = async (event) => {
      let frame
      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }
      if (relay) {
        if (frame.t === 'attached') return
        if (frame.t === 'close') {
          stopped = true
          say(red(`连接结束：${frame.reason || ''}`))
          fail(new Error('relay closed'))
          return
        }
        if (frame.t !== 'relay') return
        try {
          frame = JSON.parse(frame.payload)
        } catch {
          return
        }
      }
      if (frame.t === 'challenge') {
        localNonce = newNonce()
        sendFrame({
          v: PROTOCOL,
          t: 'join',
          room,
          proof: proof(key, [frame.nonce, room, localNonce]),
          peerNonce: localNonce,
          resumeFrom: lastPseq,
          kind: 'tui',
          name: process.env.DSH_COLLAB_NAME || 'tui',
        })
        return
      }
      if (frame.t === 'enc') {
        let logical
        try {
          logical = open(key, room, frame)
        } catch {
          say(red('帧校验失败（密钥不匹配或被篡改）'))
          process.exit(1)
        }
        if (logical.t === 'ready' && !settled) {
          if (!verifyProof(key, [localNonce, room, 'host'], logical.hostProof)) {
            say(red('主机校验失败，已中止'))
            process.exit(1)
          }
          settled = true
          clearTimeout(timer)
          peerNonce = localNonce
          ws = socket
          socket.onclose = onSocketClosed
          resolve(logical)
          handleLogical(logical)
          return
        }
        handleLogical(logical)
        return
      }
      if (frame.t === 'close') {
        stopped = true
        say(red(`连接结束：${frame.reason || ''}`))
        process.exit(0)
      }
    }
    socket.onclose = (event) => {
      if (!settled) fail(new Error(`closed ${event.code}`))
    }
    socket.onerror = () => {}
  })
}

function onSocketClosed(event) {
  if (stopped) return
  if (event.code === 4401) {
    say(red('链接无效或已被主机刷新'))
    process.exit(1)
  }
  if (event.code === 4404) {
    say(red('房间不存在或已过期'))
    process.exit(1)
  }
  say(yellow(`连接断开（${event.code}），1.5 秒后重连…`))
  setTimeout(connect, 1500)
}

let connecting = false
async function connect() {
  if (connecting || stopped) return
  connecting = true
  try {
    for (const url of await candidateUrls()) {
      if (stopped) return
      const relay = url.includes('/hub/peer')
      try {
        const ready = await attempt(url, relay ? 6000 : 1800)
        if (ready?.via === 'relay') say(dim('（经中心机中转）'))
        return
      } catch {
        /* next candidate */
      }
    }
    say(yellow('所有地址都连不上，1.5 秒后重试…'))
    setTimeout(connect, 1500)
  } finally {
    connecting = false
  }
}

async function handleCommand(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/)
  const arg = rest.join(' ')
  switch (cmd) {
    case '/help':
    case '/?':
      say(
        [
          '/files [path]     列出工作区目录',
          '/cat <path>       读取文件（截断到 256KB）',
          '/search <query>   在工作区搜索',
          '/peers            在线协作者',
          '/status           连接与房间状态',
          '/leave            离开',
        ].join('\n'),
      )
      break
    case '/files': {
      reportActivity('browsing', arg || '.')
      try {
        const data = await call('files.list', { path: arg || '' })
        const rows = data.entries.map((entry) =>
          entry.kind === 'directory' ? cyan(`${entry.name}/`) : `${entry.name} ${dim(entry.size != null ? `${entry.size}B` : '')}`,
        )
        say(dim(`${data.path}:`) + '\n' + wrap(rows.join('  '), '  '))
      } catch (error) {
        say(red(`${error.code || 'ERROR'}: ${error.message}`))
      }
      break
    }
    case '/cat': {
      if (!arg) {
        say(yellow('用法：/cat <path>'))
        break
      }
      reportActivity('reading', arg)
      try {
        const file = await call('files.read', { path: arg })
        if (file.binary) say(dim(`${file.path} 是二进制文件（${file.bytes}B），不传输内容`))
        else {
          say(dim(`${file.path} · ${file.bytes}B${file.truncated ? ' · 已截断' : ''}`))
          say(file.text)
        }
      } catch (error) {
        say(red(`${error.code || 'ERROR'}: ${error.message}`))
      }
      break
    }
    case '/say': {
      if (!arg.trim()) {
        say(yellow('用法：/say <消息>'))
        break
      }
      sendLogical({ v: PROTOCOL, t: 'comment', text: arg.trim().slice(0, 2000) })
      break
    }
    case '/search': {
      if (arg.trim().length < 2) {
        say(yellow('搜索至少需要 2 个字符'))
        break
      }
      reportActivity('searching', arg.trim())
      try {
        const data = await call('files.search', { query: arg.trim(), maxResults: 30 })
        if (!data.matches.length) say(dim('没有匹配'))
        else
          say(
            wrap(
              data.matches.map((match) => `${match.path}:${match.line}  ${dim(match.preview)}`).join('\n'),
              '  ',
            ),
          )
      } catch (error) {
        say(red(`${error.code || 'ERROR'}: ${error.message}`))
      }
      break
    }
    case '/peers':
      say(dim('在线信息每小时… 请以主机 /collab peers 为准'))
      break
    case '/status':
      say(
        `${joined ? green('已连接') : yellow('连接中')} · room ${room} · ${target.origin}\n` +
          dim(`序号 out=${outSeq} · 消息 ${seen.size} 条`),
      )
      break
    case '/leave':
    case '/quit':
    case '/exit':
      stopped = true
      sendLogical({ v: PROTOCOL, t: 'bye' })
      setTimeout(() => process.exit(0), 100)
      break
    default:
      say(dim(`未知命令 ${cmd}，/help 查看帮助`))
      break
  }
}

rl.on('line', (line) => {
  const text = line.trim()
  if (!text) {
    if (!rlClosed) rl.prompt()
    return
  }
  if (text.startsWith('/')) void handleCommand(text)
  else say(dim('只读会话：消息不会发送给主机（/help）'))
})

rl.on('SIGINT', () => {
  stopped = true
  rl.close()
  process.exit(0)
})

header()
connect()
rl.prompt()
