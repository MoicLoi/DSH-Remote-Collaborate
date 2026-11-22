# dsh-collab（超轻协作）—— 设计方案 v0.1

> 目标：给 DSH 加一个**极端轻量**的"链接化协作"插件。主机（Host）持有工作区与会话，协作方（Peer）只凭一条链接加入，通过**结构化视图模型**（JSON 帧）而非视频流/截屏，在浏览器或终端里"看"主机的 agent 工作过程，并能浏览主机工作区文件。

---

## 1. 目标与非目标

### 1.1 目标

| 编号 | 目标 | 可验收的判据 |
|---|---|---|
| G1 | 链接即入会 | 打开链接 → 3s 内看到实时会话时间线；无需账号、无需装客户端（Web 端） |
| G2 | 局域网直连 | 同网段无需任何外部服务；不依赖 GUI 端口绑定策略 |
| G3 | 中心机中转 + 可直连 | 跨网段时由"中心机"撮合；能直连则直连，失败自动降级为中继 |
| G4 | 结构化而非视频 | 传输的是语义节点（turn/消息/工具调用/文件树），像素级内容一律不传 |
| G5 | 工作区浏览 | 目录树、文件内容（分页/截断）、搜索；严格限制在工作区根内 |
| G6 | 终端协作 | `npx dsh-collab join <link>` 在 TUI 中同样可看会话、翻文件 |
| G7 | 主机可控 | 一键建链/撤链、TTL、人数上限、权限分层、可审计 |

### 1.2 非目标（v1 明确不做）

- 屏幕/摄像头/音频流、远程桌面、视频会议。
- 协作者写文件、执行命令、审批工具调用、改动主机配置。
- 多人协同编辑同一文件（CRDT）——与"观看 agent 工作"是两条产品线。
- 账号体系、组织/团队、持久化历史归档（房间关闭即焚）。
- 手机 App / 微信小程序（Web 端响应式足够）。

---

## 2. 角色与拓扑

三种角色由同一插件的 `role` 配置切换，**同一套代码、三个进程姿态**：

```
                      ┌──────────────────────────────┐
                      │ Hub（中心机）                │
   Host ──WSS(出站)──▶ │  · 房间注册/寻址             │
   （工作区持有者）     │  · 帧中继（不可解密）        │
        ▲              │  · 无业务状态，可水平扩容    │
        │ 直连(优先)    └──────────────┬───────────────┘
        │                             │ WSS
   Peer ◀┘（局域网/同 VPN 时直连）      ▼
                                Peer（浏览器 / TUI）
```

| 角色 | 运行位置 | 职责 |
|---|---|---|
| **Host** | 主机上的 DSH 进程内（插件一） | 房间与邀请管理、会话投影、文件网关、直连服务端、Hub 出站客户端 |
| **Hub** | 一台有公网入口的机器 | 房间码分配、Host/Peer 撮合、加密帧中继；不认识 DSH 语义 |
| **Peer** | 协作者的浏览器或终端 | 反序列化视图模型、渲染、发起文件请求、心跳 |

### 2.1 三种连通模式

| 模式 | 链路 | 何时用 | 代价 |
|---|---|---|---|
| `lan` | Peer → Host 直连 `ws://192.168.x.x:<port>` | 同一局域网 | 主机需放行端口（Windows 防火墙一次授权） |
| `hub` | Peer → Hub ← Host（双向 WS，中继） | 跨网段、无公网 IP | 中心机带宽 = 全部上行流量 |
| `hub+direct` | Hub 只做撮合，随后 Peer 直连 Host 的候选地址 | 同 VPN / 有端口映射 | 需一处可达地址；失败 1.5s 内回落中继 |

> 直连优先、中继兜底，是"中心化 P2P"的工程化表述：中心机负责**发现与授权**，数据平面尽量点对点。

### 2.2 为什么 v1 不做 WebRTC

| 方案 | 结论 | 理由 |
|---|---|---|
| WebRTC DataChannel | 否 | Host 侧在 Node 主进程，没有内建 WebRTC；`werift`/`node-datachannel` 是原生依赖，装包与 Windows 编译成本直接违背"极端轻量" |
| 纯中继 WS | 是（v1） | 零原生依赖，浏览器与 TUI 用同一协议；穿透任何 HTTP 代理与 CDN |
| WS 直连 + 中继兜底 | 是（v1.5） | 局域网/VPN 场景得到真正 P2P，实现成本仅"多试一个地址" |
| WebRTC | 可选 v2 | 仅当需要"浏览器↔浏览器"或大规模媒体时才值得引入 |

---

## 3. 关键设计决策

| 决策 | 选择 | 备选与否决原因 |
|---|---|---|
| 传输载体 | 插件自建 `node:http` 小服务器 + `ws` | 复用 `ctx.webServer` 需把 GUI 绑到 `0.0.0.0`（全局暴露 GUI），且分享页会被 SPA fallback 吞掉；`dsh-pocket` 已验证独立小服务器的可行性 |
| 视图来源 | 订阅 `session/event` 增量 + 会话日志回放快照 | 直接转发 GUI 的 `/api` 流会耦合 GUI 版本，且把整个 API 面暴露给协作者 |
| 序列化 | 自带版本化 JSON 帧（`v:1`）+ 补丁操作 | protobuf 需代码生成，收益在 >100KB/s 场景才显现 |
| 加密 | 端到端 AES-256-GCM，密钥由链接秘密 HKDF 派生 | 中继明文 = 中心机可读全部内容，信任成本过高 |
| 认证 | 挑战-应答（HMAC），链接秘密永不上线 | 直接发 secret 会在 LAN 明文 HTTP 上被抓包 |
| 文件访问 | 经 `ctx.fs` + 根目录/拒绝清单双重约束 | 直接 `node:fs` 会绕过 DSH 的文件策略与沙箱接缝 |
| 协作者 UI | 独立静态页（原生 JS，无框架、无 CDN） | 接入 DSH client 模块体系要把协作者变成"第二个 DSH GUI"，重且危险 |
| 主机 UI | 先命令 + 工具，GUI 面板放 M3 | 命令/工具零构建成本，先把链路跑通 |

