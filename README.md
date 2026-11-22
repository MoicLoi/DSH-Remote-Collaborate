# dsh-collab · 超轻协作

给 DeepSeek Harness 加一条**链接**：主机持有工作区与 agent 会话，协作者打开链接就能看到**结构化**的实时视图（turn / 消息 / 工具调用），并能**只读**浏览主机的workspace。

不传视频流、不传像素、不给协作者 DSH 的控制台。

```
Host（你的 DSH） ── 结构化 JSON 帧 ──▶ 浏览器 / TUI（同事）
        │
        └─ 只读文件网关（工作区根内、拒绝清单、脱敏）
```

## 30 秒看效果（不需要 DSH）

```bash
node scripts/demo.mjs --port 8848
# 打开它打印的链接
```

演示会起一个真实的分发服务、一个演示工作区，并脚本化播放一段会话，你可以点开文件抽屉翻目录、读文件。

想看**中心机中转**？两条命令：

```bash
node scripts/demo.mjs --hub --no-direct      # 页面由中心机提供，全部走中继
node scripts/demo.mjs --hub                  # 中心机提供页面，同网段优先直连
```

## 中心机（跨网段协作）

一台有公网入口的机器跑 hub，主机把链接指向它：

```bash
# 中心机（独立进程，零依赖）
npx dsh-collab-hub --bind 0.0.0.0 --port 8787 --token "$DSH_COLLAB_HUB_TOKEN"

# 或者让一台 DSH 直接当中心机（插件 role: hub）
```

```yaml
# 主机侧 cordis.patch.yml
- id: dsh-collab
  name: dsh-collab
  config:
    mode: hub
    hubUrl: https://hub.example.com     # 链接 origin + 出站 WS 目标
    hubToken: <同一个 secret>
    bind: 0.0.0.0                       # 可选：让同网段的协作者优先直连
```

链路顺序：**同源直连 → 中心机通告的直连候选 → 中继**。页面先试同源 `/ws`，再读 `/hub/room/<code>` 拿主机的直连地址（1.8s 超时），最后落到 `/hub/peer` 中继。状态栏会显示「经中心机」。

TLS：用 Caddy/Nginx 反代（`reverse_proxy 127.0.0.1:8787` 自动处理 WebSocket），或给 hub 传 `--cert/--key`。

hub 只看到：房间码、peer id、帧长度。邀请 secret 和所有帧明文都在主机与协作者之间端到端加密。

## 主机控制台与在场状态

**控制台**：主机上打开 `http://127.0.0.1:<port>/collab/admin`（默认仅本机；远程需要 `adminToken` 并带 `?t=`）。实时显示每个房间的在线协作者、每人当前在做什么、到期倒计时、审计次数，并可**刷新链接**（踢掉旧链接）或**关闭房间**。

**在场状态机**：协作者会把自己正在做的事上报给主机，主机聚合后广播给所有人：

| 状态 | 触发 | 衰减 |
|---|---|---|
| `typing` 输入中 | 在搜索框输入 | 6 秒无输入→`idle` |
| `reading` 查看文件 | 打开文件预览（web）/ `/cat`（TUI） | 60 秒 |
| `browsing` 浏览目录 | 展开目录（web）/ `/files`（TUI） | 60 秒 |
| `searching` 搜索中 | 提交搜索 | 60 秒 |
| `idle` 空闲 | 无活动 / 页面隐藏 | — |

- 广播节流 200ms（输入很吵），尾帧必达。
- 协作方页面顶部出现「在场」条：`同事A 查看文件 src/a.ts`；主机控制台同样的信息按人排列；TUI 的 `在线：` 行也会显示。
- 主机插件还能拿到 Cordis 事件 `collab/peer-activity`（房间、peer、状态），便于后续 GUI 面板或审计插件消费。
- 自己的条目会自动从「在场」条里滤掉（`ready` 里带 `selfId`）。

## 双语

分享页与控制台都支持中/英：URL 加 `?lang=zh` / `?lang=en`，或点右上角 `EN / 中` 切换（记在 localStorage）。TUI 目前是中文。

## 在 DSH 里安装

```bash
dsh plugin add ./dsh-collab        # 本地目录（先 cd 到本仓库父目录）
# 或发布后：dsh plugin add dsh-collab
```

