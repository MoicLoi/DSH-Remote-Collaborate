#!/usr/bin/env node
// Standalone hub: the central machine for cross-network collaboration.
//
//   npx dsh-collab-hub --port 8787 --token "$DSH_COLLAB_HUB_TOKEN"
//
// Put TLS in front of it (Caddy/Nginx) or pass --cert/--key. The hub never sees
// plaintext frames or workspace data — only room codes, peer ids, and byte sizes.
import process from 'node:process'
import { startHub } from '../src/hub.js'

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
function has(name) {
  return argv.includes(`--${name}`)
}

if (has('help') || has('h')) {
  console.log(`用法：
  dsh-collab-hub [--bind 0.0.0.0] [--port 8787] [--token <secret>] [--cert <pem> --key <pem>]

环境变量：
  DSH_COLLAB_HUB_TOKEN   与 --token 等价

主机侧配置（cordis.patch.yml）：
  mode: hub
  hubUrl: https://hub.example.com
  hubToken: <同一个 secret>
  bind: 0.0.0.0            # 可选：让同网段协作者优先直连主机
`)
  process.exit(0)
}

const bind = flag('bind', '127.0.0.1')
const port = Number(flag('port', 8787))
const token = flag('token', process.env.DSH_COLLAB_HUB_TOKEN ?? '')
const cert = flag('cert', '')
const key = flag('key', '')
const logger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
}

if (!token && bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1') {
  console.warn('⚠  未设置 --token：任何知道房间码的人都能占用房间。生产环境请务必设置。')
}

const hub = await startHub({
  bind,
  port,
  token,
  tls: cert && key ? { cert, key } : undefined,
  logger,
})

console.log('')
console.log('  dsh-collab hub is running')
console.log('')
console.log(`  监听      ${hub.origin}`)
console.log(`  健康检查  ${hub.origin}/healthz`)
console.log(`  鉴权      ${token ? '需要 hubToken' : '未设置（仅限可信网络）'}`)
console.log('')
console.log('  主机侧：mode: hub + hubUrl 指向这个地址，hubToken 用同一个 secret。')
console.log('  反代示例：Caddy 一行 `reverse_proxy 127.0.0.1:8787` 自动带 TLS 与 WebSocket。')
console.log('')

const shutdown = async () => {
  console.log('\n关闭中…')
  await hub.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