---

## 4. 链接与邀请模型

### 4.1 链接格式

```
LAN :  http://192.168.250.97:8848/c/<room>#k=<secret>
HUB :  https://hub.example.com/c/<room>#k=<secret>
TUI :  dsh-collab join "<上面任意一条>"
```

- `<room>`：8 字符 Crockford Base32（≈40 bit）——**只用于寻址**，可公开。
- `<secret>`：32 字节 base64url（256 bit）——放在 URL **fragment**，浏览器不会把它发给服务器、不进 Referer、不进 Hub 日志。
- 房间码与秘密分离，使得"猜不到房间"和"拿不到密钥"是两道独立防线。

### 4.2 握手（秘密不上线）

```
Peer → Host : { t:'hello', v:1, room, client:{kind,name,caps} }
Host → Peer : { t:'challenge', nonce: <32B>, hubSalt }
Peer → Host : { t:'join', proof: HMAC-SHA256(key, nonce|room|peerNonce), peerNonce }
Host → Peer : { t:'ready', keyId, expiresAt, scopes }        # 之后全部帧为密文
```

- `key = HKDF-SHA256(ikm=secret, salt=room, info="dsh-collab/v1")`
- 双向证明：Host 在 `ready` 中附带 `HMAC(key, peerNonce|room)`，Peer 校验后才能确认真主机（防中继侧冒充）。
- 失败计数：同 IP 连续 5 次 → 封禁 10 分钟；封禁表内存态，重启即清。

### 4.3 生命周期

| 事件 | 行为 |
|---|---|
| 建链 | 生成 room+secret，TTL 默认 30 分钟（空闲）/ 8 小时（硬上限） |
| 使用 | 一次性链接可选（`maxUses:1`）；默认 8 人 |
| 刷新链接 | 轮换 secret，已连 Peer 2s 内全部断开（旧链接立即失效） |
| 撤链 | 房间销毁、连接关闭、密钥丢弃 |
| 主机退出 | 所有房间销毁（内存态，不落盘密钥；仅 `rooms.json` 记录元数据用于审计） |

---

## 5. 结构化视图模型与传输协议

### 5.1 视图模型（ViewNode）

送出去的是**语义节点**，不是 DOM、不是像素：

```ts
type NodeKind = 'turn' | 'user' | 'assistant' | 'tool' | 'notice' | 'error'

interface ViewNode {
  id: string                 // 稳定 id，供补丁定位
  kind: NodeKind
  seq: number                // 会话事件序号（幂等/去重）
  at: number
  turn?: number
  step?: number
  text?: string              // user/assistant/notice 的正文
  streaming?: boolean        // 仍在增量输出
  tool?: {
    name: string
    callId: string
    argSummary: string       // ≤200 字符，已脱敏
    status: 'running' | 'ok' | 'error'
    resultSummary?: string   // ≤400 字符
    diff?: { added: number; removed: number; files: number }
  }
}
```

投影规则（`projector.ts`，纯函数）：

| 会话事件 | 视图节点 |
|---|---|
| `turn/start` / `turn/end` | `turn` 分隔条 |
| `user/message`（`source` 区分人与注入） | `user` / `notice` |
| `assistant/message` + 流式增量 | `assistant`（先 `streaming:true`，结束补 `streaming:false`） |
| `tool/call` + `tool/result` | `tool`（running → ok/error） |
| `step/*`、`request/*` | 不单独成节点（折叠进 turn 元数据） |
| 未知事件类型 | 丢弃并计数（前向兼容，绝不因未知类型报错） |

**关键约束（DSH 红线）**：投影只读不写；协作者产生的任何内容**不进入会话日志**，因此不产生"模型可见但未记录"的状态。v2 若允许协作者留言给 agent，必须新增 `SessionEventMap` 事件（例如 `collab/message`），不得旁路注入。

### 5.2 帧协议

```ts
type Frame =
  | { v:1, t:'hello'; room:string; client:{kind:'web'|'tui'; name:string; caps:string[]} }
  | { v:1, t:'challenge'; nonce:string }
  | { v:1, t:'join'; proof:string; peerNonce:string }
  | { v:1, t:'ready'; room:string; keyId:string; expiresAt:number; scopes:string[]; hostProof:string; seq:number }
  | { v:1, t:'snapshot'; seq:number; nodes:ViewNode[]; truncated:boolean; files?:FileTree }
  | { v:1, t:'patch'; seq:number; ops:PatchOp[] }
  | { v:1, t:'presence'; peers:{name:string; kind:string; since:number}[] }
  | { v:1, t:'result'; id:string; ok:true; data:unknown } | { v:1, t:'result'; id:string; ok:false; error:CollabError }
  | { v:1, t:'ping'; n:number } | { v:1, t:'pong'; n:number }
  | { v:1, t:'bye'; code:string; reason:string }

type PatchOp =
  | { op:'append'; node:ViewNode }
  | { op:'text'; id:string; delta:string }          // 追加正文
  | { op:'update'; id:string; fields:Partial<ViewNode> }
  | { op:'remove'; id:string }
```