装完重启 DSH，然后在任意会话里：

- `/collab` —— 创建房间并拿到链接
- `/collab peers` —— 看谁在线
- `/collab stop` —— 关房、断开所有人
- 让 agent 用 `collab_share` 工具把链接写进回答里

配置写在 profile 的 `cordis.patch.yml`（按 `id: dsh-collab` 覆盖）：

```yaml
- id: dsh-collab
  name: dsh-collab
  config:
    bind: 0.0.0.0        # 局域网协作必须显式打开；默认 127.0.0.1
    port: 8848
    advertiseHost: ''    # 有 VPN/overlay 时填对外地址
    allowPeers: 8
    ttlMinutes: 30
    maxFileBytes: 262144
    files: true
    redact: true
    denyGlobs: ['.git/**', 'node_modules/**', '.env*', '*.pem', '*.key', 'id_rsa*', '.ssh/**']
```

### 宿主加载验证（已在本机跑通）

两条路径都验证过：

1. **隔离 profile**（不动日常环境）：独立 `DSH_HOME` + `dsh <name> --from-default-profile web`，把本包 junction 进 profile，`dsh --profile <name>` 启动 → 分享服务在 8848、`/healthz` 与 `/collab/admin` 正常、**没有 FAILED**。
2. **真实 desktop profile**：junction + 一行 patch，热加载后本会话直接拿到 `collab_share` / `collab_status`，并用它建了真实房间——分享页显示的是**这个会话的真实转录**，文件柜走 `ctx.fs`（控制台 `files: "ctx.fs"`），审计记录 1 条，关闭房间成功。

加载过程抓到一个真实兼容性问题并已修复：**Cordis 禁止访问未在 `inject` 声明的服务属性**（直接读 `ctx.fs` 会抛 `cannot get property "fs" without inject`）。插件现在只 `inject: ['sessions']`，其余服务（`fs`/`commands`/`tools`/`agents`）一律用 `ctx.get('…')` 查询，缺失时优雅降级。

本机当前是开发挂载：

```
C:\Users\moiclathy\.dsh\profiles\desktop\node_modules\dsh-collab   →  junction  → E:\dsh超轻协作
C:\Users\moiclathy\.dsh\profiles\desktop\cordis.patch.yml          →  末尾 dsh-collab insert 行
```

卸载：删掉这行 insert（备份 `cordis.patch.yml.bak-dsh-collab`）并删掉 junction，重启即可。正式发布用 `dsh plugin add dsh-collab` 走包管理。

### 对话内面板（设置 → 协作）

插件带一个 Web client 模块，在 **设置 → 协作** 里渲染实时状态：模式/文件来源/流式开关、每个房间的房间码、完整链接（一键复制）、在线协作者及其活动（输入中/查看文件/浏览目录）、到期倒计时，以及「控制台」跳转。

实现上没有打包器：`client/source.js` 是普通 CJS 风格的 React 源码，`node client/build.mjs` 把它套进 `window.__ModuleLoader__.load({ id, factory })` 信封；组件只用 `React.createElement`，不引任何 client 包，所以 `dsh.client` 不带 `inject` 边，也不会影响 Web boot。

数据不走跨域：宿主把 `/collab-panel/state` 注册在 DSH 自己的 web 服务器上（`ctx.inject(['webServer'], …)`），与 GUI 同源，**仅 loopback**、只读；面板每 3 秒刷新一次。

验证：隔离 profile 启动后，浏览器实测设置侧栏出现第 5 项「协作」，点进去渲染出 `模式 lan · 文件 node:fs · 流式 开` 与空房间提示，**零 page error**。

注意：**面板需要宿主重启一次才出现**——client 图在启动时按 Loader entries 合成，已经在运行的宿主不会重新扫描新声明的 `dsh.client`。

### 协作者留言与快照导出

协作者不只能看，还能**留言**（房间级）或**批注**（点某个节点再发送，锚定到该节点）：

