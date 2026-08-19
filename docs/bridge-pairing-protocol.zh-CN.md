# Motrix Bridge 配对协议 — MBP1

规范性文档，版本 1（`protocolVersion = 1`）。

本文档定义 Motrix 浏览器扩展与 Motrix bridge server 之间配对与认证的 wire
契约，并把所有密码学参数钉死到字节级。**MUST**、**MUST NOT**、**SHOULD**、
**MAY** 按 RFC 2119 / RFC 8174 的含义使用。

状态：**草案，待独立密码学审查**。审查完成前 MUST NOT 开始实现本协议（见
[§14](#14-审查与实现-gate)）。

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
独立审计的库并以**精确版本**锁定：TypeScript 侧为 `@noble/curves`（不低于
1.6.0 —— Cure53 2024 年 9 月的审计覆盖 ed25519）与 `@noble/hashes`。MUST NOT
使用 WebCrypto 的 X25519/Ed25519：其要求 Chrome 133 / Firefox 130，而扩展
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

### 4.1 `GET /discovery`

未认证、可重放，**只是 hint，绝不是信任决策**。响应
（`Cache-Control: no-store`）：

```json
{ "app": "motrix-bridge", "apiVersion": 1,
  "instanceId": "<persisted per-install UUID>", "appVersion": "2.0.0-beta.20" }
```

`instanceId` 是路由 hint，用于决定优先探测哪个候选端口，MUST NOT 当作安全
信号。扩展 MUST 只在该端口上完成双向认证的 MBP1 会话之后才提交端口 pin。

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
唯一。若 `w = 0`，以 `pairingFailed` 中止（概率 ≈ 2^-188；不附带重试语义）。
512 位散列 mod ℓ 的偏差可忽略（RFC 9382 §3.2 只要求多 64 位）。scrypt 是
RFC 推荐的 MHF；每次尝试只需计算一次，同时也彻底封死在配对码存活期内对
主动攻击 transcript 记录的离线穷举。

### 6.3 SPAKE2 计算

按 [RFC 9382] §3.3，A = 扩展，B = Motrix：

- A 抽取 `x`：64 个 CSPRNG 字节，`x = OS2IP(bytes) mod ℓ`，为 0 则重抽。
  `X = x·P`，`pA = w·M + X`。
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
AAD = encU32BE(protocolVersion) ‖ enc(pairNonce) ‖ enc(bindingPubOrEmpty)
```

其中 `bindingPubOrEmpty` 在携带 `nmTicket` 时为 `ticketBindingKey` 的原始
32 字节，否则为空串。

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
Ed25519 签名，用 ticket 的 `bindingPub` 验证）。A MUST 在发送任何后续内容
之前验证 `cB`。两处验证均为 constant-time。验证失败计为一次**失败尝试**
（§7.2），B 回复 `pairError {code:"codeMismatch", attemptsRemaining}` ——
其后（配对码仍存活时）MAY 在同一连接上以全新 `x` 发起新一轮 `pakeA`。

### 6.6 配对会话 traffic key

双向 confirmation 之后：

```
kC2S = HKDF-SHA-256(ikm=Ke, salt="MBP1/pair/v1", info="MBP1-traffic-c2s", L=32)
kS2C = HKDF-SHA-256(ikm=Ke, salt="MBP1/pair/v1", info="MBP1-traffic-s2c", L=32)
```

连接上其后的所有帧、双向——凭据消息与 MDXP 一视同仁——都在 AEAD envelope
（§10）内传输。

### 6.7 凭据签发 — 两阶段提交

在 AEAD 信道内：

1. **B→A `credentialOffer`** `{ "type": "credentialOffer", "credentialId":
   "<UUIDv4>", "mutualKey": "<b64url 32 CSPRNG bytes>" }`。server 在发送
   **之前**先以 `provisional` 状态持久化该凭据。
2. **A** 把 `{credentialId, mutualKey, state:"provisional"}` 写入
   `storage.local`，然后发送 **`credentialAck`**
   `{ "type": "credentialAck", "credentialId": "<same>" }`。
3. **B** 持久化标记该凭据为 `committed`，然后发送
   **`credentialCommitted`** `{ "type": "credentialCommitted" }`。A 将本地
   副本标记为 `committed`。

原子性规则：

- server 侧的 provisional 凭据同样可用于重连认证（§8）；一次成功的
  challenge–response 本身就是经认证的确认，会在双侧把它提升为
  `committed`。因此 worker 在流程任意点死亡都不会留下不可用的半状态：
  要么双方都能完成重连，要么客户端重新配对。
- 从未被 ack 或使用的 provisional server 凭据会过期（默认 10 分钟）。
- **轮换**（在已认证 `/v1` 会话内运行同一流程）时，旧凭据**只在**新凭据
  达到 `committed`/提升之后才失效。吊销会关闭存活会话。
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
- **失败尝试**指会话上任何到达 `pakeA` 却未达成双向 confirmation 的协议
  运行（`cA` 错误、`ticketProof` 错误、`K` 为单位元、`pakeA` 之后的畸形
  点）。尝试计数按会话、在 server 侧记录。
- 第 3 次失败后 server 发送 `pairError {code:"rateLimited"}`、关闭
  socket，并作废 nonce 与配对码。

### 7.3 全局 backoff 与弹窗上限

- 同一时刻至多**一个**审批对话框可见；超过 pending 上限（默认排队 3 个）
  的并发 `/pair` 请求在**任何会话变更之前**即以 `pairError {code:"busy"}`
  拒绝。pending-pair 去重以 verified origin 为 key。
- 全局失败计数器在任何配对会话以配对码耗尽或未获批准过期告终时递增。第
  `n` 次（连续失败计）对话框之前，server 强制 `min(30 · 2^(n−1), 3600)`
  秒的锁定期，其间新 `/pair` 会话一律以 `rateLimited` 拒绝。计数器在配对
  成功或 24 小时后重置。
- 该计数器是进程生命周期状态；能重启 Motrix 的同 UID 攻击者不在威胁模型
  内（§1.1）。40 bit 码空间、每会话 3 次尝试加上述锁定表，在线猜测者的
  成功概率约为 `3·k / 2^40`（`k` 为会话数）——按上限每天不足约 700 个
  会话，即持续攻击每天约 2·10⁻⁹，且每个会话都需要受害者屏幕上一次新的
  用户批准对话框。

---

## 8. 重连 — `/v1` 上的 challenge–response

`/v1` upgrade 的 URL **不**携带任何凭据。upgrade 之后（Host 与 Origin 检查
同 §4.3/§5），server 先发言：

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
2. 扩展 → host：`{ "action": "bootstrap", "protocolVersion": 1,
   "bindingPub": "<b64url 32 bytes>" }`。
3. host 读取 `endpoint.json`（0600 owner-only——这份文件所有权*就是*
   attestation 信任根），对记录端口做存活检查（TCP / `/discovery` 探测；
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
        enc("mbp1-attestation") ‖ encU32BE(protocolVersion)
      ‖ enc(serverGeneration) ‖ enc(browser) ‖ enc(callerId)
      ‖ encU64BE(exp) ‖ enc(bindingPub raw 32 bytes))
```

校验（server 侧）：constant-time 重算 `mac`；`purpose` 与 `protocolVersion`
精确匹配；`serverGeneration` 等于 server **当前 generation**——每次
bridge-server 启动重新生成的 UUIDv4，通过 `endpoint.json` 新增的
`generation` 字段发布给 host（增量字段；既有 `writtenAt` 维持
diagnostic-only）；`exp` 在未来且距铸造至多 60 秒；ticket 此前未出现过
（一次性：server 缓存 MAC 直至 `exp`）；`callerId` 等于
`pairHello.claimedExtensionId`；`bindingPub` 等于
`pairHello.ticketBindingKey`。任何一项失败都把配对降级为 `unverified`
**并**在对话框中如实显示；不中止配对（code-entry 信任锚仍然成立）。

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
- key 按方向独立（§6.6/§8），nonce 唯一性对每个 key 由构造保证。连接
  MUST 在 `seq` 到达 `2^40` 之前关闭（经重连重建；v1 不做原地 rekey）。
- 单帧明文上限 1 MiB。信道激活后的文本帧是协议违例。

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

---

## 12. 凭据与 pin 生命周期（扩展侧）

- `PinStore` 是以 `credentialId` 为 key 的带版本存储，保存
  `{port, instanceId}`。pin **只在**该端口上完成双向认证会话之后提交——
  绝不因 `/discovery` 提交。
- pinned 端口不匹配 → 对匹配 `instanceId` 做全候选段扫描 → 仅在认证后
  重新提交；否则清除 pin，回退到全新 code-entry 配对。
- `storage.local` 凭据条目携带 `state: "provisional" | "committed"`
  （§6.7）。以 `authFailed` 重连失败的 provisional 条目应删除，流程回到
  首次配对。

---

## 13. 测试向量

跨实现向量具有规范性，位于本文档旁的
[`bridge-pairing-protocol-vectors.json`](./bridge-pairing-protocol-vectors.json)。
两个仓库的 CI（以及 ticket 向量对应的 Rust native host）MUST 对照其校验。
文件包含（字节串一律 hex 编码）：

1. **`spake2`** — 固定输入（`code`、`pairNonce`、身份、`w`、`x`、`y`）下的
   完整 edwards25519 首配运行及期望的 `pA`、`pB`、`K`、`TT`、`Ke`、`Ka`、
   `KcA`、`KcB`、`cA`、`cB`、traffic key。由于 [RFC 9382] Appendix B 只提供
   P-256 向量，通用 SPAKE2 核心的实现 MUST 另行通过这些 RFC P-256 向量，
   以先证明核心组合（TT 布局、key schedule）正确，再信任 edwards25519
   实例化。
2. **`scryptW`** — 配对码规范化与 `w` 派生（§6.2）。
3. **`reconnect`** — `RT`、客户端与 server MAC、traffic key（§8）。
4. **`nmTicket`** — `ticketKey` 派生与规范 MAC（§9.2）。
5. **`envelope`** — 给定 key/明文下的 AEAD 帧，含期望拒绝用例（错误
   seq、篡改密文、错误 dirTag）。

向量由随 Phase-A 实现一并入库的参考脚本生成；在记录的输入下重新生成 MUST
是确定性的。

---

## 14. 审查与实现 gate

1. 在编写任何 MBP1 协议代码之前，本文档 MUST 通过一次**独立密码学审查**。
   审查记录（审查人、日期、发现、处置）由 maintainer 保存。
2. 实现 MUST 以精确版本锁定 `@noble/curves`（≥ 1.6.0）与 `@noble/hashes`，
   并记录对应的审计报告。
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
- **在线猜测** — 受每会话 3 次尝试与全局锁定表约束（§7.3）。
- **Ticket 重放** — 一次性缓存、60 秒过期、generation 绑定与 Ed25519
  持有证明（§9）使被截获的 ticket 无法用于任何其他握手或 server
  generation。

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

[RFC 9382]: https://www.rfc-editor.org/rfc/rfc9382
[RFC 5869]: https://www.rfc-editor.org/rfc/rfc5869
[RFC 8032]: https://www.rfc-editor.org/rfc/rfc8032
[RFC 7914]: https://www.rfc-editor.org/rfc/rfc7914
[RFC 4648]: https://www.rfc-editor.org/rfc/rfc4648