加密后线上形态：`{ v:1, t:'enc', iv:<12B b64>, ct:<b64> }`，`AAD = "v1|" + room + "|" + seq`（绑定顺序，防重放/重排）。

### 5.3 快照 / 补丁 / 断线续传

1. 连接建立 → `snapshot`（滚动的最近 N 个节点，预算 256 KiB；超预算则只发最近 50 节点 + `truncated:true` + 提示"查看完整历史请用主机侧导出"）。
2. 之后每条事件 → 合并后的 `patch`（**80ms 节流合并**，避免 token 级帧洪泛）。
3. Peer 记 `seq` 游标；断线重连发 `resume{lastSeq}`（实现时作为 `hello` 的扩展字段）。Host 从环形缓冲（最近 512 帧 / 5 分钟）重放；不足则重新 `snapshot`。
4. `seq` 单调、跨帧连续；Peer 发现跳号 → 主动要求重快照。

### 5.4 流量与限流预算

| 项 | 预算 |
|---|---|
| 单帧上限 | 64 KiB（Peer→Host 16 KiB） |
| 空闲心跳 | 20s 一次（≈100 B），60s 无响应断开 |
| 文本增量 | 80ms 合并；单节点 >64 KiB 截断并标记 |
| 文件读 | 单次 ≤256 KiB，单 Peer 并发 1 个请求 |
| 请求限流 | 5 次/s/Peer，突发 10；超限返回 `E_RATE` |
| 常驻内存 | 每 Peer <1 MB；房间 <5 MB（含环形缓冲） |

> 典型观看场景：agent 每 10 秒产生 2 KB 结构化文本 → 约 **0.2 KB/s**；对比 720p 屏幕流 1–3 Mbps，差 4 个数量级。这就是"避免视频流"的实际收益。

---

## 6. 工作区浏览网关

### 6.1 方法

| 方法 | 请求 | 响应 |
|---|---|---|
| `files.list` | `{ path }` | `{ path, entries:[{name,kind,size,mtime}], truncated }` |
| `files.read` | `{ path, offset?, limit? }` | `{ path, text, bytes, truncated, binary, version:{mtime,size} }` |
| `files.stat` | `{ path }` | `{ kind, size, mtime }` |
| `files.search` | `{ query, glob?, maxResults? }` | `{ matches:[{path,line,column,preview}] }` |

### 6.2 边界（fail-closed）

1. **根**：房间绑定会话的 `SessionHeader.cwd`；所有路径 `resolve` 后必须 `ctx.fs.contains(root, target)`。
2. **拒绝清单**（默认，可配置）：`.git/**`、`node_modules/**`、`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.ssh/**`、`*.pfx`、`*.kdbx`。
3. **大小**：单文件 >256 KiB 只返回首段 + `truncated:true`；>2 MiB 或含 NUL 字节 → 仅元数据（`binary:true`）。
4. **符号链接**：解析后越界即拒绝（不跟随出根）。
5. **脱敏**：返回前对内容做模式扫描（`sk-…`、`ghp_…`、`AKIA…`、`-----BEGIN * PRIVATE KEY-----`），命中替换为 `[redacted:kind]` 并记一条本地审计。
6. **审计**：每次文件请求记录 `{peer, method, path, bytes, at}` 到 `$DSH_HOME/dsh-collab/audit-<room>.jsonl`（滚动、上限 2 MB），主机可查。

### 6.3 目录树的首屏

`snapshot.files` 只带**两层**、每层 ≤200 项、跳过拒绝清单；Peer 展开时按需 `files.list`。避免"打开房间先传 5 万个文件节点"。

---

## 7. 插件工程结构

### 7.1 目录

```
dsh-collab/
├─ package.json          # dsh.bundle.patch / bin / exports
├─ cordis.patch.yml      # 插入一行 loader entry
├─ src/
│  ├─ index.ts           # 插件入口：name / inject / Config / apply（角色分派）
│  ├─ config.ts          # Schemastery Schema
│  ├─ service.ts         # CollabService（Service Definition，供其他插件消费）
│  ├─ room.ts            # RoomManager：房间、邀请、TTL、人数、封禁
│  ├─ invite.ts          # 链接生成/解析、secret 轮换、哈希比对
│  ├─ crypto.ts          # HKDF / AES-GCM / HMAC 挑战应答
│  ├─ projector.ts       # session/event → ViewNode（纯函数）
│  ├─ protocol.ts        # 帧类型 + 编解码 + 校验（zod 手写或 schemastery）
│  ├─ transport/
│  │  ├─ lan-server.ts   # node:http + ws 服务端
│  │  ├─ hub-client.ts   # 出站 WS 客户端（Host 角色）
│  │  └─ hub.ts          # 中继核心（Hub 角色，可被 bin 复用）
│  ├─ gateway.ts         # 工作区浏览（经 ctx.fs）
│  ├─ session-feed.ts    # session/event 订阅 + 日志回放 + 节流合并
│  └─ commands.ts        # /collab 命令 + collab_share/collab_status 工具
├─ web/                  # 分享页（构建产物，原生 JS，无 CDN）
│  ├─ index.html
│  ├─ app.js
│  └─ style.css
├─ bin/
│  ├─ collab.mjs         # TUI 客户端（零依赖）
│  └─ hub.mjs            # 独立中心机（npx dsh-collab-hub）
└─ lib/                  # 构建产物（tsdown/tsc 输出，随包发布）
```

### 7.2 插件契约要点