- 分享页底部有输入框；点任意节点会出现锚点 chip（`回复某条 @n1 ×`），发送后锚定到该节点。
- 消息广播给房间所有人（包括发送者），并按 `seq` 去重；晚来的人从快照里拿到全部留言。
- 上限：单条 2000 字（超长截断、控制字符剥离）、每房间保留最近 200 条、每人 6 条突发 + 0.2 条/秒。超速回 `E_RATE`。
- 关闭方式：配置 `allowComments: false`（房间创建时生效，快照与 `ready` 都带这个标志）。

**导出**：`collab_export` 工具（或控制台 `/collab/api/rooms/<code>/export.md|json`）把「结构化时间线 + 全部留言」写成 Markdown/JSON，默认落到 `$DSH_HOME/dsh-collab/exports/<code>-<时间>.md`。

**留言怎么进 agent**（重要）：用**拉取式**而不是推送。

| 方式 | 结论 |
|---|---|
| 推送（插件主动往会话里塞消息） | ❌ 不可行：`sessions` 服务没有"追加消息"API；唯一的主机侧投递是 `agentTeams.sendMessage`，要求 caller 是团队成员 agent，自投递不在支持范围 |
| 拉取（`collab_inbox` 工具） | ✅ 采用：agent 调一次工具，结果就作为工具结果**被记录进会话日志**，天然满足"模型可见 ⇔ 已记录" |

用法：agent 调 `collab_inbox { since: <上次的 cursor> }` 拿到新留言与 `cursor`；回话用 `collab_reply { room, text }`，会以「主机」身份广播给所有人。TUI 对应 `/say <消息>`。

![协作者留言](shots/comments.png)

| 配置 | 默认 | 说明 |
|---|---|---|
| `role` | `host` | `host` 分享工作区；`hub` 只做撮合与中继 |
| `mode` | `lan` | `hub` 时链接指向 `hubUrl`，peer 先直连、失败再中继 |
| `hubUrl` | 空 | 中心机 origin（`https://hub.example.com`），同时是出站 WS 目标 |
| `hubToken` | 空 | 主机向 hub 注册的共享密钥（务必设置） |
| `directOrigins` | `[]` | 额外通告给 peer 的直连 origin（VPN / 端口映射） |
| `hubBind` / `hubPort` | `127.0.0.1` / `8787` | `role: hub` 时的监听设置 |
| `hubTlsCert` / `hubTlsKey` | 空 | 直挂 TLS；留空则推荐反代终止 |
| `hubMaxPeers` / `hubRoomTtlMinutes` | `32` / `480` | hub 侧每房间人数与房间寿命 |
| `adminToken` | 空 | 空 = 控制台仅本机；设了则远程需 `?t=<token>` |
| `bind` | `127.0.0.1` | 局域网需改 `0.0.0.0`（会触发系统防火墙授权） |
| `port` | `8848` | `0` 表示随机端口（端口会打印在日志/健康检查里） |
| `advertiseHost` | 空 | 链接里使用的地址；空则 loopback→127.0.0.1、0.0.0.0→本机局域网 IP |
| `allowPeers` | 8 | 单房间人数上限 |
| `ttlMinutes` | 30 | 空闲到期时间，硬上限 8 小时 |
| `maxFileBytes` | 256 KiB | 单次读取上限，超出截断 |
| `files` | true | 关掉则协作者只能看会话视图 |
| `streaming` | true | 订阅 `agent/assistant-stream`，把 token 增量推给协作者（80ms 合并） |
| `audit` | true | 每个房间一份 JSONL 访问日志，落在 `$DSH_HOME/dsh-collab/audit-<room>.jsonl` |
| `auditDir` | 空 | 审计目录覆盖，空则用上面默认位置 |
| `auditMaxBytes` | 2 MiB | 单文件上限，超出滚动为 `.1` |
| `redact` | true | 对 `sk-…`/`ghp_…`/私钥等做模式脱敏 |
| `denyGlobs` | 见上 | 路径拒绝清单，同时作用于列表/读取/搜索 |

## 协作者怎么用

**浏览器**：直接打开链接（手机也行，响应式）。顶部有房间码、主机名、在线人数、到期倒计时；点「文件」打开工作区抽屉，点目录展开、点文件预览。

**终端**：

```bash
npx dsh-collab join "http://192.168.1.20:8848/c/7K3M9Q2X#k=..."
```

TUI 支持 `/files [path]`、`/cat <path>`、`/search <q>`、`/status`、`/leave`。断线自动重连。

