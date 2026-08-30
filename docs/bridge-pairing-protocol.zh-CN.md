# Motrix Bridge 配对协议 — MBP1

规范性文档，版本 1（`protocolVersion = 1`）。

本文档定义 Motrix 浏览器扩展与 Motrix bridge server 之间配对与认证的 wire
契约，并把所有密码学参数钉死到字节级。**MUST**、**MUST NOT**、**SHOULD**、
**MAY** 按 RFC 2119 / RFC 8174 的含义使用。

状态：**密码学审查 gate 已满足**（六轮独立对抗审查，均重新确认 0 High；
发现已处理，残留 Low 项跟踪到实现——见附录 C 审查日志）。Phase-A 实现可以
开始；[§14](#14-审查与实现-gate) 中其余 Phase-A 前置条件仍适用。

相关文档：[RFC 9382]（SPAKE2）、[RFC 5869]（HKDF）、[RFC 8032]（edwards25519
编码）、[RFC 7914]（scrypt）、[RFC 4648]（base32 背景；MBP1 使用 §7 定义的
Crockford 字母表）。MDXP 应用层协议不受 MBP1 影响，由 `@motrix/mdxp` 包定义；
MBP1 安全信道位于 MDXP **之下**。

---

## 1. 概述

Native Messaging（NM）时代对 server 的认证是隐式的：WebSocket 端口来自
`endpoint.json`——一个 owner-only（0600）文件——因此连上这个端口就证明对端是
用户自己的 Motrix。固定候选端口（16802–16806）移除了这一证明。MBP1 以下列
机制替代：

1. **首次配对** — code-entry 平衡 PAKE（SPAKE2，[RFC 9382]），其口令是一个
   短时效配对码，**由 Motrix 显示、由用户手动输入进扩展**。假 server 没有
   对话框也没有配对码，用户无从输入：首次配对在构造上即 fail closed。
2. **重连** — 基于长期对称凭据（`mutualKey`）的双向 challenge–response。
   bearer token 绝不出现在网络或 URL 中。
3. **安全信道** — 握手后的每一帧、双向，都包裹在带严格序号的 AES-256-GCM
   envelope 内。MDXP 载荷只在该 envelope 内传输。
4. **NM attestation** — 在 Native Messaging 可用的环境，NM host 铸造一张
   一次性 ticket，证明调用方*是哪一个*扩展，支撑审批对话框中的
   `official / attested-non-official / unverified` 三态身份显示。

角色分配：**扩展是 A 方**（发起方，使用点 *M*），**Motrix bridge server 是
B 方**（应答方，使用点 *N*），与 [RFC 9382] §3.1 的规定一致。

### 1.1 MBP1 不防御什么

明示边界以免读者高估保证。不在范围内：同 UID 本地代码（可 `ptrace` Motrix、
读取 `storage.local`）、root 或具备 raw-socket / eBPF 能力的代码、共享 X11
输入注入、被攻破的浏览器。MBP1 必须挡住的攻击者是**共宿主机的不同 UID
用户**：其可以抢占 loopback 候选端口并主动连接或中继，但无法读取其他 UID 的
0600 文件，也无法被动截获其他 UID 已建立的 loopback 流。

**透明中继**（抢占端口、把一场 PAKE 会话逐帧转发给真正的 Motrix）会建立一条
它自己无法读取的端到端密钥。AEAD 信道使其得不到明文、无法伪造、无法篡改；
剩余的——存在于路径中、可见流量大小与时序、成为扩展 pin 的端口——是 loopback
端口抢占的固有残留，如实记录，不声称已关闭。

---

## 2. 记号与规范编码

- `x ‖ y` — 字节串拼接。
- `len64LE(s)` — `s` 的字节长度，编码为 **8 字节小端**整数（与 [RFC 9382]
  §3.2 一致）。
- `enc(s)` — `len64LE(s) ‖ s`。除非另行说明，字符串按 UTF-8 编码；规范结构中
  的每个字符串字段 MUST 仅含 ASCII，实现 MUST 拒绝这些字段中的非 ASCII 输入。
- `encU32BE(n)` / `encU64BE(n)` — 4/8 字节大端无符号整数。
- `OS2IP(b)` — 把字节串 `b` 按大端解释为整数。
- `I2OSP(n, k)` — 把 `n` 编码为 `k` 字节大端串。
- JSON wire 消息中的 Base64 一律为 **无 padding 的 base64url**（[RFC 4648]
  §5）。解码器 MUST 拒绝带 padding 或非规范输入。
- “constant-time 比较”指运行时间不随首个差异字节位置变化的逐字节比较。

---

## 3. Ciphersuite（固定；无协商）

MBP1 v1 只支持恰好一个 ciphersuite。没有协商、没有降级路径；不会说该
ciphersuite 的对端直接握手失败。

| 组件 | 选择 |
|---|---|
| 群 *G* | edwards25519（[RFC 8032]）；基点 *P* = RFC 8032 基点；阶 `ℓ = 2^252 + 27742317777372353535851937790883648493`；cofactor `h = 8` |
| 点编码 | `pA`、`pB`、`K` 均为 32 字节 RFC 8032 压缩编码 |
| PAKE | SPAKE2（[RFC 9382]），ciphersuite SPAKE2-edwards25519-SHA256-HKDF-HMAC（Table 1 第 6 行） |
| Hash | SHA-256 |
| KDF | HKDF-SHA-256（[RFC 5869]） |
| MAC | HMAC-SHA-256 |
| MHF（口令→标量） | scrypt（[RFC 7914]），`N=2^14, r=8, p=1, dkLen=64` |
| AEAD | AES-256-GCM，12 字节 nonce，16 字节 tag |
| 签名（ticket 绑定） | Ed25519（[RFC 8032]） |

**固定点** *M*、*N* 取 [RFC 9382] §6 的 edwards25519 常量（32 字节 RFC 8032
编码，hex）：

```
M = d048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf
N = d3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab
```

**实现来源。** 曲线运算、SPAKE2 组合、scrypt 与 Ed25519 MUST 来自捆绑的、经
独立审计的库并以**精确版本**锁定：TypeScript 侧为 **`@noble/curves@2.0.1`**
与 **`@noble/hashes@2.0.1`**（即生成规范性测试向量所用的版本）。Cure53
2024 年 9 月的审计基于 `@noble/curves` 1.6.0。**Phase-A 发布前待确认：**
补全此锁定版本审计依据所需的、对 1.6.0 到 2.0.1 上游 diff 的 maintainer
审阅尚未进行；审查日志（附录 C）记录了这一状态。任何版本升级都要重跑
全部向量并更新此锁定。
MUST NOT 使用 WebCrypto 的 X25519/Ed25519：其要求 Chrome 133 / Firefox
130，而扩展
支持 Chrome 120+ / Firefox 121+（见附录 B）。对称原语（AES-256-GCM、
HKDF-SHA-256、HMAC-SHA-256）MAY 使用在上述最低版本普遍可用的 WebCrypto。
所有涉密比较 MUST 为 constant-time；标量乘法 MUST 对标量 constant-time
（noble-curves 满足）。

---

## 4. 传输面与入口 demultiplexing

bridge server 监听 loopback，绑定候选段 **16802–16806** 中第一个空闲端口
（全占用时降级 ephemeral 端口）。与 MBP1 相关的四个面：

| 面 | 方法 | 认证 | 用途 |
|---|---|---|---|
| `/discovery` | `GET` | 无 | 探测 hint：这里有没有 Motrix、是哪个实例？ |
| `/nonce` | `POST` + 自定义头 | 无 | 一次性配对 nonce 签发 |
| `/pair` | WS upgrade，`?nonce=` | MBP1 首次配对 | code-entry PAKE 配对 |
| `/v1` | WS upgrade，URL 无凭据 | MBP1 重连 | challenge–response 会话 |

**Demultiplexing 仅由路由决定，且发生在消费任何 nonce、创建任何会话对象、
排队任何对话框之前。** `/pair` 只接受 MBP1 首配状态机；`/v1` 只接受 MBP1
重连状态机。不存在 token-only 模式、`?token=` 查询参数或可降级的 legacy
帧格式。两条路由上的连接在 MBP1 完成前都留在带硬性 deadline 与容量上限的
pre-authentication 表中；它们绝不进入 live-session map，也不能驱逐已认证
会话。

**两条 WebSocket 路由都要求 `motrix-bridge.v1` subprotocol。** 客户端 MUST 在
`Sec-WebSocket-Protocol` 中提供它；提供列表中不含它的请求会在检查路由之前、也在
消耗任何 nonce 之前以 **401** 拒绝。这是硬性门而非提示：不带它的客户端连不到任何
一个状态机。

---

### 4.1 `GET /discovery`

未认证、可重放，**只是 hint，绝不是信任决策**。响应
（`Cache-Control: no-store`）：

```json
{ "app": "motrix-bridge", "apiVersion": 1,
  "instanceId": "<persisted per-install UUID>", "appVersion": "2.0.0-beta.20",
  "runtime": "electron",
  "extensionPairing": { "protocol": "mbp1", "versions": [1] },
  "applicationProtocols": { "mdxp": ["1.0"] } }
```

`instanceId` 是路由 hint，用于决定优先探测哪个候选端口。兼容性字段可让扩展在
配对前停止并解释升级要求，但仍只是未认证 hint：MUST NOT 据此选择 legacy
降级、授予信任或代替认证后的 capability 确认。扩展 MUST 只在该端口上完成
双向认证的 MBP1 会话之后才提交端口 pin。

### 4.2 `POST /nonce`

取代原 `GET /nonce`；GET 路由 MUST 移除（返回 404）。请求 MUST 携带自定义头
`X-Motrix-Bridge: 1`；该头使请求成为 non-simple 请求，跨源网页会被浏览器
preflight 拦截（server 不授予任何 CORS）。响应：

```json
{ "nonce": "<one-shot opaque ASCII string>", "ttlSeconds": 60 }
```

Nonce 一次性、60 秒过期、只被 `/pair` 消费，任何一方 MUST NOT 持久化。
server MUST 限制未消费 nonce 总数（默认 32）、施加全局签发速率限制，并在
存在 origin 时按 verified origin 配额限流。

### 4.3 Host 头校验

绑定 loopback 期间，所有 HTTP 路由与 WebSocket upgrade MUST 拒绝（403）
`Host` 不严格等于 `127.0.0.1[:port]`、`localhost[:port]` 或 `[::1][:port]`
的请求。这封死 DNS rebinding。（server shell 绑定非 loopback 时维持其既有
token + 反向代理模型，不在 MBP1 范围内。）

---

## 5. 扩展身份三态

审批对话框 MUST 区分三种身份状态；证明*是哪一个*扩展在调用，不等于证明它是
*官方*扩展：

| 状态 | 条件 | UI |
|---|---|---|
| `official` | 已证明的调用方身份——Chromium 的 verified `Origin` host，或有效 NM attestation ticket（§9）内的 `callerId`——出现在不可变 allowlist `src/shared/config/native-messaging-extensions.json` 中 | 可展示 Motrix 品牌 |
| `attested-non-official` | 有效 ticket 证明了确切的调用方 ID，但该 ID 不在 allowlist 中 | 展示原始已证明 ID，无品牌 |
| `unverified` | 无任何 attestation：不带 ticket 的任何 Firefox `/pair`（`moz-extension://<UUID>` origin 无法映射到 Gecko ID）、候选段扫描到的对端 | 警示样式，展示原始 claimed ID |

规则：

- “官方”身份**只**读不可变 allowlist——绝不读 NM manifest 集合（后者包含
  用户自行添加的 registry ID）。
- verified origin 只来自 WebSocket upgrade 的 `Origin` 头——绝不来自查询
  参数或消息内的自报字段。
- Chromium 上，若 `Origin` host 不等于 `claimedExtensionId`，server MUST
  拒绝配对。Firefox 上 `moz-extension://` origin 无法对照 claimed Gecko ID；
  无 ticket 时状态即 `unverified`。
- verified origin 绑定到会话、凭据 principal、限流 key 与 PAKE transcript
  （§6.4）。本地原生进程可以伪造任意 `Origin` 头；origin 绑定只在浏览器
  内部抬高门槛。面向用户的边界仍是配对码 + 审批对话框，辅以伪造 origin
  轮换也绕不过的全局弹窗上限。

---

## 6. 首次配对 — code-entry SPAKE2

### 6.1 消息流程

信道激活前的所有 `/pair` 消息都是单个 WebSocket **文本**帧，内容为恰好一个
带 `type` 判别字段的 JSON 对象。二进制字段用 base64url。未知 `type`、乱序
消息、重复消息、超大帧（认证前 > 16 KiB）或 schema 校验失败的 JSON MUST 以
`protocolViolation` 中止连接。

```
extension (A)                                Motrix (B)
    |                                            |
    |-- pairHello ------------------------------>|  校验 nonce、origin、
    |                                            |  ticket；排队审批对话框
    |<------------------------------- pairAccept |  （对话框显示配对码）
    |                                            |
    |            用户在 Motrix 窗口读取配对码     |
    |            用户在扩展中输入配对码           |
    |                                            |
    |-- pakeA {pA} ----------------------------->|
    |<----------------------------- pakeB {pB}   |
    |-- confirmA {cA, ticketProof?} ------------>|  验证 cA（+ proof）
    |<----------------------------- confirmB {cB}|
    |            验证 cB                          |
    |============ AEAD 信道激活 ==================|
    |<------------------------- credentialOffer  |
    |   持久化到 storage.local                    |
    |-- credentialAck --------------------------->|  持久化 commit
    |<--------------------- credentialCommitted  |
    |============ MDXP initialize... ============|
```

#### `pairHello`（A→B）

```json
{ "type": "pairHello", "protocolVersion": 1,
  "browser": "chromium" | "firefox",
  "claimedExtensionId": "<store ID or Gecko ID>",
  "clientInstallationId": "<UUIDv4 persisted in storage.local>",
  "nmTicket": { ... },            // 可选，§9
  "ticketBindingKey": "<b64url 32-byte Ed25519 public key>"  // 当且仅当携带 nmTicket 时必填
}
```

收到后 server MUST 依次：校验 `?nonce=`（一次性、未过期）——nonce 无效时在
做任何后续工作之前关闭 socket；校验 Host 头与 `Origin`；在**创建任何会话
状态或对话框之前**执行 pending-pair 去重（以 verified origin 为 key）、全局
pending 上限与 backoff（§7.3）；若携带 `nmTicket` 则校验之（§9），要求
ticket 的 `bindingPub` 等于 `ticketBindingKey`、`callerId` 等于
`claimedExtensionId`；解析身份三态；然后恰好排队一个审批对话框。

#### `pairAccept`（B→A）

```json
{ "type": "pairAccept", "protocolVersion": 1, "instanceId": "<UUID>" }
```

对话框排队后发送。扩展 popup 随即提示输入配对码。`pairAccept` 不携带任何
批准语义——扩展 MUST NOT 把任何 server 消息当作“用户已批准”；只有 key
confirmation 成功才是证明。

#### `pakeA` / `pakeB`

```json
{ "type": "pakeA", "pA": "<b64url 32 bytes>" }
{ "type": "pakeB", "pB": "<b64url 32 bytes>" }
```

#### `confirmA` / `confirmB`

```json
{ "type": "confirmA", "cA": "<b64url 32 bytes>",
  "ticketProof": "<b64url 64-byte Ed25519 signature>" }   // 当且仅当发送过 nmTicket 时必填
{ "type": "confirmB", "cB": "<b64url 32 bytes>" }
```

### 6.2 配对码 → 标量 `w`

配对码（§7）规范化为 Crockford 字母表上的 8 字符串。令 `pw` 为其 8 个
ASCII 字节。双方计算：

```
salt = "MBP1/w/v1" ‖ UTF8(pairNonce)
h    = scrypt(pw, salt, N=2^14, r=8, p=1, dkLen=64)
w    = OS2IP(h) mod ℓ
```

`pairNonce` 是本 `/pair` 连接消费的那个 ASCII nonce 串原文，使 `w` 会话
唯一。若 `w = 0`，以 `pairingFailed` 中止（概率 ≈ 2^-252；不附带重试语义）。
512 位散列 mod ℓ 的偏差可忽略（RFC 9382 §3.2 只要求多 64 位）。scrypt 是
RFC 推荐的 MHF；每次尝试只需计算一次，同时也彻底封死在配对码存活期内对
主动攻击 transcript 记录的离线穷举。

### 6.3 SPAKE2 计算

按 [RFC 9382] §3.3，A = 扩展，B = Motrix：

- A 以**拒绝采样**（[RFC 9382] §7）从 `[1, ℓ)` 均匀抽取 `x`：抽 32 个
  CSPRNG 字节按大端解释，值为 0 或 ≥ ℓ 时重抽。`X = x·P`，`pA = w·M + X`。
- B 以同样方式抽取 `y`。`Y = y·P`，`pB = w·N + Y`。
- 收到的点 MUST 能按 RFC 8032 规范编码解码为曲线上的点；否则以
  `protocolViolation` 中止。（noble-curves 拒绝非规范编码。）
- A 计算 `K = h·x·(pB − w·N)`；B 计算 `K = h·y·(pA − w·M)`；`h = 8`。
  若 `K` 为单位元则中止（计为一次失败尝试，§7.2）。
- `x`、`y` MUST 每次协议运行新抽、绝不复用；所有 PAKE 状态仅存在于内存，
  运行以任何方式结束时即销毁。

### 6.4 Transcript `TT` 与身份

```
A_id = enc("MBP1/A/v1") ‖ enc(browser) ‖ enc(verifiedOrigin)
     ‖ enc(claimedExtensionId) ‖ enc(clientInstallationId)
B_id = enc("MBP1/B/v1") ‖ enc("motrix-bridge") ‖ enc(instanceId)

TT = enc(A_id) ‖ enc(B_id) ‖ enc(pA) ‖ enc(pB) ‖ enc(K) ‖ enc(I2OSP(w, 32))
```

- `browser` 取 `pairHello` 中的原文；`verifiedOrigin` 是 `Origin` 头值的
  ASCII 序列化（如 `chrome-extension://<id>` 或 `moz-extension://<uuid>`）——
  扩展在本地计算自己的 origin；任何不一致都会在构造上破坏 key confirmation
  （misbinding 属性）。
- `pA`、`pB`、`K` 是 32 字节点编码；`w` 按大端补齐到 32 字节（定长，
  RFC 9382 §3.3）。

**AAD**（绑入 confirmation key，RFC 9382 §4）：

```
AAD = encU32BE(protocolVersion) ‖ enc(pairNonce)
    ‖ enc(ticketBindingKeyOrEmpty) ‖ enc(ticketDigestOrEmpty)

ticketDigest = SHA-256(
      encU32BE(v) ‖ enc(purpose) ‖ encU32BE(ticketProtocolVersion)
    ‖ enc(serverGeneration) ‖ enc(browser) ‖ enc(callerId)
    ‖ encU64BE(exp) ‖ enc(bindingPub) ‖ enc(mac))
```

- 携带 `nmTicket` 时，`ticketBindingKeyOrEmpty` 为 `pairHello.ticketBindingKey`
  的原始 32 字节，否则为空串。
- `ticketDigest` 覆盖 **ticket 每个字段解析值的上述规范编码**——`v` 与
  `ticketProtocolVersion` 为 U32、`exp` 为 U64、字符串为 UTF-8、
  `bindingPub`/`mac` 为其 base64url 解出的原始字节。（不哈希 JSON 原始
  拼写/空白；双方各自重新编码所解析的值。）未携带 ticket 时
  `ticketDigestOrEmpty` 为空串。这里刻意**不**复用 §9.2 的规范 MAC 输入
  （后者把 `purpose` 固定为常量域标签），以便翻转*任何* wire 字段——`mac`、
  `purpose`、`bindingPub`、`callerId`、`serverGeneration`、`browser`、
  `exp`、`v`、`ticketProtocolVersion`——都会改变 digest。

由于单独的 `ticketBindingKey` 字段与每个 ticket 字段都被绑定于此，路径上的
攻击者修改其中任一项都会使双方 AAD 失配、破坏 key confirmation：此类篡改让
配对 **fail closed**，绝不静默降级为 `unverified`。顺序说明：server 在
`pairHello` 处运行 §9.2 ticket 校验，*先于* key confirmation。因此被篡改的
ticket 并非“绕过”校验——校验对 server 实际收到的内容进行；是随后的 *key
confirmation* 因双方 digest 不同而失败。对双方逐字节一致的 ticket，其内容级
结果按 §5/§9.2：generation 未知或过期降级为 `unverified`，而有效但 `callerId`
不在 allowlist 的 ticket 得到 `attested-non-official`（不是 `unverified`）。

### 6.5 Key schedule 与 confirmation

按 [RFC 9382] §4，Hash 为 SHA-256：

```
Ke ‖ Ka   = SHA-256(TT)                       （各 16 字节）
KcA ‖ KcB = HKDF-SHA-256(ikm=Ka, salt=empty,
             info="ConfirmationKeys" ‖ AAD, L=32)   （各 16 字节）
cA = HMAC-SHA-256(KcA, TT)
cB = HMAC-SHA-256(KcB, TT)
```

A 先发 `cA`。B MUST 在发送 `cB` 之前验证 `cA`（若曾出示 ticket，还须验证
`ticketProof`：ticket-binding 私钥对 `"MBP1/ticket-proof/v1" ‖ TT` 的
Ed25519 签名，按 §9.1 的 RFC 8032 strict 规则用 ticket 的 `bindingPub`
验证——`zip215: false`，绝不使用 ZIP-215 宽松默认）。A MUST 在发送任何后续
内容之前验证 `cB`。两处验证均为 constant-time。验证失败计为一次**失败尝试**
（§7.2），B 回复 `pairError {code:"codeMismatch", attemptsRemaining}` ——
其后（配对码仍存活时）MAY 在同一连接上以全新 `x` 发起新一轮 `pakeA`。

**双方独立执行尝试限制。** 扩展 MUST 自行执行**每配对会话至多 3 轮协议
运行**的上限与自 `pairHello` 起 **180 秒**的绝对会话 deadline，外加自己的
全局失败 backoff——无论对端报告什么：server 发来的 `attemptsRemaining` 是
不可信的展示数据，MUST NOT 用来放宽本地限制。否则，假冒或中继的 listener
可以无限回复 `codeMismatch`，每诱导一轮就收获一次口令试探。

### 6.6 配对会话 traffic key

双向 confirmation 之后：

```
kC2S = HKDF-SHA-256(ikm=Ke, salt="MBP1/pair/v1", info="MBP1-pair-traffic-c2s", L=32)
kS2C = HKDF-SHA-256(ikm=Ke, salt="MBP1/pair/v1", info="MBP1-pair-traffic-s2c", L=32)
```

`info` label 刻意与重连 label（§8）不同：MBP1 中每个 HKDF/HMAC 调用都携带
全局唯一的 label，key 分离从不依赖 IKM 或 salt 的偶然差异。

连接上其后的所有帧、双向——凭据消息与 MDXP 一视同仁——都在 AEAD envelope
（§10）内传输。

### 6.7 凭据签发 — 两阶段提交

在 AEAD 信道内：

1. **B→A `credentialOffer`** `{ "type": "credentialOffer", "credentialId":
   "<UUIDv4>", "mutualKey": "<b64url 32 CSPRNG bytes>" }`。server 在发送
   **之前**先以 `provisional` 状态持久化该凭据。
2. **A** 把 `{credentialId, mutualKey, state:"provisional", sub:"unacked"}`
   写入 `storage.local`；随后，**在发送 `credentialAck` 之前，A 先持久化把
   子状态 `unacked → commit-uncertain`**（write-ahead），然后才发送
   **`credentialAck`** `{ "type": "credentialAck", "credentialId": "<same>" }`。
   write-ahead 是强制的：`commit-uncertain` 必须意味着“ack **可能**已发出”，
   使持久翻转与发送之间的崩溃也落到永久保留态、而非老化态。
3. **B** 持久化标记该凭据为 `committed`，然后发送
   **`credentialCommitted`** `{ "type": "credentialCommitted" }`。A 将本地
   副本标记为 `committed`。

原子性规则：

- server 侧的 provisional 凭据同样可用于重连认证（§8）；一次成功的
  challenge–response 本身就是经认证的确认，会把它提升为 `committed`。
  **持久提升顺序（server）：** 在提升某 provisional 凭据的重连中，server MUST
  依次：(i) 验证 `reconnectResponse`，(ii) **持久**提升该 provisional 为
  `committed`——对轮换而言在同一持久事务内 CAS-提升新的**并**吊销旧的——
  然后才 (iii) 发送 `reconnectAccept`。提升未持久前 MUST NOT 发送
  `reconnectAccept`，否则 accept 之后崩溃可能使刚认证的凭据仍是 provisional
  而后过期。若 server 采用「启动时重放轮换 journal」替代单事务，该重放 MUST
  在 **`/v1` 开始接受认证之前**完成、并收敛为每 principal 恰好一把有效凭据，
  使任何客户端都不会对着半完成的轮换认证。
- **持久 commit 顺序（client）。** 认证成功时，客户端 MUST 在**一次原子持久
  写入**中同时把已认证凭据标记为 `committed` **并**把 `activeCredentialId`
  指向它——状态与指针永不失配——之后才可修剪其他凭据。原子写入之后、修剪
  之前的崩溃因此无害：存储可能短暂含两条 `committed`，但 `activeCredentialId`
  明确指出存活的那把。**恢复顺序：** 若 `activeCredentialId` 已设则先试它；
  再试最新 `commit-uncertain` provisional；再试其他 `committed`；再试其余
  provisional。这保证崩溃-未修剪时绝不选中被吊销的前任，任意位置的 worker
  死亡都留下可重连状态——要么完成重连、要么重新配对，绝不困住客户端。
- 从未被 ack 或使用的 provisional server 凭据会过期（默认 10 分钟）。**server
  provisional 基数有界，不只是时间有界：** 每个
  `{principal, currentCommittedCredentialId}` 至多存在**一个**未决 provisional
  后继。对同一 `{principal, currentCommittedCredentialId}` 的重复 offer（例如
  worker 在存储上一个 offer 前死亡、客户端在未变的 committed 凭据上重试）MUST
  幂等地复用/替换那唯一槽位，而非累积 `P₁…Pₙ`；下面的 single-flight CAS 对
  并发轮换施加同一界限。
- **轮换**（在已认证 `/v1` 会话内运行同一流程）时：commit-new 与
  revoke-old MUST 是**单个持久化的 server 事务**（或启动时重放的轮换
  journal），确保崩溃绝不会留下两把都有效或两把都失效的状态。该事务是对
  principal 当前 committed `credentialId` 的 **compare-and-swap**，且 server
  按 principal **串行化轮换（single-flight）**：从同一旧凭据发起的两个并发
  轮换不可能都提交——后者会看到已变化的 current id 而被拒，因此只存在唯一
  后继。在「幂等重发」路径（对同一 `{principal, currentCommittedCredentialId}`
  在 offer 丢失后重复 offer）上，幂等意味着 server **重发它已持久在该唯一
  槽位中的同一 `{credentialId, mutualKey}`**——绝非新铸的替代——使存了上一个
  offer 的客户端与没存的客户端收敛到同一后继。
- **客户端绝不因未认证信号销毁凭据。** `authFailed`（§11）是任何 listener
  都能伪造的信道前消息，因此其本身 MUST NOT 删除任何存储凭据。重连时客户端
  按上述恢复顺序（先 `activeCredentialId`，再最新 `commit-uncertain`，再其他
  `committed`，再其余 provisional）。一旦建立起经认证的
  会话（双向 `reconnectAccept` 验证通过，§8），通过认证的那把即被证明存活，
  客户端此后 MUST 删除**该 principal 名下所有其他存储凭据与 pin**——认证后
  的修剪是强制而非可选，使被中断的轮换不会累积陈旧 mutual key。若某次重连
  没有任何存储凭据通过认证，则保留集留待重试；只有在用户主动要求或凭据被
  显式吊销时才回退到全新 code-entry 配对。在任何成功认证之前，客户端把每个
  principal 的保留集限制为**至多两条**——当前 committed 凭据与唯一最新的
  provisional 凭据。
- **provisional 过期是按状态的，绝非无条件。** 客户端 provisional 凭据带
  子状态：`unacked`（步骤 2 的持久 `unacked → commit-uncertain` write-ahead
  尚未发生）或 `commit-uncertain`（该 write-ahead 已持久，故 `credentialAck`
  **可能**已发出）。`unacked` 的 provisional MAY 在 **10 分钟**后老化删除——
  write-ahead 从未完成，故 ack 从未发出、server 从未 commit 它，与 server
  自身的 provisional 过期一致。`commit-uncertain` 的 provisional MUST NOT 被
  老化删除：ack 可能已到达 server，server 可能已原子地 commit 它并吊销旧凭据
  （§6.7 轮换），丢弃它会使客户端困在被吊销的凭据上。`commit-uncertain` 凭据保留至
  一次经认证的重连解出哪把存活（重连时先试它），再由上面的强制认证后规则
  提升或修剪。**孤儿清理（仅首配）：** 来自**首次配对**的 `commit-uncertain`
  凭据——其 principal 名下**没有**其他 committed 凭据，故无可被困住的对象——
  MAY 在 server 首配 provisional TTL（10 分钟）可证已过且无成功重连后移除：
  该窗口之后 server 已不可能持有它，故它不可用、可安全丢弃并重新配对。由
  **轮换**产生的 `commit-uncertain`（存在先前 committed 凭据）绝不老化删除，
  因为只有重连能证明 server 保留了两者中的哪一把。这既把陈旧密钥限界（每
  principal 两条），又保证 ack/commit 窗口内任意位置的 worker 死亡仍留下可
  重连状态（§6.7 两阶段提交所要求）。
  也使假 listener 无法靠重放 `authFailed` 诱使客户端丢弃唯一有效凭据。显式
  用户吊销 MUST 立即把存活会话标记为未授权，然后在移除展示/配对 bookkeeping
  之前，持久删除 `{browser, verifiedOrigin}` 与所选扩展身份匹配的全部
  committed 与 provisional 凭据。该持久撤销临界区一开始，server MUST 同步
  取消相同 verified Origin 的所有待完成 `/pair` 与 `/v1` 会话，并在临界区结束
  前拒绝其新 upgrade，防止已准入的握手在删除后签发或接管替代凭据。之后在
  可能时发送经认证的吊销通知并关闭存活 WebSocket；短暂的通知排空窗口不接受
  任何控制面请求，先前签发的 key 不能重连。
- 凭据 principal：`{browser, verifiedOrigin, clientInstallationId}`。第二个
  浏览器 profile 是**新的 principal**，作为新凭据配对；签发或轮换一个凭据
  MUST NOT 影响另一个。
- 过期或被吊销的凭据一律要求重新 code-entry 配对——绝不静默重新信任。

这与扩展既有的“先持久化、再发送 `motrix/initialized`”顺序保持一致。

### 6.8 MV3 service-worker 生命周期

PAKE 秘密只存在于 worker 内存。在受支持的 Chromium 上，打开的 `/pair`
WebSocket 会重置 worker 空闲计时器（见附录 B）；即便 worker 仍在配对中途
死亡，server 会将会话超时，nonce 与配对码随之作废，不留任何半成品凭据
（§6.7），popup 提供重试。实现 MUST 覆盖批准前、批准后两种 worker 死亡
测试。

---

## 7. 配对码

### 7.1 格式

- **字母表**：Crockford base32 — `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
  （32 个符号；排除 `I`、`L`、`O`、`U`）。
- **长度**：8 个符号 = 恰好 40 bit，取自 5 个 CSPRNG 字节：将 40 bit 按
  大端切成 8 组、每组 5 bit，逐组索引字母表。
- **展示**：大写、按 `XXXX-XXXX` 分组，**只**显示在 Motrix 审批对话框中。
  配对码即 PAKE 口令：MUST 绝不以任何形式经任何网络信道传输，MUST 绝不
  写入日志。
- **输入规范化**（扩展侧，本地校验之前）：去掉 ASCII 连字符与空格；转
  大写；映射 `O→0`、`I→1`、`L→1`；然后要求恰好 8 个字母表符号。本地校验
  失败的输入 MUST 在 popup 内直接拒绝、不产生任何网络流量（不消耗尝试
  次数）。

### 7.2 生命周期与尝试次数

- 每个配对会话一个配对码，在审批对话框排队时生成。
- 配对码在以下最早时点作废：生成后 **120 秒**、对话框被关闭、WebSocket
  关闭、或**第 3 次失败尝试**。
- **失败尝试**指会话上任何到达 `pakeA` 却**因任何原因**未达成双向
  confirmation 的协议运行——`cA` 错误、`ticketProof` 错误、`K` 为单位元、
  `pakeA` 之后的畸形点、协议中止、或 socket 中途关闭。尝试计数由双方独立
  记录（§6.5）；断连 MUST NOT 使计数低于该配对码已消耗的次数。
- 第 3 次失败后 server 发送 `pairError {code:"rateLimited"}`、关闭
  socket，并作废 nonce 与配对码。

### 7.3 全局 backoff 与弹窗上限

- 同一时刻至多**一个**审批对话框可见；超过 pending 上限（默认排队 3 个）
  的并发 `/pair` 请求在**任何会话变更之前**即以 `pairError {code:"busy"}`
  拒绝。pending-pair 去重以 verified origin 为 key。
- 全局失败计数器在任何**排队过对话框或至少消耗过一次尝试**的配对会话
  未以双向 confirmation 告终时递增——包括断连、中止、对话框被关闭、超时
  与耗尽。猜测者因此无法靠在配对码耗尽前关闭 socket 来躲开计数。第 `n`
  次（连续失败计）对话框之前，server 强制 `min(30 · 2^(n−1), 3600)` 秒的
  锁定期，其间新 `/pair` 会话一律以 `rateLimited` 拒绝。计数器在配对成功
  或 24 小时后重置。
- **客户端全局 backoff（与 server 计数器类比，但不同键）。** 扩展在
  `storage.local` 中维护**单一真正全局**的首配失败计数器——**对所有未认证
  首配目标共用一个计数器**，刻意**不**按 `instanceId`、`port` 或任何攻击者
  可控值分键（假 listener 每次返回新 `instanceId` 也绝不能换到新计数器；
  `instanceId` 从不是安全信号，§4.1）。其在任何到达 `pakeA` 却未达成双向
  confirmation 的首配会话上递增，包括扩展自己关闭 socket 主动放弃的会话。
  开始第 `n` 个（连续全局失败计）首配会话之前，扩展强制
  `min(30 · 2^(n−1), 3600)` 秒锁定，拒绝打开 `/pair` 并显示“稍后重试”状态；
  配对成功或 24 小时后重置。这是 server 计数器（§7.3）的客户端类比，抵御
  同一在线猜测攻击，只是二者计数时点略有不同——server 在带码对话框排队时
  递增，客户端在会话到达 `pakeA` 时递增。**已认证的、按 `instanceId`** 的
  重连失败子计数器 MAY 额外存在，但与本全局首配计数器分离、绝不替代它。
  两个客户端限制（每会话 ≤3 轮、本条全局 backoff）都与 server 报告的任何
  `attemptsRemaining` 无关地成立。
- 该计数器是进程生命周期状态；能重启 Motrix 的同 UID 攻击者不在威胁模型
  内（§1.1）。40 bit 码空间、每会话 3 次尝试加上述锁定表，在线猜测者的
  成功概率约为 `3·k / 2^40`（`k` 为会话数）——按上限每天不足约 700 个
  会话，即持续攻击每天约 2·10⁻⁹，且每个会话都需要受害者屏幕上一次新的
  用户批准对话框。

---

## 8. 重连 — `/v1` 上的 challenge–response

`/v1` upgrade 的 URL **不**携带任何凭据。`/v1` 上信道激活前的消息完全遵循
§6.1 的成帧规则：单个 WebSocket 文本帧、每帧恰好一个带 `type` 判别字段的
JSON 对象、二进制字段用 base64url、认证前 16 KiB 帧上限，未知 type、乱序
或重复消息、超大帧、schema 校验失败一律以 `protocolViolation` 中止。整个
challenge–response MUST 在 upgrade 后 **10 秒**内完成，否则 server 关闭
socket。upgrade 之后（Host 与 Origin 检查同 §4.3/§5），server 先发言：

```json
{ "type": "reconnectChallenge", "protocolVersion": 1, "S": "<b64url 32 CSPRNG bytes>" }
```

客户端应答：

```json
{ "type": "reconnectResponse", "credentialId": "<UUIDv4>",
  "C": "<b64url 32 CSPRNG bytes>", "mac": "<b64url 32 bytes>" }
```

其中重连 transcript 为

```
RT  = enc("MBP1/reconnect/v1") ‖ encU32BE(protocolVersion)
    ‖ enc(credentialId) ‖ enc(browser) ‖ enc(verifiedOrigin) ‖ enc(instanceId)
mac = HMAC-SHA-256(mutualKey, "MBP1-R/c" ‖ S ‖ C ‖ RT)
```

客户端侧的 `browser` 与 `verifiedOrigin` 取存储凭据 principal 的值，server
侧取当前连接的实际值；不一致即 MAC 失败（misbinding 属性）。server 以
constant-time 验证。成功后回复：

```json
{ "type": "reconnectAccept", "mac": "<b64url HMAC-SHA-256(mutualKey, \"MBP1-R/s\" ‖ S ‖ C ‖ RT)>" }
```

客户端 MUST 在**发送任何其他内容之前**验证 `reconnectAccept.mac`——假
listener 重放 `/discovery` 数据得不到任何可用信息，且客户端 MUST 把验证
失败视为“不是我的 Motrix”（清除端口 pin，回退到扫描 / 重新配对；绝不
静默重新信任）。

失败行为：对未知 `credentialId` 与错误 MAC，server MUST 表现完全一致——
ID 未知时用 dummy key 做 constant-time 验证、统一回复
`pairError {code:"authFailed"}` 后关闭——使该面不会成为凭据 ID oracle。
重连尝试按 verified origin 与全局双重限流。

Traffic key：

```
kC2S = HKDF-SHA-256(ikm=mutualKey, salt=S ‖ C, info="MBP1-traffic-c2s", L=32)
kS2C = HKDF-SHA-256(ikm=mutualKey, salt=S ‖ C, info="MBP1-traffic-s2c", L=32)
```

其后所有帧均 AEAD 包裹（§10）。MDXP `motrix/initialize` 仍是第一条应用
消息，现在位于 envelope 之内。

---

## 9. NM attestation ticket

浏览器会把调用方扩展的身份传给 NM host（Chromium：argv 中的 caller
origin；Firefox：扩展 ID 参数）。NM host 读取它并铸造一张一次性 ticket，
使 server 能解析 §5 的三态。这是 MBP1 中**唯一**的 ticket 类型。

### 9.1 Bootstrap 流程（扩展 ↔ host，NM stdio）

1. 扩展为本次 bootstrap 生成一个**临时 Ed25519 密钥对**（`bindingPriv`、
   `bindingPub`）。

   **Binding-key 校验（server 侧）。** `bindingPub` MUST 能解码为规范的
   RFC 8032 点编码，且**不是单位元、不是 small-order 点、位于素数阶子群**
   （torsion-free）；否则 ticket 无效。`ticketProof` MUST 以 **RFC 8032
   strict 模式——noble-curves 2.0.1 的 `zip215: false`** 验证：它强制规范
   `R` 编码与 `S < ℓ`，并拒绝 ZIP-215（宽松默认 `zip215: true`）会接受的
   可锻/非规范输入。MUST NOT 使用宽松的 ZIP-215 模式。注意 noble 的 strict
   模式仍检查 **cofactored** 群方程 `[8]·S·B = [8]·R + [8]·k·A`，并非
   cofactorless；MBP1 不依赖 cofactorless 相等。持有证明的安全性来自
   `bindingPriv` 保密**加上**上述 `bindingPub` 强制校验：若缺少
   small-order/torsion 检查，`bindingPub` = 单位元、`ticketProof` =
   (单位元 ‖ 0) 对任何消息都满足该方程，把 ticket 变成 bearer object——正是
   该校验将其封死。实现 MUST 把所有 small-order/torsion `bindingPub` 编码
   作为负例测试。知道 `bindingPriv` 的合法签名者仍可造出被 noble cofactored
   方程接受的 torsion 微扰签名（`R = rB + T`、`S = r + k·a`）；这是
   **conformance caveat，不是伪造**（需要私钥），因此向量 MUST NOT 断言其
   被拒。
2. 扩展 → host：`{ "action": "bootstrap", "protocolVersion": 1,
   "bindingPub": "<b64url 32 bytes>" }`。
3. host 读取 `endpoint.json`（0600 owner-only——这份文件所有权*就是*
   attestation 信任根；Windows 对应物是 owner = 当前用户，且 DACL 只向该
   用户、`LocalSystem` 与 `BUILTIN\Administrators` 授权，对无法证明无害的
   ACE 类型一律 fail closed），对记录端口做存活检查（TCP / `/discovery` 探测；
   未认证即足够——MBP1 客户端会在下游自行认证 server），必要时唤醒
   Motrix，经 `POST /nonce` 取得新 nonce，铸造 ticket，然后应答：
   `{ "action": "requestPair", "protocolVersion": 1, "port": <n>,
   "nonce": "<...>", "nmTicket": { ... } }`。
4. 扩展把 ticket 连同 `ticketBindingKey = bindingPub` 放进
   `pairHello.nmTicket`，随后通过 `confirmA.ticketProof`（§6.5）证明持有
   `bindingPriv`。该绑定使 ticket 无法被重放到持有该私钥的握手之外的任何
   握手上。

host MUST NOT 向扩展暴露 `localToken`，MUST NOT 记录 ticket 材料，且不持有
`clientInstallationId`（由 PAKE transcript 绑定）。

### 9.2 Ticket 格式

Wire 形态（JSON，位于 `pairHello` 内）：

```json
{ "v": 1, "purpose": "mbp1-attestation", "protocolVersion": 1,
  "serverGeneration": "<UUID>", "browser": "chromium" | "firefox",
  "callerId": "<verified caller identity from the browser>",
  "exp": 1755600000, "bindingPub": "<b64url 32 bytes>",
  "mac": "<b64url 32 bytes>" }
```

规范 MAC 输入（字段顺序固定，与 JSON key 顺序无关）：

```
ticketKey = HKDF-SHA-256(ikm=UTF8(localToken), salt="MBP1/nm-ticket/v1",
                         info="mac", L=32)
mac = HMAC-SHA-256(ticketKey,
        enc("mbp1-attestation") ‖ encU32BE(v) ‖ encU32BE(protocolVersion)
      ‖ enc(serverGeneration) ‖ enc(browser) ‖ enc(callerId)
      ‖ encU64BE(exp) ‖ enc(bindingPub raw 32 bytes))
```

除 `mac` 自身外，ticket 的每个 wire 字段——包括格式版本 `v`——都被 MAC
覆盖，任何字段都无法被单独调换。MAC 开头的 `enc("mbp1-attestation")` 是
固定域标签，不是 wire 上的 `purpose`；wire 上的 `purpose` 值改由 §6.4 的
AAD ticket digest 钉死（该 digest 哈希 ticket **各字段解析值的规范编码**，
按 §6.4，而非原始 JSON 序列化），因此篡改 `purpose`（或任何其他 wire 字段）
会使双方 AAD 失配、让 key confirmation fail closed，而不仅是降级。

**校验在 `pairHello` 处进行，先于 key confirmation**——server 对它实际收到的
ticket 校验，绝不等到字节一致被证明。`pairHello` 另要求 `nmTicket.browser ==
pairHello.browser`（为另一浏览器铸造的 ticket 不绑定本会话）。

**检查顺序具规范性：先验 `mac`。** `ticketKey` 仅由 `localToken` 派生，故
`localToken` MUST 跨 bridge 重启持久——只有 `serverGeneration` 轮换。server
在任何其他检查之前先用当前 `localToken` 派生的 `ticketKey` 重算 `mac`；`mac`
失败立即中止，只有 `mac` 有效的 ticket 才进入 generation / `exp` / `callerId`
检查。这正是让由**先前** server generation 铸造的诚实 ticket（在持久
`localToken` 下 `mac` 有效、`serverGeneration` 陈旧）解析为语义 `unverified`
**降级**、而非被误判为 bad-`mac` 中止的原因；反之真正伪造的 `mac` 无论其
generation 字段如何都中止。由于没有经认证的铸造时间戳，`exp` 约束是**剩余
寿命**上限（`exp ≤ now + 60 秒`），并非对原始铸造时刻的证明。

**每种结果都有定义——下表穷尽。** 每个检查恰好映射到三种处置之一：**中止**
（`pairError`，不配对）、**降级**（以低于 `official` 的身份继续）、或**延后**
（在流程后续判定）。

| Ticket 条件 | 处置 |
|---|---|
| `mac` constant-time 重算失败 | **中止**（`protocolViolation`） |
| `v` / `purpose` / `protocolVersion` 不精确 | **中止**（`protocolViolation`） |
| `bindingPub` 未过 §9.1（畸形、单位元、small-order、非 torsion-free） | **中止**（`protocolViolation`） |
| `bindingPub != pairHello.ticketBindingKey` | **中止**（`protocolViolation`） |
| `callerId != pairHello.claimedExtensionId` | **中止**（`protocolViolation`） |
| `nmTicket.browser != pairHello.browser` | **中止**（`protocolViolation`） |
| ticket MAC 曾出现过（一次性重放） | **中止**（`protocolViolation`） |
| `exp` 距当前超过 60 秒（剩余寿命 > 60 秒） | **中止**（`protocolViolation`） |
| 真实 ticket，`serverGeneration` 未知/过期 | **降级** → `unverified` |
| 真实 ticket，`exp` 已过（过期） | **降级** → `unverified` |
| 真实且有效 ticket，`callerId` 不在 allowlist | **降级** → `attested-non-official`（§5） |
| 真实且有效 ticket，`callerId` 在 allowlist | `official`（§5） |
| `confirmA.ticketProof` schema 非法（非 64 字节） | **延后** → `protocolViolation`（§6.5） |
| `confirmA.ticketProof` 格式合法但 strict 验证失败 | **延后** → `codeMismatch`，消耗一次尝试（§6.5/§7.2） |

对最影响安全的两条结构性规则的理由：

- **结构性/密码学失败中止而非降级。** 合法扩展绝不出示这种 ticket，而在途
  修改早已被 §6.4 的 AAD 绑定在 key confirmation 处拦截。中止解决了 §6.5
  要求有效 `ticketProof`、而无效 `bindingPub` 永远无法满足的矛盾。结构校验
  发生在审批对话框**之前**、不触碰弹窗/失败计数器，故不放大 DoS 面；被损坏
  的合法 ticket 只导致自愈式重新 bootstrap，绝非凭据泄露。
- **`ticketProof` 验证不是 `pairHello` 的结果。** server 在 `pairHello` 处
  无法得知“证明验证通过”——证明在 `confirmA`（§6.5）到达。故 §9.2 只校验
  *ticket*，证明的结果如上表末两行延后到 §6.5。

两条边界规则：

- **与 §5 的优先级**：ticket 的身份贡献只能*抬升*身份，绝不降低——allowlist
  中的 Chromium verified origin 无论有无 ticket 都成立 `official`。但**结构性
  中止优先于身份**：若*已出示*的 ticket 命中上表任一中止行，即使调用方本可凭
  verified origin 成为 `official`，配对也中止（合法官方调用方绝不出示结构损坏
  的 ticket，客户端只需无 ticket 重新 bootstrap）。**不**出示 ticket 的调用方
  不受影响——其身份单凭 origin 按 §5 判定。
- **篡改不是降级**：由于 ticket digest 被绑入 PAKE AAD（§6.4），传输中被
  修改的 ticket 会使双方 AAD 失配、破坏 key confirmation、使配对 fail
  closed——在途篡改绝不会静默变成语义降级。

`callerId` 取值：Chromium — 从 argv 的 `chrome-extension://<id>/` origin
提取的 32 字符扩展 ID；Firefox — Gecko ID 参数。ticket 证明*是哪一个*
扩展在调用；是否*官方*由 allowlist 决定（§5）。

---

## 10. AEAD envelope

在 `/pair` 上自 §6.6 起、在 `/v1` 上自 §8 起激活，双向、覆盖**每一帧**。
envelope 位于 MDXP 之下：MDXP JSON-RPC 载荷字节即明文，原样不动。

```
frame     = seq64BE ‖ AES-256-GCM(key = k_dir, nonce, plaintext, aad)
nonce     = dirTag(4 字节 BE) ‖ seq64BE          （12 字节）
dirTag    = 0x00000001（client→server）| 0x00000002（server→client）
aad       = "MBP1/env/v1"（ASCII，11 字节）
```

- 帧是 WebSocket **二进制**消息；一条消息一帧。
- `seq` 每方向从 0 开始、每帧恰好加 1。接收方 MUST 要求 `seq` 等于本地
  期望计数（严格单调、无窗口）；任何跳号、重复或 GCM 认证失败 MUST 立即
  关闭连接（`envelopeViolation`）。这就是重放保护：重放 = 严格序号检查。
- key 按方向独立（§6.6/§8），nonce 唯一性对每个 key 由构造保证。但唯一性
  不等于用量上界：连接 MUST 在任一方向超过 **2^24 帧**或 **2^30 个已加密
  AES block（16 GiB 明文）**（以先到者为准）之前关闭——经重连重建、派生
  新 key。这组上界把 AES-GCM 机密性/完整性的合计 advantage 稳稳压在
  TLS 1.3 分析（RFC 8446 §5.5；另见 RFC 9053 §4.1.1）使用的 ≈2^-57 目标
  之下；MDXP 控制流量比它们低若干数量级。v1 不做原地 rekey。
- 单帧明文上限 1 MiB。server 的 WebSocket parser MUST 把单条消息限制在对应的
  最大 envelope 大小（1 MiB + 8-byte sequence + 16-byte tag），替换 transport
  更大的默认值，使未认证对端无法先迫使其缓冲超大消息。配对/重连状态机仍独立
  执行更严格的 16 KiB 认证前帧限制。信道激活后的文本帧是协议违例。

由于 envelope key 源自 PAKE 或凭据派生，即使观察了完整握手，假端点或中继
端点依然无法读取或修改 URL、cookie、header 或命令。

---

## 11. 错误与关闭语义

`pairError`（`/pair` 与 `/v1`，信道激活前）：

```json
{ "type": "pairError", "code": "<code>", "attemptsRemaining": 2 }
```

| Code | 含义 | 备注 |
|---|---|---|
| `unsupportedVersion` | `protocolVersion` ≠ 1 | fail closed，无协商 |
| `busy` | pending-pair 上限或去重命中 | 发生在任何会话变更之前 |
| `rateLimited` | 全局 backoff 或尝试耗尽 | §7.3 |
| `codeMismatch` | key confirmation 失败 | 携带 `attemptsRemaining` |
| `expired` | nonce 或配对码超时 | |
| `aborted` | 用户关闭了对话框 | |
| `authFailed` | `/v1` challenge–response 失败 | 未知 ID 与错误 MAC 表现一致 |
| `protocolViolation` | 畸形/乱序帧、非法点编码、超大帧 | 立即关闭 |
| `pairingFailed` | 内部失败（如 `w = 0`） | 通用 |

除用户需要的 `codeMismatch`/`attemptsRemaining` 之外，server MUST NOT 泄露
内部失败发生在哪一步。实现 MUST NOT 在任何日志级别记录配对码、`w`、PAKE
中间值、key、MAC 或 ticket。

**WebSocket 关闭码。** AEAD 信道激活之后不再有 `pairError`——§10 的违规与用量
上限都通过关闭连接来报告：

| Code | 含义 | 客户端动作 |
|---|---|---|
| `1002` | 任何 §10/§11 协议违规。统一码：从不指明是哪一项检查失败。 | 视本次尝试失败。 |
| `4001` | 达到了 §10 的单方向用量上限（2^24 帧或 2^30 个加密块）。双方都没有失当。 | 按 §8 重连并导出新密钥。 |
| `1011` | 关闭方自身的真实内部故障。 | 视为对端缺陷。 |

尝试在 outbound 方向 seal 超过 1 MiB 明文上限的数据，是本地进程的内部故障，
而非对端协议违规，因此以 `1011` 关闭；被拒绝的应用帧 MUST NOT 让会话继续存活。

`4001` 位于 [RFC 6455] §7.4.2 为应用间约定保留的私有段；没有合适的标准码可用——
`1002` 会指控对端犯了并未发生的违规，而 `1011` 会把一个例行的、规范要求的转换
说成缺陷。

只有 server 能发出全部三个码：浏览器的 WebSocket API 拒绝 1000/3000–4999
之外的一切关闭码，因此扩展客户端在自身 §10 用量上限触发时发送 `4001`，其余
故障一律裸关闭（对端收到 `1005`，"no status received"）。这种不对称之所以
合规，正是因为下一条规则。

**客户端 MUST NOT 依据关闭码分支。** 已建立的 envelope 信道的任何关闭都意味着
"按 §8 重建",一个从不知晓这些数字的合规客户端行为依然正确——这些码的作用是让
日志可读,而不是承载协议状态。实现 MUST NOT 赋予 `4001` 其他含义。

---

## 12. 凭据与 pin 生命周期（扩展侧）

- `PinStore` 是以 `credentialId` 为 key 的带版本存储，保存
  `{port, instanceId}`。pin **只在**该端口上完成双向认证会话之后提交——
  绝不因 `/discovery` 提交。
- pinned 端口不匹配 → 对匹配 `instanceId` 做全候选段扫描 → 仅在认证后
  重新提交；否则清除 pin，回退到全新 code-entry 配对。
- `storage.local` 凭据条目携带 `state: "provisional" | "committed"`、
  provisional 的 `unacked` / `commit-uncertain` 子状态（§6.7），外加一个与
  `committed` 转变**原子写入**的 `activeCredentialId` 指针。重连恢复顺序：
  若已设则先试 `activeCredentialId`，再试最新 `commit-uncertain` provisional，
  再试其他 `committed`，再试其余 provisional（崩溃-未修剪留下的两条 `committed`
  由指针消歧，绝不靠猜）。凭据**只在经认证的会话证明哪一把存活
  之后**才删除（§6.7）；信道前的 `authFailed` 本身绝不删除凭据，因此伪造的
  `authFailed` 无法使客户端陷入无凭据可用。当没有任何存储凭据通过认证时，
  保留集留待重试，仅在用户主动操作或凭据被吊销时才回到首次配对。保留状态
  有界：每个 principal 至多保留 committed 凭据加最新一条 provisional。
  provisional 条目带子状态（§6.7）：`unacked` 的 10 分钟后过期，而
  `commit-uncertain` 的（其 `credentialAck` 已发出、server 可能已 commit）
  绝不老化删除——保留并在重连时先试它，直至经认证的会话解出为止。一次成功
  认证 MUST 删除该 principal 名下其他所有凭据及其 `PinStore` 条目，使被中断
  的轮换既不留无界陈旧密钥、也绝不让客户端困在被吊销的凭据上。

---

## 13. 测试向量

跨实现向量具有规范性，位于本文档旁的
[`bridge-pairing-protocol-vectors.json`](./bridge-pairing-protocol-vectors.json)。
两个仓库的 CI（以及 ticket 向量对应的 Rust native host）MUST 对照其校验。
文件包含（字节串一律 hex 编码）：

1. **`spake2`** — 固定输入（`code`、`pairNonce`、身份，以及像 RFC 向量
   一样直接给出的标量 `w`、`x`、`y`）下的完整 edwards25519 首配运行及期望
   的 `pA`、`pB`、`K`、`TT`、`Ke`、`Ka`、`KcA`、`KcB`、`cA`、`cB`、traffic
   key。由于 [RFC 9382] Appendix B 只提供 P-256 向量，通用 SPAKE2 核心的
   实现 MUST 另行通过**全部四组** RFC P-256 向量，以先证明核心组合（TT
   布局、key schedule）正确，再信任 edwards25519 实例化。
2. **`scryptW`** — 配对码规范化与 `w` 派生（§6.2）。
3. **`reconnect`** — `RT`、客户端与 server MAC、traffic key（§8）。
4. **`nmTicket`** — `ticketKey` 派生、规范 MAC 与 `ticketDigest`（§9.2/§6.4），
   外加 **weak binding-key 拒绝用例**：单位元、其他 small-order 点、以及
   **dirty（非 torsion-free）** `bindingPub` MUST 被 §9.1 校验拒绝；单位元
   密钥伪造 `(R = identity, S = 0)` MUST 失败；`S ≥ ℓ` 与非规范 `R` 签名
   MUST 被 strict 验证拒绝；篡改任一 wire 字段（含 `mac`、`purpose`）MUST
   经 §6.4 的 AAD 绑定使 key confirmation fail closed。
5. **`envelope`** — 给定 key/明文下的 AEAD 帧，含期望拒绝用例：错误序号、
   篡改密文、以及**仅翻转 dirTag**（key 不变）的用例——忽略 `dirTag` 的
   实现无法蒙混过关。

向量文件之外，实现测试套件 MUST 覆盖向量无法表达的有状态用例：双侧的
尝试上限（§6.5/§7.2）、跨断连的全局计数（§7.3）、以及轮换的崩溃点
（§6.7）。

向量由随 Phase-A 实现一并入库的参考脚本生成；在记录的输入下重新生成 MUST
是确定性的。

---

## 14. 审查与实现 gate

1. 在编写任何 MBP1 协议代码之前，本文档 MUST 通过一次**独立密码学审查**。
   **已满足**——六轮独立对抗审查（2026-08-19），每轮均重新确认 0 High；末轮
   清除最后一个 Medium，仅余跟踪到实现的 Low 项。完整审查记录（审查人、
   日期、发现、处置）见附录 C。
2. 实现 MUST 以精确版本锁定 `@noble/curves`（2.0.1）与 `@noble/hashes`
   （2.0.1），并记录其对应的审计依据（§3）。
3. 附录 B 中的事实在 Phase-A 发布前 MUST 对照实际最低版本浏览器构建矩阵
   （Chrome 120、Firefox 121）重新验证；它们引自厂商文档，而非本仓库自身
   的证据。

---

## 附录 A — 安全属性与验收标准

重放真实 `instanceId` 的恶意 loopback listener 必须无法获得：配对码、任何
凭据、完成的 MDXP initialize、任何下载提交。具体地：

- **终结型 MITM**（与两侧各跑一场 PAKE）在没有配对码时无法产生两把确认
  过的 key；带对抗性密钥生成的 grinder 测试 MUST 失败。SPAKE2 没有可
  研磨的短公开摘要，SAS 式比对上的 chosen-key 碰撞攻击不适用。
- **透明中继**既得不到明文也得不到有效凭据（AEAD 篡改/读取测试）；其
  留在路径中的能力按威胁模型（§1.1）属范围之外，不是通过的验收项。
- **Transcript misbinding** — 双方之间任何 origin、browser、ID、版本、
  nonce 或 binding key 的调换 MUST 破坏 key confirmation（§6.4/§6.5）或
  重连 MAC（§8）。
- **握手后完整性** — 帧篡改、乱序、重放或跨方向反射 MUST 关闭连接
  （§10）。
- **在线猜测** — 受**双侧独立执行**的每会话 3 次尝试、防断连规避的尝试
  计数、以及全局锁定表约束（§6.5/§7.2/§7.3）；对端提供的
  `attemptsRemaining` 绝不放宽本地限制。
- **Ticket 重放与伪造** — 一次性缓存、60 秒过期、generation 绑定、带
  strict 验证与 small-order/torsion 拒绝的 Ed25519 持有证明（§9.1）、
  以及绑入 AAD 的 ticket digest（§6.4），使被截获或被篡改的 ticket 无法
  用于任何其他握手或 server generation；small-order `bindingPub` 伪造
  MUST 被拒绝。
- **AEAD 用量上界** — 会话在任一方向到达 2^24 帧或 2^30 个加密 block
  之前关闭（§10）。

## 附录 B — 经外部验证的浏览器事实

于 2026-08-19 对照厂商文档验证；按 §14.3 在构建矩阵上复核。

| 事实 | 取值 | 来源 |
|---|---|---|
| WebCrypto X25519 可用性 | Chrome/Edge 133+、Firefox 130+、Safari 17+ —— **高于**扩展最低版本（Chrome 120 / Firefox 121），故捆绑 noble-curves | [caniuse: SubtleCrypto X25519](https://caniuse.com/mdn-api_subtlecrypto_importkey_x25519) |
| Firefox MV3 host permissions | Firefox 127 之前 MV3 host permissions **不**在安装时授予；127 起显示在安装提示中并授予，但用户随时可撤销，且更新新增的 host permissions 不会提示 | [Mozilla Add-ons blog, "Manifest V3 updates" (2024-05-14)](https://blog.mozilla.org/addons/2024/05/14/manifest-v3-updates/) |
| MV3 service-worker keepalive | Chrome 116 起 WebSocket 活动会重置 30 秒 service-worker 空闲计时器；keepalive 需在每个 30 秒窗口内交换一条消息 | [Chrome developers: WebSockets in service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) |
| 扩展最低版本 | `minimum_chrome_version: "120"`，Gecko `strict_min_version: "121.0"` | `motrix-extension/packages/ext/manifest.config.ts` |

Firefox 两行的推论：扩展在探测 loopback 之前 MUST 先检查
`permissions.contains({origins:["http://127.0.0.1/*"]})`，缺失时在用户手势
内请求，被拒时展示明确的降级状态。验收矩阵覆盖 Firefox 121–126、127+ 与
手动撤销。

## 附录 C — 审查日志

| 轮次 | 日期 | 审查方 | 结论 | 摘要 |
|---|---|---|---|---|
| 1 | 2026-08-19 | 独立对抗性密码学审查（Codex） | NOT APPROVED — 0 High / 4 Medium / 6 Low | SPAKE2 构造与全部已发布向量被独立复现为正确。Medium：单侧尝试计数（M1）、缺乏依据的 2^40 帧 GCM 上限（M2）、ZIP-215/small-order `bindingPub` 伪造（M3）、非事务性轮换（M4）。Low：ticket `v` 未入 MAC 且 ticket 未绑 AAD、标量采样表述不均匀与 `w = 0` 概率错误、HKDF traffic label 复用、负例向量覆盖不足、`/v1` 信道前成帧未规定、依赖版本未真正锁定。 |
| 1-rev | 2026-08-19 | 规范修订 | 发现已处理 | 双侧尝试限制与防断连规避的计数（§6.5/§7.2/§7.3）；2^24 帧 / 2^30 block AEAD 上界（§10）；strict Ed25519 验证加规范/small-order/torsion-free `bindingPub` 校验与负例（§9.1）；事务性轮换与确定性客户端恢复（§6.7/§12）；ticket `v` 入 MAC、ticket digest 绑入 AAD、篡改 fail-closed 与 §5 优先级（§6.4/§9.2）；拒绝采样标量与概率修正（§6.3/§6.2）；pair/reconnect HKDF label 区分（§6.6）；RFC P-256 全四组向量、dirTag 单独负例与 weak-key 负例（§13）；`/v1` 成帧与 deadline（§8）；noble 精确锁定与审计依据要求（§3）。 |
| 2 | 2026-08-19 | 独立复审（Codex） | NOT APPROVED — 0 High；M2/M3/L2/L3/L5/L6 已闭合；M1/M4/L1/L4 部分；新增 1 Low（N1） | M1：客户端全局 backoff 未充分规定。M4：（1）未认证的 `authFailed` 可能删除客户端唯一有效凭据；（2）缺少针对并发轮换的 single-flight/CAS。L1：MAC 硬编码 `purpose`、AAD 遗漏单独的 `ticketBindingKey`，这两个字段只降级而非 fail closed。L4：缺少 dirty-torsion / 非规范 `R` / `S ≥ ℓ` 负例。N1：noble 2.0.1 的 `zip215:false` 用 cofactored 方程，故“cofactorless”措辞不准确。 |
| 2-rev | 2026-08-19 | 规范修订 | 发现已处理 | 客户端全局 backoff 规定；轮换 single-flight CAS；客户端绝不因未认证 `authFailed` 删除凭据；AAD 绑定 `ticketBindingKey` 加覆盖 ticket wire 字段的 `ticketDigest`；验证措辞更正为 RFC 8032 strict（cofactored）；向量新增 dirty-torsion / `S ≥ ℓ` / 非规范 `R` / 逐字段篡改负例。 |
| 3 | 2026-08-19 | 独立复审（Codex） | NOT APPROVED — 0 High；M4(1)/M4(2)/L1/N1 已闭合；M1 部分（Medium blocker）；L4 部分（Low blocker）；新增 2 Low | M1：客户端计数器按攻击者可控的 `instanceId` 分键，假 listener 每次返回新 `instanceId` 即得新计数器。L4：向量对 `S ≥ ℓ` / 非规范 `R` 只有描述（无恶意字节），且仅覆盖两个小阶点编码。新 Low：认证后修剪只是 `MAY`、客户端 provisional 凭据无过期/上界（陈旧密钥增长）。新 Low：§6.4 措辞称未在 allowlist 的 `callerId` 降级为 `unverified`（与 §5/§9.2 的 `attested-non-official` 矛盾），并暗示校验只在字节一致后才进行。 |
| 3-rev | 2026-08-19 | 规范修订 | 发现已处理 | 客户端首配 backoff 改为单一真正全局计数器（§7.3）；认证后修剪强制、保留集限界（§6.7/§12）；§6.4 身份/编码措辞更正；向量以真实恶意字节覆盖 `S ≥ ℓ` / 非规范 `R`、完整小阶点集与全字段篡改自检（§13）。 |
| 4 | 2026-08-19 | 独立复审（Codex） | NOT APPROVED — 0 High；M1/L4 已闭合；1 Medium + 2 Low | Medium：无条件 10 分钟客户端 provisional 过期可能在轮换中删除 server 已 commit 的 `commit-uncertain` 凭据，使客户端困在被吊销的凭据上。Low：§9.2 仍称 digest 逐字节哈希 wire 字段、且只有字节一致的 ticket 才“走到校验”，与 §6.4 的规范解析规则及 pairHello 顺序矛盾。Low：§9.2 笼统的“任何校验失败→降级、不中止”与 §6.5/§9.1 冲突（无效/small-order `bindingPub` 使必需的 `ticketProof` 不可能成立）。全局计数器首配 griefing 评为可接受的可用性残留（§1.1）；多 profile 修剪判定为正确。 |
| 4-rev | 2026-08-19 | 规范修订 | 发现已处理 | 按状态的 provisional 过期；§9.2 规范解析 digest、pairHello 顺序校验、中止/降级拆分。 |
| 5 | 2026-08-19 | 独立复审（Codex） | NOT APPROVED — 0 High；round-4 Low 措辞已闭合；1 Medium（持久顺序）+ 3 Low | Medium：崩溃一致性顺序不完整——`commit-uncertain` 未要求在发送 `credentialAck` **之前**先持久完成 `unacked → commit-uncertain` write-ahead，重连提升也未要求 server 在发送 `reconnectAccept` **之前**先持久提升/CAS 吊销；两处缝隙的崩溃仍可能困住客户端。Low：server provisional 后继只时间有界、无基数界（重复崩溃的 offer 可累积 `P₁…Pₙ`）。Low：§9.2 结果拆分不穷尽（重放 MAC、`callerId`/`bindingPub`/`browser` 不匹配、`exp` 过长、以及 `ticketProof` 验证失败情形未定义或未归类）。构造与全部向量独立复核；无 High。 |
| 5-rev | 2026-08-19 | 规范修订 | 发现已处理 | 客户端在 `credentialAck` 前 write-ahead；server 在 `reconnectAccept` 前持久提升/CAS 吊销；server provisional 限界、幂等重发；§9.2 结果表穷尽、加 `browser` 检查与延后。 |
| 6 | 2026-08-19 | 独立复审（Codex） | NOT APPROVED — 0 High；1 Medium + 4 Low | Medium：客户端 committed 写入后、修剪前崩溃可能留下两条 `committed` 而 active 指针仍指向前任，恢复未定义如何选择——合规客户端可能在被吊销的凭据上循环。Low：journal 替代方案需「重放先于 `/v1`」屏障；「幂等重发」定义不足；首配孤儿 `commit-uncertain` 清理未定义；§9.2 缺 MAC-first 检查顺序（诚实的先前 generation ticket 可能被误判）且过度声称「铸造窗口」。构造与全部向量独立复现；无 High。审查者：Medium 修复后 Low 项可延后到实现跟踪、gate 即可视为满足。 |
| 6-rev | 2026-08-19 | 规范修订（本文档） | 发现已处理；gate 满足 | 客户端在修剪前于**一次原子持久写入**中同时写 `committed` **与** `activeCredentialId`，恢复先试 `activeCredentialId`，使崩溃-未修剪由指针消歧、绝不靠猜（§6.7/§12）。journal 重放 MUST 在 `/v1` 接受认证前完成；「幂等重发」重发已存的同一 `{credentialId, mutualKey}`；首配孤儿 `commit-uncertain`（无 committed 兄弟）可在 10 分钟 server provisional TTL 后清理（§6.7）。§9.2 固定 MAC-first 顺序、要求 `localToken` 持久而只 `serverGeneration` 轮换、并把 `exp` 重述为剩余寿命上限。**六轮独立对抗审查均重新确认 0 High；Medium 已闭合；残留 Low 项跟踪到实现。编码前密码学审查 gate 满足。** |
| Dep-pin | 2026-08-20 | Maintainer（依赖审计依据记录，§14.2） | 已记录——diff 审阅待确认 | 在 TypeScript 实现中精确锁定 `@noble/curves@2.0.1` 与 `@noble/hashes@2.0.1`（§3）。审计依据：Cure53 2024 年 9 月的审计基于 `@noble/curves` 1.6.0；该依据的第二支柱——对从 1.6.0 到 2.0.1 的上游 diff 的 maintainer 审阅——**待 Phase-A 发布前确认**，目前尚未进行该审阅。 |

[RFC 9382]: https://www.rfc-editor.org/rfc/rfc9382
[RFC 5869]: https://www.rfc-editor.org/rfc/rfc5869
[RFC 8032]: https://www.rfc-editor.org/rfc/rfc8032
[RFC 7914]: https://www.rfc-editor.org/rfc/rfc7914
[RFC 4648]: https://www.rfc-editor.org/rfc/rfc4648