```ts
export const name = 'dsh-collab'
export const inject = ['sessions', 'fs', 'commands', 'tools']   // 按需增减

export const Config: Schema<Config> = Schema.object({
  role: Schema.union(['host', 'hub', 'peer']).default('host'),
  bind: Schema.string().default('127.0.0.1'),      // LAN 需显式改 0.0.0.0
  port: Schema.natural().default(8848),
  root: Schema.string(),                            // 缺省=会话 cwd
  allowPeers: Schema.natural().default(8),
  ttlMinutes: Schema.natural().default(30),
  maxTextBytes: Schema.natural().default(262144),
  denyGlobs: Schema.array(Schema.string()).default([...]),
  hub: Schema.object({ url: Schema.string(), token: Schema.string() }),
  e2e: Schema.boolean().default(true),
})
```

- 所有注册走 `ctx.effect(() => disposer)`：HTTP server、WS、`session/event` 订阅、命令、工具。
- 卸载 = 关服务器 + 断所有 Peer + 丢密钥；没有手动 `removeListener`。
- 不硬编码可调项（端口、TTL、上限全部来自 Config，可在 `cordis.patch.yml` 改）。
- 事件声明合并：`interface Events { 'collab/peer-joined' ... 'collab/room-closed' }`，供审计插件消费。

### 7.3 主机侧暴露面（DSH 内部）

| 形态 | 名称 | 用途 |
|---|---|---|
| 命令 | `/collab start` / `stop` / `link` / `peers` | 人在会话里开房、取链接 |
| 工具 | `collab_share` | agent 生成链接并写进回答（"把这条链接发给同事"） |
| 工具 | `collab_status` | 在线人数、流量、审计摘要 |
| 服务 | `ctx.collab` | 供其他插件（如 IM 桥）调用 `createRoom()` |

### 7.4 打包与安装