## 安全模型（要点）

- **链接秘密不上线**：`#k=` 里的 256 bit 只用于挑战-应答（HMAC）和派生会话密钥；浏览器不会把它发给服务器，服务端日志里也没有。
- **端到端加密**：握手完成后所有帧都是 AES-256-GCM，AAD 绑定 `协议版本|房间|序号`，防篡改、防重放、防乱序。
- **只读**：协作者只有 4 个文件方法与 2 个只读帧；没有写、没有执行、没有任意 HTTP 代理。
- **路径边界**：所有路径必须在工作区根内（`..`、绝对路径、符号链接逃逸一律 `E_SCOPE`）；默认拒绝 `.git`、`node_modules`、`.env*`、私钥、`.ssh` 等。
- **脱敏 + 截断**：返回前扫描常见密钥形态并替换成 `[redacted:…]`；单文件超过 `maxFileBytes` 截断。
- **可撤销**：`/collab stop` 立即销毁；刷新链接会轮换 secret 并踢掉所有协作者；主机进程退出即全部失效（密钥只在内存里）。

## 协议一览

```
Peer → Host  hello(room)
Host → Peer  challenge(nonce)
Peer → Host  join(HMAC(nonce|room|peerNonce), peerNonce, resumeFrom)
Host → Peer  ready(hostProof, expiresAt, scopes, pseq)
             ── 以下全部 AES-GCM 密文 ──
Host → Peer  snapshot(nodes, pseq)    最近 ≤300 节点 / ≤256 KiB（首次或续传不了）
Host → Peer  resume(patches)          只补 lastPseq 之后缺的补丁
Host → Peer  patch(pseq, ops)         append / update / remove / text（80ms 合并）
Host → Peer  files(root) / presence(peers) / ping
Peer → Host  call(files.list|read|stat|search) / pong / bye
```

视图节点：`turn` / `user` / `assistant` / `tool` / `notice`。会话事件到节点的投影是纯函数，未知事件类型直接忽略（DSH 升级不会打挂房间）。

流式文本走 `agent/assistant-stream` 的 `text-delta`：先 `append` 一个 `streaming:true` 的空节点，再按 80ms 合并推 `text` 增量，`assistant/message` 到达时用权威全文 `update` 覆盖（不会重复、不会漂移）。帧形状由 `src/stream.js` 容错解析，认不出就退化为"按步实时"，视图仍然正确。

### 经中心机时多一层信封

Hub 只做搬运，协议帧保持端到端密文，外面套一层路由信封：

```
Peer → Hub   { v:1, t:'relay', payload:"<原来的 JSON 帧字符串>" }
Hub → Host   { v:1, t:'relay', peer:'p1', payload:"…" }
Host → Hub   { v:1, t:'relay', peer:'p1', payload:"…" }
Hub → Peer   { v:1, t:'relay', payload:"…" }
```

控制帧：`register` / `registered` / `peer-open` / `peer-close` / `attached`。hub 不认识 `hello`/`challenge`/`enc`，那些字节对它是不透明的。

## 工程结构

```
src/index.js      插件入口（Config、命令、工具、生命周期、流式订阅）
src/server.js     HTTP（分享页/健康检查）+ WS 边缘 + 每 Peer 会话 + 审计写入
src/ws.js         零依赖 RFC6455 服务端（文本帧、ping/pong、close）
src/room.js       房间、邀请、TTL、人数、轮换、补丁环形缓冲（续传）、流式合并
src/invite.js     链接生成/解析
src/crypto.js     HKDF / HMAC 挑战应答 / AES-GCM 封帧
src/projector.js  会话事件与 token 增量 → ViewNode
src/stream.js     agent/assistant-stream → 文本增量（容错解析）
src/gateway.js    只读工作区网关（边界、拒绝清单、脱敏、搜索）
src/fs-port.js    文件端口：node:fs 或 DSH ctx.fs 接缝（失败自动回退）
src/audit.js      每房间 JSONL 访问审计（有界、fail-soft）
src/feed.js       会话日志回放 + 定位
web/              分享页（原生 JS，无框架、无 CDN、无构建）
bin/collab.mjs    TUI 客户端
scripts/demo.mjs  无 DSH 的本地演示
scripts/smoke-plugin.mjs  假 ctx 的插件级冒烟
test/             node:test 单测 + 端到端
```