```json
{
  "name": "dsh-collab",
  "type": "module",
  "main": "lib/index.js",
  "bin": { "dsh-collab": "bin/collab.mjs", "dsh-collab-hub": "bin/hub.mjs" },
  "exports": { ".": "./lib/index.js" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "dependencies": { "ws": "^8.18.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- 安装：`dsh plugin add dsh-collab`（桌面端走插件管理面板等效）。
- 零构建可选：v0 用纯 ESM `src/*.js` + JSDoc 类型，免去 tsdown，包体 <100 KB，`pnpm pack` 即发。
- TUI 端**无需安装**：`npx dsh-collab join <link>`；无 node 环境时用 Web 页（响应式，手机可用）。

---

## 8. 两端体验

### 8.1 分享页（Peer，浏览器）

- 单页三段式：**时间线**（主体）、**工作区抽屉**（文件树 + 预览）、**顶部状态**（主机名、在线人数、连接质量、TTL 倒计时）。
- 首屏 <30 KB（HTML+CSS+JS 全内联打包），无框架、无字体外链，弱网 2G 可开。
- 移动端：时间线单列，文件树改为全屏抽屉。
- 断线：顶部条"重连中（第 n 次）"，指数退避；超过 TTL 显示"链接已失效，请向主机索取新链接"。
- 无障碍：语义化列表 + `aria-live="polite"` 增量播报。

### 8.2 TUI（Peer，终端）

```
$ npx dsh-collab join "https://hub/c/7K3M9Q2X#k=..."
┌ dsh-collab ─ host: mac-studio · room 7K3M9Q2X · peers 2 · 28m left ─┐
│ 12:01 turn 4                                                       │
│ 12:01 you? no — user: 把登录流程重构成两段式                        │
│ 12:02 assistant: 先看一下现在的实现…                                │
│ 12:02 ⚙ read src/auth/login.ts  ✓ 1.2 KB                           │
│ 12:03 ⚙ edit src/auth/login.ts  ~ +42 −18                          │
│ ...                                                                │
├─ /files  /cat <path>  /search <q>  /follow  /say  /leave ──────────┤
```

- 零依赖：`node:readline` + ANSI 光标控制；宽 >120 列时右侧显示文件树。
- 只重绘变化行（脏区刷新），CPU 占用低；SSH 断线自动重连。
- 命令集与 Web 端能力一一对应（同一帧协议，不同渲染器）。

---

## 9. 安全模型

| 威胁 | 控制 |
|---|---|
| 链接被转发给无关的人 | 一次性链接、TTL、人数上限、主机可见 Peer 列表并可踢人、一键撤链 |
| 房间码被枚举 | 40 bit 房间码 + 256 bit secret；同 IP 失败 5 次封禁；Hub 侧按 IP 限速 |
| 中心机偷看内容 | 端到端加密，Hub 只见房间码、密文长度、在线数 |
| 局域网抓包 | 挑战-应答（secret 不上线）+ 全帧加密；`lan` 模式可选仅允许私网地址 |
| 路径穿越 / 越界读 | `ctx.fs.contains` 强校验 + 拒绝清单 + 符号链接解析后复查 |
| 敏感内容外泄 | 拒绝清单 + 模式脱敏 + 审计日志 + 主机侧"暂停文件浏览"开关 |
| 协作者反打主机 | 无写接口、无命令执行、无任意 HTTP 代理；仅 4 个只读方法 + 心跳 |
| 帧注入/重放 | AES-GCM + AAD 绑 seq/room；未知帧类型直接丢弃并计数 |
| 拒绝服务 | 帧上限、限流、连接数上限、单房间背压（慢 Peer 丢帧不阻塞广播） |

**信任边界一句话**：中心机只被信任"能正确路由"，不被信任"看不到内容"；主机只被信任"愿意分享当前房间的结构化视图"，不被信任"会暴露工作区之外的东西"。

---

## 10. 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 骨架 + LAN 只读**（约 3–4 天） | 插件骨架、Room/Invite、LAN server、projector（turn/message/tool）、snapshot/patch、分享页时间线、`files.list/read`、TUI join | 两台同网段机器：点链接 3s 内看到实时时间线；能看到 agent 的工具调用；能浏览 3 层目录并打开 ≤256 KB 文本；根目录外文件请求返回 `E_SCOPE` |
| **M1 加固**（2–3 天） | E2E、挑战-应答、脱敏、审计、断线续传、限流、撤链/踢人 | 撤链后 2s 内全部 Peer 断开；断网 10s 重连只补差异；`.env` 读取被拒；抓包只看到密文 |
| **M2 Hub + 穿透**（3–4 天） | Hub 中继、房间注册、`hub+direct` 直连尝试、TLS/反代文档、`dsh-collab-hub` bin | 跨网段经 Hub 可用；同 VPN 时自动直连（日志标明 `direct`）；Hub 侧抓包无法还原内容 |
| **M3 主机体验**（2–3 天） | `/collab` 命令、`collab_share` 工具、可选 GUI 面板（client 模块）、i18n、设置项 | agent 能在回答里直接贴出可用链接；GUI 面板显示在线 Peer 与 TTL |
| **M4 协作增强**（按需） | Peer 留言（房间级，不进会话）、节点批注、导出 Markdown 快照、可选"留言进 agent"（需新增 `SessionEventMap` 事件） | 留言不污染会话日志；开启"留言进 agent"后能在会话日志中看到 `collab/message` 事件 |

**M0 具体任务清单**

1. `dsh-plugin-dev new dsh-collab` 起脚手架 → 改 `package.json` / `cordis.patch.yml`。
2. `crypto.ts`：HKDF + AES-GCM 封装 + 挑战应答（含单测向量）。
3. `invite.ts`：链接生成/解析、哈希、TTL 计算。
4. `room.ts`：内存房间表 + 人数/TTL/封禁。
5. `projector.ts`：`session/event` → `ViewNode`（含 `assistant` 流式合并、tool 配对）。
6. `session-feed.ts`：订阅 + 80ms 合并 + 环形缓冲 + 快照回放。
7. `lan-server.ts`：HTTP（分享页静态资源 + `/c/:room`）+ WS upgrade（`/ws`）。
8. `gateway.ts`：4 个只读文件方法 + 边界/脱敏。
9. `web/`：时间线 + 文件抽屉（原生 JS，~600 行）。
10. `bin/collab.mjs`：TUI 客户端（join / follow / files / cat / search / leave）。
11. 单测 + 双进程集成测试（Host 起服，Peer 用 ws 客户端跑全流程）。

---

## 11. 风险与未决问题

### 11.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Windows 防火墙弹窗劝退 | 中 | 首次开启 LAN 时给出说明与一键放行指引；默认只开 loopback |
| 会话事件结构随 DSH 版本演进 | 中 | 未知事件丢弃 + 投影单测锁行为；`v` 字段做协议版本协商 |
| 大 repo 目录树撑爆首屏 | 中 | 两层 + 200 项上限 + 拒绝清单默认值 |
| Hub 被当作免费中继滥用 | 中 | 房间创建需 Hub 令牌；单 IP 房间数与并发上限 |
| 中继成本（带宽） | 低 | 结构化帧极小；直连优先；Hub 可只做信令（`hub+direct` 强制模式） |
| 协作者误读"只读"为"可操作" | 低 | 页脚固定标注权限范围；文件区只读水印 |

### 11.2 已经拍板的点

1. **协作者权限**：v1 只读（会话视图 + 文件浏览），无留言、无写入、无注入。
2. **Hub 形态**：v1 只做局域网直连；跨网段交给用户现有隧道（cloudflared 等），Hub 留到 M2。
3. **加密**：默认开启端到端加密，链接秘密不上线。
4. **房间粒度**：一个房间 = 一个会话。
5. **主机 UI**：先命令 + 工具，GUI 面板排到 M3。

---

## 12. M0 落地记录（已实现并验证）

### 12.1 与设计的差异（都是主动收窄，不是欠账没发现）

| 设计 | 实现 | 原因 |
|---|---|---|
| 文件网关走 `ctx.fs` | `node:fs` + 严格根校验（`resolve` 后前缀比对 + `realpath` 复查） | `ctx.fs` 的 `FsDirEntry`/`FsTarget` 形状在当前文档里不完整，闭着眼睛接会引入无法本地验证的运行时风险；根约束与拒绝清单都已生效，行为等价。迁到接缝列入 M1 |
| 逐 token 流式 | 按步实时（`step/start` 显示"thinking"，消息在一步结束出现） | `agent/assistant-stream` 的 `AssistantStreamFrame` 帧类型需要对着真实运行时核对，M0 先用稳定的 `session/event` |
| 每 peer 独立 seq 的环缓冲续传 | 重连即重发快照 | 实现更小、语义更简单；环缓冲放 M1（快照 ≤256 KiB，重连成本已可接受） |
| 目录树首屏两层 | 首屏只有根目录一层，按需展开 | 更省流量；交互上等价 |
| 命令 `/collab` + 工具 | 均实现（`defineTool` 的普通对象形态，不额外引 `dsh-tools`） | 少一个 peer 依赖；`ToolDefinition` 的字段与 `defineTool` 产物一致 |

### 12.2 验证证据

- `node --test "test/*.test.js"` → **51/51 通过**（crypto/invite/projector/stream/gateway/ws/e2e）。
- `node scripts/smoke-plugin.mjs` → 假 `ctx` 上 `apply()`、`/collab` 命令、两个工具、真实 WS 握手、历史回放、文件读取全部通过。
- 浏览器实测（headless Chromium 1100×820）：分享页渲染 turn/用户/助手/工具卡片、在线人数与 TTL 正常、文件抽屉可展开目录并预览文件、控制台零报错。截图见 `shots/share-page.png`。
- 浏览器实测（流式）：抓到 `class="node assistant streaming"` 与 `.caret-live` 光标，文本按增量增长，settle 后替换为权威全文。
- 浏览器实测（Markdown）：settle 后 `` `challenge(email)` `` 渲染为 `<code>`。
- TUI 实测：历史回放 → 实时补丁 → `/files` → `/cat` → `/search` → `/leave` 全通。

### 12.3 M1 落地记录

| 计划项 | 结果 | 说明 |
|---|---|---|
| 文件网关迁 `ctx.fs` | ✅ | 新增 `src/fs-port.js`：`ctxFsPort`（`resolve`/`stat`/`listDir`/`readBytes`）+ `nodeFsPort` 回退；各方法独立 fail-soft，形状不符只退化一次并记警告 |
| 逐 token 流式 | ✅ | `src/stream.js` 容错解析 `agent/assistant-stream`；`projector` 支持 `beginStream/appendStream/endStream`，`text` 增量 80ms 合并，settlement 用权威全文覆盖 |
| 重连续传 | ✅ | 房间保留 512 个补丁 + `pseq` 游标；`resume` 帧只补差异，补不齐回落快照；web/TUI 都按 `pseq` 去重 |
| 每房间审计 | ✅ | `src/audit.js`：JSONL、2 MiB 滚动、fail-soft、不含文件内容；`collab_status` 暴露摘要 |
| 敏感路径"主机确认" | ⏭ M2 | `ctx.approval.request` 的 `ApprovalRequest` 形状在当前文档里不足以安全接线；默认拒绝清单 + 脱敏 + 审计已覆盖主要风险 |

附带收益：web 端轻量 Markdown（围栏代码/行内 code/粗体/http 链接，纯 DOM 构建不走 `innerHTML`）；文件网关顺手修了"不存在路径的 realpath 让 E_NOTFOUND 退化成 E_SCOPE"的边界 bug。

### 12.4 剩下的路线

1. **M3b**：DSH 对话内 GUI 面板（client 模块）与设置卡片——需要先完成"插件装进真实 profile 并加载"这一步，否则等于盲发一段参与 Web boot 的 UI 代码。
2. **M4**：协作者留言（房间级）、节点批注、快照导出；"留言进 agent"需新增 `SessionEventMap` 事件。
3. 敏感路径审批：见 §12.6 的结论。

### 12.5 M2 落地记录
| 计划项 | 结果 | 说明 |
|---|---|---|
| 中心机 | ✅ | 新增 `src/hub.js`：`/hub/host`（带 token 注册、重复房间 4409）、`/hub/peer`（撮合 + 中继）、`/hub/room/<code>`（公开元数据）、`/c/<code>`（hub 侧分享页）、可选 `--cert/--key` TLS |
| 独立部署物 | ✅ | `bin/hub.mjs`（`dsh-collab-hub`），零依赖；也可用 `role: hub` 让一台 DSH 当中心机 |
| 中继 | ✅ | `src/relay.js`：`RelayPeer` 把中继适配成 acceptor 认识的传输；`connectHub` 负责注册、心跳、断线重连（1s→15s 退避，4401/4409 视为致命不重试） |
| 直连优先 | ✅ | 分享页与 TUI 都按 「同源 `/ws` → hub 通告的 `direct` 候选 → `/hub/peer` 中继」顺序尝试（直连 1.8s、中继 6s 超时），状态栏标出「经中心机」 |
| 传输解耦 | ✅ | 抽出 `src/peer-acceptor.js`：握手/鉴权/限流/续传/文件/审计与"字节怎么来"无关，LAN WS 与中继共用同一套逻辑 |
| 敏感路径审批 | ⏭ 仍留 M3 | 同上，等 `ApprovalRequest` 形状稳定 |

工程细节（踩过的坑）：

- 一个 HTTP server 只能有一个 upgrade 所有者：`attachWebSocket` 原来对不匹配路径直接 `destroy`，导致第二个路由永远收不到连接；改为 `attachWebSocketRoutes` 单路由表。
- 升级后的 socket 不受 `server.close()` 管理，hub 必须自己持有并按序 `destroy`，否则关闭会挂住（测试里表现为 after 钩子超时）。
- hub 客户端不能复用浏览器式 `WebSocket` 的 header 注入，注册 token 走 query（TLS 保护、hub 不打印 query）。
- 房间码是 Crockford base32（无 I/L/O/U），测试里随手写的 `DUP…`、`CLOSE…` 会被正确拒绝——这反过来验证了校验。

验证：`test/hub.test.js`（7）+ `test/e2e-hub.test.js`（4）覆盖注册、鉴权、重复房间、未知房间、中继双向、文件调用、补丁、链接轮换；浏览器实测中继态状态栏为「已连接 · 只读 · 经中心机」，并在有直连候选时自动选直连；TUI 同样跑通中继链路。

### 12.6 M3 落地记录

原计划的 M3 是"GUI 面板（client 模块）+ 设置卡片 + i18n"。其中 client 模块**必须**在真实 DSH Web GUI 里加载才能验证（它参与 Web boot、失败会白屏），而宿主加载这一步还没做。于是 M3 改为交付**同样信息量但可验证**的三件事：

| 交付 | 结果 | 说明 |
|---|---|---|
| 主机控制台 | ✅ | `/collab/admin` + `/collab/api/*`：房间、协作者、活动、到期、审计、刷新链接、关闭房间；默认仅 loopback，`adminToken` 开远程；POST 需自定义头（CSRF） |
| 在场状态机 | ✅ | `typing / reading / browsing / searching / idle`；peer 上报 → 房间聚合 → 广播（200ms 节流、尾帧必达）；typing 6s、其它 60s 衰减；`ready.selfId` 让客户端滤掉自己 |
| 双语 | ✅ | `web/i18n.js`（~70 键）：`?lang=zh|en` → localStorage → navigator；两页静态属性 + 动态文案统一走 `t()` |

浏览器实测：控制台显示 `cli-reader（TUI）浏览目录 src`；TUI 发 `/cat` 后控制台变 `查看文件 README.md`；另一个浏览器页面的「在场」条显示同一状态且不含自己；`?lang=en` 下控制台与分享页均为英文；零 page error。

**审批接口的结论**（原本排在 M3）：`ctx.approval.request(req)` 要求"请求方会话处于打开的 turn 内"，而 peer 读文件发生在任何 turn 之外——硬接的结果是**所有读请求都被拒**。因此敏感路径继续用"默认拒绝清单 + 模式脱敏 + 每房间审计"，并把"turn 外的审批通道"作为前置条件记录，而不是勉强接一个必然失败的路由。

**为什么当时没做 client 模块面板**：`dsh.client` 的 bundle 会参与 Web boot，任何形状错误都会让 GUI 起不来；而当时无法在本机加载验证。见 §12.7：宿主加载现已通过，该前置条件解除。

### 12.7 宿主加载验证（M3 收尾）

**方法**：先隔离，再动真实环境。

1. 造独立 `DSH_HOME`（`E:\dsh-collab-hostcheck\.dsh`），`dsh hostcheck --from-default-profile web` 生成干净 profile；
2. 本包以 junction 进该 profile 的 `node_modules`，写一行 insert；
3. `dsh --profile hostcheck --dump-config` 确认行合成 → `dsh --profile hostcheck` 启动；
4. 该 profile 的 `node_modules` 指向真实 desktop profile 的已装依赖，避免联网安装。

**结果**：

| 检查 | 结果 |
|---|---|
| 配置合成 | ✅ dump-config 出现 `dsh-collab` 行 |
| 模块导入 + `apply()` | 首次失败 → 修复后通过 |
| 宿主服务解析 | ✅ `sessions` 注入成功；`fs`/`commands`/`tools` 经 `ctx.get` 解析 |
| 分享服务 | ✅ 8848 `/healthz`、`/collab/admin`、`/collab/api/state` |
| desktop profile 热加载 | ✅ 本会话立即获得 `collab_share` / `collab_status` |
| 真实会话分享 | ✅ 分享页为本会话真实转录；`files: "ctx.fs"`；审计 1 条；关房 200 |

**抓到的 bug（关键）**：Cordis 的 `ctx` 是受限代理，**读取未在 `inject` 声明的服务属性会直接抛错**：

```
dsh-collab (dsh-collab): Error: cannot get property "fs" without inject
```

修复：`inject` 只保留必需的 `sessions`；`fs`/`commands`/`tools`/`agents` 全改为 `ctx.get('…')` 并降级。假 `ctx` 的冒烟脚本同步改成只暴露 `get`，与真实宿主同构——这正是之前冒烟测不出来的原因。

**安装足迹**（已写入本机 desktop profile，可逆）：`profiles/desktop/node_modules/dsh-collab` junction + `cordis.patch.yml` 末尾 insert 行，备份 `cordis.patch.yml.bak-dsh-collab`。临时隔离环境已删除。

**对 M3b 的影响**：client 模块面板的前置条件已满足，可开工；仍建议先在隔离 profile 验证面板 bundle。

### 12.8 M3b 对话内面板

**形态**：设置 → 协作（`settings.section` 列表槽位，`order: 200`）。内容：模式/文件来源/流式徽章、房间码、完整链接 + 一键复制、在线协作者与活动、到期倒计时、「控制台」跳转。

**打包（关键取舍）**：不引打包器。`client/source.js` 是普通 CJS 风格源码，`client/build.mjs` 把它套进 loader 信封：

```js
window.__ModuleLoader__.load({ id: 'dsh-collab', factory: (require) => { … return module.exports } })
```

组件全部用 `React.createElement`（不写 JSX），只 `require('react')`（模块表提供），因此 `dsh.client` 不需要 `inject` 边，也不进 Web boot 的依赖图——失败风险局限于本插件。

**取数（同源）**：分享服务在独立端口，GUI 页面无法直接调（跨域 + 不该把控制台暴露给 peer）。改为在 DSH 自己的 web server 上注册 `/collab-panel/state`：

- `ctx.inject(['webServer'], …)` —— headless/hub 组装没有该服务时自动不注册，不报错；
- 仅 loopback、仅 GET/HEAD、`cache-control: no-store`；
- 面板每 3 秒拉一次。

**验证**（隔离 profile，真实浏览器）：

| 检查 | 结果 |
|---|---|
| client 图包含本包 | ✅ index 的 boot 行命中 `dsh-collab` |
| 设置侧栏出现「协作」 | ✅ 第 5 项，位于 Agent 预设之后 |
| 面板渲染 | ✅ `模式 lan · 文件 node:fs · 流式 开` + 空房间提示 |
| page error | ✅ 0 |
| 路由 | ✅ 200 JSON；非 loopback 403、POST 405（单测） |

**踩坑**：第一次 404——`ctx.get('webServer')` 在 `apply` 时还不存在（服务激活晚于插件）。改用 `ctx.inject(['webServer'], …)` 后正常；这也说明**可选服务一律走 `ctx.inject`/`ctx.get`，不要假设 apply 时已就绪**。

**限制**：已运行的桌面宿主不会重新扫描新声明的 `dsh.client`（client 图在启动时合成），面板需**重启一次**出现；面板只读，不含旋转/关房（那两个动作在控制台）。

### 12.9 M4 留言 / 批注 / 导出

**协议**：新增 peer→host 的 `{t:'comment', text, nodeId?}`，host 归入房间并以 `{t:'comment', comment}` 广播；`snapshot` 携带 `comments`、`commentSeq`、`allowComments`，`ready` 也带 `allowComments`。

**约束**（都在服务端强制，客户端只是体验）：

| 维度 | 值 | 位置 |
|---|---|---|
| 单条长度 | 2000 字，超长截断 | `LIMITS.maxCommentChars` |
| 房间保留 | 最近 200 条 | `LIMITS.maxCommentsPerRoom` |
| 发送速率 | 0.2/s，突发 6 | `LIMITS.commentRate*`（token bucket） |
| 内容清洗 | 去 C0 控制字符、trim、空拒绝 | `Room.addComment` |
| 开关 | `allowComments: false` | Config → RoomManager → Room |

**锚定**：view node 的 `id`（`n1`、`n2`…）本身就是稳定游标，所以"节点批注"直接复用：点击节点 → `nodeId` → 服务端只做长度与字符校验；页面把评论挂到 `[data-id=…]` 上，找不到就落到时间线下方。

**导出**：`src/export.js` 复用 `room.snapshot()`，保证"页面看到的"和"文件写下的"是同一份投影。工具 `collab_export` 与 HTTP `/collab/api/rooms/<code>/export.md|json` 共用这两个渲染器。

**"留言进 agent"的取舍**（本轮最重要的判断）：

| 方案 | 结果 |
|---|---|
| 推送：插件往会话里塞一条消息 | ❌ `sessions` 服务无 append-message API；`agentTeams.sendMessage` 需要 caller 是团队成员 agent，自投递不在契约内 |
| 拉取：`collab_inbox` 工具 | ✅ 工具结果本身就是会话事件，满足"模型可见 ⇔ 已记录"；agent 传 `since` 游标做增量 |

所以没有新增 `SessionEventMap` 事件——那条路只在有 turn 外注入 API 时才成立。用工具拉取不牺牲红线，也不给宿主日志塞私货。

**验证**：91 个测试（+7 unit、+2 e2e）；浏览器实测点节点 → 锚点 chip → 发送 → 评论渲染进 `n1` 且 `comments-count=1`；控制台 `comments=1`、`latestComments` 可见；`export.md` 315B 且含 `**web** · 锚点 \`n1\``。

---

## 附录 A：协议帧速览（时序）

```
Peer                         Host
 │  hello(room)               │
 │ ─────────────────────────▶ │
 │  challenge(nonce)          │
 │ ◀───────────────────────── │
 │  join(proof, peerNonce)    │
 │ ─────────────────────────▶ │  校验 HMAC，注册 peer
 │  ready(hostProof, pseq)     │
 │ ◀───────────────────────── │  派生会话密钥
 │  ═══ 以下全为 AES-GCM 密文 ═══
 │  resume(patches) 或 snapshot │
 │ ◀───────────────────────── │
 │  patch(pseq, ops)（含 text） │
 │ ◀───────────────────────── │
 │  call(id, files.read{…})   │
 │ ─────────────────────────▶ │  ctx.fs 校验 + 脱敏 + 审计
 │  result(id, data)          │
 │ ◀───────────────────────── │
 │  ping / pong（20s）        │
 │ ◀─────────────────────────▶│
```

## 附录 B：配置样例（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-collab
      name: dsh-collab
      config:
        role: host
        bind: 0.0.0.0
        port: 8848
        allowPeers: 8
        ttlMinutes: 30
        maxTextBytes: 262144
        e2e: true
        denyGlobs: ['.git/**', 'node_modules/**', '.env*', '*.pem', '*.key', 'id_rsa*', '.ssh/**']
        hub:
          url: wss://hub.example.com/hub
          token: !!js process.env.DSH_COLLAB_HUB_TOKEN
```

## 附录 C：与既有实现的差异

| 维度 | `dsh-pocket` | `dsh-collab` |
|---|---|---|
| 协作者看到的 | 完整 DSH Web GUI（同屏、可操作） | 专用只读分享页（结构化时间线 + 文件） |
| 传输 | GUI 的 `/api` + WS 透传（含全部资源） | 自带 4 类语义帧，约 0.2 KB/s |
| 认证 | 8 位 PIN + cookie 会话 | 链接内 256 bit secret + 挑战应答 + E2E |
| 暴露面 | 等同把整个 DSH 暴露给来客 | 只暴露只读视图与受限文件读取 |
| 适用 | 自己用手机访问自己的 DSH | 给**别人**临时看自己的工作区 |

> 结论：`dsh-pocket` 解决"我在外面用自己的电脑"，`dsh-collab` 解决"同事临时看我在干什么"。两者不冲突，甚至可共存（同一台主机上不同端口）。