零运行时依赖（`web` 用原生 API，服务端 WS 自己实现，Node ≥22 自带全局 `WebSocket` 客户端）。

## 测试

```bash
node --test "test/*.test.js"     # 91 个：crypto / invite / projector / stream / presence / gateway / ws / hub / admin / comments / panel / e2e / e2e-hub
node scripts/smoke-plugin.mjs    # 插件级：配置、命令、工具、真实 WS 全链路
```

## 打包与发布

```bash
npm pack --pack-destination dist                    # npm 包（files 白名单，37 个文件）
git archive --format=zip -o dist/dsh-collab-0.7.0-source.zip HEAD
git archive --format=tar.gz --prefix=dsh-collab-0.7.0/ -o dist/dsh-collab-0.7.0-source.tar.gz HEAD
```

校验（PowerShell）：`Get-ChildItem dist/*.tgz,dist/*.zip,dist/*.tar.gz | ForEach-Object { "$((Get-FileHash $_ -Algorithm SHA256).Hash.ToLower())  $($_.Name)" }`

发布：`git tag v0.7.0 && git push origin main --tags`。推送 tag 后 `.github/workflows/release.yml` 会自动跑测试、重打包三个产物、算 SHA256 并建 GitHub Release。

## 当前状态（M4）

已完成：

- **连接**：LAN 直连、中心机中继、直连优先、链接/轮换/撤销、挑战应答、端到端加密、人数/TTL/限流、断线重连。
- **视图**：结构化会话视图（历史回放 + 实时补丁）、逐 token 流式（80ms 合并 + 光标）、轻量 Markdown。
- **在场**：状态机（typing/reading/browsing/searching/idle）+ 聚合广播 + 衰减 + 节流；两端可见。
- **续传**：512 个补丁的环形缓冲，重连只补差异；补不齐回落快照。
- **文件**：只读浏览/搜索/截断/脱敏；默认经 `ctx.fs`，失败回退 `node:fs`；每房间审计。
- **留言/批注**：房间级消息 + 节点锚定；广播、快照携带、限速与上限、可关闭。
- **导出**：Markdown/JSON 快照（时间线 + 留言），工具与控制台两条路径。
- **主机控制台**：`/collab/admin` 实时房间/协作者/活动/留言/审计，可刷新链接、关闭房间、下载导出。
- **双语**：分享页 + 控制台 zh/en，可 URL 切换。
- **对话内面板**：设置 → 协作，房间码/链接/协作者活动/到期，一键复制；同源 loopback 路由取数，无打包器。
- **DSH 集成**：`Config`、`/collab`、`collab_share` / `collab_status` / `collab_inbox` / `collab_reply` / `collab_export`、`collab/peer-activity` 与 `collab/peer-comment` 事件、`ctx.effect` 生命周期、`dsh.client` 面板。

尚未做：

- **推送式留言进 agent**：见上表，服务面没有合法的"往会话追加消息"通道；已用 `collab_inbox` 拉取式替代。若未来 DSH 提供 turn 外的消息注入 API，可平滑替换。
- **敏感路径的"主机确认"式放行**：`ctx.approval.request` 要求"请求方会话处于打开的 turn 内"，而 peer 读文件发生在 turn 之外，硬接会拒绝一切读请求——继续用"拒绝清单 + 脱敏 + 审计"，等 turn 外审批通道。
- 面板上的旋转/关房/导出按钮（目前这些动作在控制台；面板只读）。

已知限制：会话视图在宿主未发 `assistant-stream` 时退化为按步实时；目录单层 400 项上限；二进制只报元数据；hub 中继带宽由中心机承担；留言只在房间内存里（房间关闭即失效，但导出文件会留下）。

验证边界：协议/边缘/分享页/TUI 都用真实服务与 headless Chromium 跑通（含流式光标、中继态、控制台、双语、在场条、留言锚定）；**已装进真实 desktop profile 加载并实测**（真实会话、`ctx.fs` 文件读取、审计、关房），加载期发现的 `ctx.fs` 未声明访问问题已修复。

