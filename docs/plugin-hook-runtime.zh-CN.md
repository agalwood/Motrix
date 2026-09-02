# 插件 Hook 运行时规范

状态：Motrix 2.x 插件 Hook 执行的规范性文档。独立设计评审已于 2026-08-31
通过。

本文定义 Motrix 如何发现、激活、调度、校验、提交、恢复并观测插件
Hook。Electron 和 Server 主机必须遵循同一套规则。

## 1. 问题陈述

Motrix 提供四个任务生命周期 Hook：`beforeCreate`、`beforeFinalize`、
`afterComplete` 和 `onError`。可靠实现必须同时跨越已安装 manifest、可能
已经回收的 QuickJS Worker、Guest 侧 SDK 对象、Host capability、任务与
SQLite 生命周期，以及两套独立装配的应用外壳。

仅能加载 bundle 或看到注册事件，并不能证明 Hook 可用。符合本规范的
运行时必须让真实构建后的插件包通过真实 `PluginHost` 和 QuickJS Worker
执行，传输完整且经过校验的上下文，在正确的提交点应用效果，并能在插件
或主进程中止后安全恢复。

本规范解决以下故障类别：

- 针对原始 URL 文本而不是 URL 结构匹配权限；
- 插件在分派时未激活，导致 Hook 被静默漏掉；
- 同一个插件 VM 同时收到多个任务上下文；
- SDK 类型中存在但 Worker 对象没有实现的方法；
- 不完整或未经校验的 Hook DTO 穿越 Worker 边界；
- 插件替代产物被原下载产物覆盖；
- 最终化失败后文件、元数据和任务状态相互漂移；
- post-Hook 丢失、没有稳定身份的重复投递或阻塞其他插件；
- Electron 与 Server 构造出不同的运行时。

## 2. 非目标

- 本文不增加新的 manifest Hook 名称或 role band。
- 本文不授予插件有效权限集合以外的 capability。
- 本文不承诺任意外部副作用 exactly-once。在 Guest、远程服务和 SQLite
  之间没有共享事务时，这一承诺无法实现。Motrix 提供 at-least-once
  投递和稳定 delivery ID；需要去重的外部操作必须使用该 ID。
- 本文不允许插件在任务保存目录之外完成最终化，也不允许覆盖无关的既有
  路径。
- 本文不把社区插件提升为可信插件。签名、安装同意、可选授权和保留 role
  策略仍是相互独立的门禁。
- 本文不改变内置插件供应链。内置插件仍以签名且哈希锁定的 `.moext`
  发布包被消费。

## 3. 术语

**候选插件（Candidate）**：已启用、manifest 声明了目标 Hook，且激活条件
与 host permission 都匹配事件的已安装插件。

**活动插件（Active plugin）**：已经拥有就绪 QuickJS Worker 并完成 Guest
入口注册的候选插件。

**调用（Invocation）**：从 Host 准入到 Worker 退出 Hook 的一次调用，由
唯一 `invocationId` 标识。

**插件通道（Plugin lane）**：同一个插件 VM 中所有 Host 发起的 Guest 入口
共享的 FIFO 串行边界。

**工作上下文（Working context）**：经过校验的 DTO，加上串行 Hook 链中更早
插件已经接受的效果。

**Hook 效果（Hook effects）**：单次调用产生的上下文 patch 和元数据操作。
效果只是数据，不由 Worker 直接提交。

**HookPlan**：成功执行 `beforeFinalize` 链后得到的不可变计划，包含当前源
产物、最终目标、可选替代产物、元数据效果和归属信息。

**最终化日志（Finalize journal）**：持久记录 HookPlan 以及文件提交已经到达
哪个阶段的数据库行。

**Occurrence**：与任务终态在同一事务中写入的既有持久事件。

**Post delivery**：持久化的 `(occurrence, hook, plugin version)` 组合，对应
一次 `afterComplete` 或 `onError` 投递。

**权限代次（Permission generation）**：针对插件启用状态、授权、隔离状态与
可执行身份单调递增的 registry 值。Guest 入口和每个 capability lease 都绑定
到一个代次。

## 4. 架构边界

Host 中立的运行时位于 `src/core/`。它负责候选发现、结构化权限匹配、每插件
通道、DTO 校验、Hook 编排、最终化计划与恢复，以及 post-delivery 调度。
它可以依赖 shared schema 和注入的文件系统/数据库适配器，但不得依赖
Electron、renderer 或 Server 模块。

`src/shared/` 保存纯 Zod schema，以及由 schema 推导的 Hook DTO 与 Worker
消息类型。这里不得包含 I/O、timer 或 Host import。

`src/main/` 与 `src/server/` 调用同一个 core 运行时工厂。每个外壳只提供
路径、日志、capability host、任务查询/持久化、文件操作和退出协调。命令
处理器内部不得再次构造 orchestrator。

QuickJS Worker 负责执行 Guest 代码并暴露 SDK 表面，但不决定候选资格、
权限、提交顺序或恢复。Capability bridge 校验每一条 Worker 消息，并把它
绑定到当前 invocation。

## 5. 状态机与顺序

### 5.1 插件生命周期

```text
Inactive -> Activating -> Active -> Quiescing -> Inactive
                |           |
                +-> Faulted +-> Faulted
```

- 候选发现与 active 集合相互独立。
- Hook 候选在需要时立即激活。
- 同一插件的并发激活请求合并为一个请求。
- 只有 Worker 就绪且运行时需要的已声明 Hook 全部注册后，才发布 `Active`。
- 只有插件通道没有执行中或排队中的 Guest 入口，并且没有仍在执行的自有
  capability 操作时，才能执行空闲回收。
- 被回收的插件可以为最终化或 post delivery 重新激活；inactive 不等于
  ineligible。
- Worker 崩溃只使当前插件调用失败，随后销毁该 Worker，后续重试可创建
  干净的新 Worker。

### 5.2 串行 pre-Hook 链

```text
校验输入 -> 发现候选 -> 按 role/id 排序
  -> 对每个候选：激活 -> 进入插件通道 -> 调用 -> 校验效果
  -> 合并到工作上下文 -> 生成结果/HookPlan
```

顺序先按 role band，再按插件 ID 字典序。后执行的插件能看到前面插件已经
接受的工作上下文，但看不到其他任务的上下文，也看不到失败插件未提交的
效果。

`pre-resolve`、`resolve` 和 `post-process` 失败会中止链；`enrich` 与
`audit` 失败会被隔离，链继续执行。`audit` 插件不能产生变更效果。

### 5.3 任务终态与 post-Hook 顺序

```text
快照候选插件
  -> 在同一事务提交任务终态 + occurrence + post-delivery 行
  -> 每插件通道投递符合条件的行
  -> 写入成功 receipt 或 retry/dead-letter 状态
```

候选物化属于任务终态 SQLite 事务；真正 Hook 调用可以异步。Occurrence
consumer 只调度已经物化的行，插件失败不能长期占用共享 dispatcher。

## 6. 候选发现与即时激活

候选发现读取当前 `PluginRegistry`，而不是 `PluginHost` 的 active map。只有
同时满足以下条件时，插件才是候选：

1. 已安装、兼容、启用且未隔离；
2. `contributes.hooks` 声明了目标 Hook；
3. 有效 activation set 匹配任务类型或 URL 协议，命令事件另行处理；
4. manifest 中的 Hook role 符合信任与分类策略；
5. 对 HTTP `beforeCreate` resolver，至少一个结构化 `hostPermissions` pattern
   匹配用来选择它的 source URL；
6. 必需 capability 仍在插件有效权限集合内。

`beforeFinalize`、`afterComplete` 与 `onError` 只根据 Hook 声明、task-type
activation、role 和 capability grant 选择。它们的任务源可以是 FTP、magnet
或其他非 HTTP 标识，绝不能通过 HTTP host pattern 过滤；这些 Hook 发起的
每次真实 HTTP capability 调用仍需独立校验。

Hook contribution 本身构成隐式的按需激活来源。`beforeCreate` 后被回收的
候选，会在 `beforeFinalize` 时再次激活。Post delivery 也会在调用前激活
记录中的候选身份。激活失败按该插件的 Hook 失败分类，不会把候选静默删除。

Candidate executable identity 是 `(pluginId, version, executable digest)`。
Candidate/delivery snapshot 另行保存 `createdGeneration` 和创建时完整 effective
permission set；该 generation 仅用于审计，不是未来 execution lease。升级、
启用/停用、隔离、卸载或授权变化进入独占 policy barrier：关闭新 Guest
与 capability 准入，推进代次，中止自有操作，等待 lane drain，或在预算后
终止 Worker，之后才能激活新状态。每次 capability 调用必须取得 live
generation lease 或携带当前 generation；旧 live lease fail closed。历史
post-delivery attempt 只得到
`createdEffectivePermissions intersect currentEffectivePermissions`，后来新增的
grant 绝不能扩大历史 delivery 权限。

## 7. 结构化 host permission 匹配

Host permission 只解析一次，形成结构化 matcher。禁止针对整个原始 URL
执行正则匹配。

支持的 manifest pattern 由以下组件组成：

```text
scheme://host/path-glob
```

- `scheme` 是 `http`、`https` 或 `*`；`*` 仅表示 HTTP 与 HTTPS。
- `host` 是 `*`、规范化后的精确 DNS/IP host，或 `*.example.test`。
  子域通配符只匹配该后缀 host 及其子域。
- Manifest v1 pattern 没有 port 组件。scheme/host 匹配时，任意合法显式或
  默认端口都匹配，以保持已发布插件与浏览器 match-pattern 语义。未来若要
  限制端口，必须升级 manifest schema 版本。
- 方括号包裹的 IPv6 literal 只能精确匹配，内部禁止 wildcard。
- `path-glob` 针对 WHATWG 序列化的 `pathname + search` 匹配，并把百分号
  转义中的十六进制字母转为大写。禁止 percent-decode，编码后的分隔符不能
  变成路径分隔符。`*` 是唯一 wildcard，不能改变 scheme 或 host 比较。
- `<all_urls>` 等价于 `*://*/*`，仍然只表示 HTTP/HTTPS。

URL 使用平台 URL parser 解析。Matcher 对 DNS 名称执行小写和 IDNA
规范化，去掉一个结尾点，规范化默认端口，拒绝内嵌凭据并忽略 fragment。
无效 pattern 或 URL 一律 fail closed。精确 host 使用组件相等判断；
`allowed.example.evil` 和 `evil.example/path/allowed.example` 都不能匹配
`allowed.example`。

`beforeCreate` resolver eligibility、即时激活、Guest 初始 HTTP 请求和每次
redirect hop 必须使用同一个 matcher 与 conformance corpus。测试覆盖
host/path 混淆、后缀混淆、凭据、任意/默认端口、IPv4/方括号 IPv6、IDNA、
percent encoding、query matching 和 redirect。

Host permission 授权的是插件发起的网络请求，不授权也不拒绝交给下载引擎的
返回 URL，也不筛选非 HTTP 生命周期 Hook。Hook 产生的下载 URL 执行 9.4 节
独立的 output policy。

Guest HTTP 只允许使用 Host 管理的 proxy route。即使语法合法，也要拒绝
Guest 指定的 per-request proxy；target host permission 不等于 proxy endpoint
permission。若未来允许 Guest 选择 proxy，必须新增显式 capability、结构化
endpoint allowlist、凭据策略以及 CONNECT/redirect 威胁评审。

Host permission 约束声明的可达范围，但不是 DNS pinning 系统。宽泛通配符
就是宽泛授权，必须继续在 consent UI 中明确展示。

## 8. 每插件调度与上下文隔离

每个插件只有一个 FIFO 通道，由 Hook、命令、lifecycle callback 和
deactivation 共享。Capability response 在已准入入口内部完成，但不会打开
另一个 Guest 入口。

每个入口传播不可变 call-chain ID。若目标插件已在该调用链中，包括 self
command 和 `A -> B -> A`，在入队前就以 `plugin.runtime.reentrant_call` 拒绝，
绝不能排在当前 lane owner 后形成死锁。中止外层入口会取消其排队中的后代
与 invocation 自有 capability；强制终止 Worker 会拒绝该链的所有剩余入口。

Hook 执行期间产生的每一条 Worker 消息都包含 `invocationId`。Bridge 只接受
ID 等于通道当前 invocation 的调用。缺失、过期或不一致的 ID 一律 fail
closed。Hook exit 也携带该 ID，因此已中止 Worker 的迟到 exit 不能完成下一
个任务。

运行时按 ID 保存 invocation context，不复用无键的全局 slot。Hook exit、
timeout、abort、Worker crash 或校验失败后，都在 `finally` 中清除 context。
除了 abort budget 到期后的强制终止，空闲回收和手动停用都等待通道排空。

不同插件可以并行。同一插件面对两个任务时必须串行。因此并发下载不会被
全局串行化，同时上下文也不会串用。

## 9. DTO 与 SDK 契约

### 9.1 校验边界

`src/shared/schemas/` 中的 Zod schema 是所有 Hook DTO、Worker enter/exit
消息、效果列表、metadata value 和 post-delivery envelope 的唯一真相来源。
Host 在发给 Worker 前校验 DTO，并在应用 Worker 结果前再次校验。协议消息
拒绝未知字段；由 schema 版本明确声明的新增 DTO 字段除外。

DTO 只包含 JSON value。字符串、数组、对象深度、集合大小和总编码字节数
都有限制；数字必须有限。任务快照使用副本，Guest 永远拿不到 Host 活对象。

Schema version 1 使用以下包含边界值的限制，均在 UTF-8 编码后计量：

| 项目 | 上限 |
|---|---:|
| 完整 Hook enter 或 exit JSON 消息 | 2 MiB |
| 通用字符串 / 文件系统路径 | 64 KiB / 32 KiB |
| 单请求 URL 数 / 单 URL 字节 | 128 / 16 KiB |
| header 数 / name 字节 / value 字节 / header 总字节 | 256 / 256 / 16 KiB / 256 KiB |
| JSON 对象深度 / 单对象 key 数 / 单数组 item 数 | 16 / 1,024 / 1,024 |
| metadata 条目 / key 字节 / value 字节 / snapshot 字节 | 1,024 / 128 / 256 KiB / 1 MiB |
| error code / error message 字节 | 128 / 16 KiB |

恰好达到上限有效，多一个字节或 item 即拒绝。Shared 常量同时驱动 Zod
schema 与 conformance test。

### 9.2 公共上下文

每个 Hook 都收到其 schema 声明的所有字段。公共字段包括：

- `schemaVersion`、`invocationId` 和 `taskId`；
- 适用时的 `sourceUrl`、`createdBy` 和 `requestedAt`；
- 稳定的插件任务快照 `task`；
- invocation 私有的 `signal`；
- 作用域为 `(taskId, pluginId)` 的 `metadata`。

公开的 `PluginTaskSnapshotV1` 精确 shape 是：

```text
{
  schemaVersion: 1
  id, name
  type: "http" | "ftp" | "bt" | "magnet" | "metalink"
  kind: "direct" | "bt" | "hls" | "mux"
  status: "queued" | "fetching_metadata" | "metadata_ready" |
          "downloading" | "finalizing" | "seeding" | "paused" |
          "completed" | "error" | "removed"
  filePath, saveDir, filename
  progress, totalBytes, downloadedBytes, uploadedBytes, sizeWhenDone, fileCount
  createdAt, updatedAt, finishedAt: number | null
  category: string | null
  infoHash: string | null
  error: ErrorDescriptorV1 | null
}
```

所有 identifier/name/path 使用 9.1 节上限。Count 与 byte value 是非负 safe
integer；时间是非负 integer Unix millisecond；progress 是 `[0, 100]` 内 finite
number。`ErrorDescriptorV1` 是 `{ code, message, detailKey: string | null,
detailParams: Record<string,string> | null }`，绝不包含 stack 或原始 engine
payload。快照保留 SDK 2.0 兼容字段 `id`、`filePath`、`saveDir`，但排除 URI、
header、proxy credential、engine ID、bridge session、可变 instance payload
与 Host 对象。

### 9.3 Metadata 一致性

Pre-Hook `ctx.metadata` 实现完整的六方法同步 SDK 表面：

- `get(key)`、`has(key)`、`getAll()` 和 `keys()` 读取 invocation snapshot；
- `set(key, value)` 与 `delete(key)` 在 pre-Hook 中暂存写入；
- post-Hook 只能拿到 `get`、`has`、`getAll`、`keys` 四方法只读子集，不暴露
  `set` 或 `delete`。

暂存写入必须立即更新 Worker snapshot，确保 read-after-write 确定性。Worker
在 Hook exit 时返回这些操作；Host 校验 key、JSON value、quota、role、phase
和 permission 后，才把它们加入链。任何 fire-and-forget metadata 或
`ctx.update` 调用都不能与 Hook exit 竞态。

Worker/Host bridge 使用的异步 metadata 操作属于内部 transport capability，
不是 Guest 顶层 export。唯一公开的 Hook metadata API 是 `ctx.metadata`，按
`@motrix/plugin-api` 2.0 要求保持同步。

Guest `signal` 是 invocation 私有的只读 `AbortSignal` 子集，包含 `aborted`、
`reason`、`onabort` 以及 `abort` 事件的 `addEventListener`/
`removeEventListener`。Timeout、任务取消、permission generation 变化、退出或
强制 lane 终止只设置一次 `aborted`，赋予有界稳定 reason，并在拒绝未完成的
capability promise 前排队一个 abort 事件；之后的 capability 调用与效果一律
失败。测试使用注入 scheduler 断言该顺序。

### 9.4 各 Hook DTO

`beforeCreate` 接收完整 HTTP 创建请求：URL 列表、保存目录、可选文件名与
连接数、有序 headers、可选 proxy、来源和时间。有效效果仅能修改这些可变
字段，最终 URI 列表不能为空。返回 URL 不必匹配插件的网络
`hostPermissions`，而是执行与用户输入 URL 相同的常规 task source admission
policy：支持的 scheme、拒绝凭据、远程 operator/private-network policy、URL
限制，以及用于修改请求的 role permission。Header 与任务 proxy 效果执行与
用户请求相同的 secret、proxy 和 engine-option policy。这样，锁定的 Commons
resolver 可以只请求 `commons.wikimedia.org`，同时返回经过独立验证的
`upload.wikimedia.org` 下载 URL。

`beforeFinalize` 接收：

- `sourceUrl`：非空的来源标识。HTTP 类任务使用已准入的 source URL；BT/magnet
  任务由 Host 强制把任何原始来源替换为不含秘密的规范标识：有效的 40 位十六
  进制或 32 位 base32 info hash 使用 `urn:btih:<infoHash>`，否则使用
  `urn:motrix:bt:<base64url(taskId)>`。torrent 文件路径、原始 magnet query、
  tracker URL 与凭据绝不能跨越此边界；
- `inputFilePath`：Motrix 当前拥有的已完成产物；
- `filePath`：建议的最终目标，保留用于 SDK 2.0 兼容；
- `targetFilePath`：同一个目标的显式字段名；
- 完整插件任务快照和公共上下文。

修改 `filePath` 只会改变目标，不会改变源，也不表示替代产物一定存在。

稳定公开 delivery envelope 精确定义为：

```text
DeliveryEnvelopeV1 {
  schemaVersion: 1
  id: string
  occurrenceId: string
  occurredAt: number
}
```

`id` 就是稳定 `deliveryId`；它与 `occurrenceId` 都是 opaque、非空且最多 128
UTF-8 bytes；`occurredAt` 是非负 integer Unix millisecond。Attempt number、
lease、retry time 与 breaker state 属于 Host diagnostics，绝不能进入稳定
envelope。

`AfterCompleteContextV1` 精确包含 `schemaVersion`、`invocationId`、`taskId`、
`task: PluginTaskSnapshotV1`、最终 `filePath`、`delivery:
DeliveryEnvelopeV1`、只读 `metadata` 与 `signal`。`OnErrorContextV1` 含相同
字段，另有 `error: ErrorDescriptorV1`。持久稳定 event payload 是
`(task, filePath, delivery, error?)`，通过 object key 字典序排列的 canonical
JSON 在所有 attempt/restart 保持 byte-identical；`invocationId`、`metadata` 与
`signal` 是每次新绑定的 invocation wrapper。
Protocol version 1 拒绝 unknown field；新增公开字段需要 schema-version revision
和向后兼容 SDK minor。

`delivery` 相对 `@motrix/plugin-api` 2.0 是新增字段。Runtime 现已 pin 正式发布的
`@motrix/plugin-api` 2.1.0，插件可通过类型安全接口读取该字段。针对这一精确版本的
compile-time fixture 与真实 QuickJS invocation 都会读取 `ctx.delivery.id`；另一个
npm alias 则让兼容性 fixture 继续针对精确发布的 2.0 包。SDK 2.0 插件在 runtime
上仍兼容，因为字段是 additive，锁定 builtins 无需改源码。

### 9.5 Capability phase 规则

Capability bridge 依次执行 effective permission、phase、invocation 和 path
门禁。`ctx.update` 与 metadata write 在 pre-Hook 中暂存，在 post-Hook 中
禁用。创建前不能读取任务文件；此后读取只绑定当前 invocation 的任务产物。
`beforeFinalize` 中禁止直接 rename，所有目标变更由最终化提交协议拥有。
指向任务 saveDir 的 FFmpeg 输出被重定向到 invocation 私有 staging；插件
storage 输出只能留在该插件 storage sandbox；其他输出路径一律失败。

## 10. `beforeFinalize` HookPlan 与文件提交协议

### 10.1 HookPlan

成功的 Hook 链生成：

```text
HookPlan {
  taskId
  sourcePath
  targetPath
  sourceIdentity: ArtifactIdentity
  replacement?: { pluginId, stagedPath, identity: ArtifactIdentity }
  metadataOps[]
  contributors[]
}
```

`ArtifactIdentity` 是判别联合：

```text
FileIdentity      { kind: "file", size, sha256, platformFileId? }
DirectoryIdentity { kind: "directory", entryCount, totalBytes, treeSha256,
                    platformFileId? }
```

目录遍历绝不跟随 symlink 或 reparse point，并拒绝 socket、device、FIFO 与其他
特殊 entry；空目录与普通文件都要记录。Entry 按带平台标记的 component
encoding 排序（POSIX 使用原始 name byte，Windows 使用精确 UTF-16LE code
unit），再使用带长度前缀的 record 计算摘要：目录 record 包含 type 和 relative
path，文件 record 还包含 unsigned 64-bit size 与文件 SHA-256。Root record、
platform tag 与算法版本也进入摘要。Target filesystem 上出现大小写/规范化
冲突即失败。Open no-follow handle、文件 identity/stat 前后检查与最终 tree
rescan 用来发现 hash/copy 期间的变更；任何变化都中止或 quarantine，不能接受
混合 snapshot。默认最多 1,000,000 个 entry；超过时返回
`plugin.finalize.artifact_too_large`，不能生成部分计划。

`sourcePath` 在 Hook 执行前由 Host 捕获，Guest 无权修改。`targetPath` 必须是
任务 saveDir 的后代，不能等于 saveDir 本身。可信 filesystem adapter 按平台
大小写规则解析路径等价性，并相对持有的 directory handle 使用 no-follow
语义（或平台等价的 anti-symlink-swap primitive）执行操作。平台若无等价原语
则 fail closed；仅做 lexical 或一次性 `realpath` 检查不够。

第一次读取 source identity 前，finalization 必须取得独占 task artifact-mutation
lease，关闭该 task 的 plugin filesystem admission，并成功 quiesce engine 与
所有 Host 自有 writer。Engine stop 失败或存在未计入 writer 时必须 fail closed；
禁止只记录日志后继续。Lease 与持有的 no-follow artifact/directory handle 保持
到 `db_committed` 和补偿结束；对 cleanup 可能删除的每条路径则保持到其清理
完成。Lease 协调所有 Motrix/engine writer；外部变化由下述 identity check
发现，绝不能当作已知数据删除。

只有当某插件通过 invocation 私有 staging adapter 生成普通文件，且 adapter
记录了 logical output 到 staged path 的映射时，才存在 replacement；禁止扫描
目录猜测 owner。文件身份始终包含 size 与 SHA-256；目录身份始终包含 entry
count、total bytes 与 tree SHA-256，digest 不得省略。没有选中映射时选择原
source；出现多个选中映射、symlink、目录/
类型不符、digest 变化或使用其他插件产物时，计划中止。

每次 preserve、rename、copy、install、compensation 或 cleanup 动作前后，
adapter 都必须通过持有的 handle 重新验证 type 与完整强身份。Install 后、写入
`target_installed` 前重新计算并匹配完整 target `ArtifactIdentity`，并在
`db_committed` transaction 紧前再次匹配。Source、target、rollback 或 staging
任一身份不匹配时保留全部 byte、quarantine journal，并禁止递归删除。

路径分支必须显式处理：

- `source == target` 且没有 replacement 时，不执行文件变更；
- `source == target` 且有 replacement 时，安装前保存 source；
- source 与 target 不同时使用 no-replace install；
- file/directory 冲突失败；Windows 大小写等价路径走 `source == target` 分支；
- 跨设备（`EXDEV`）输入走下述 target-local copy 协议，禁止 best-effort rename。

提交语义是 no-clobber。Filesystem adapter 必须提供原子 no-replace install，
例如同文件系统 link/create-exclusive 协议，或原生 rename-without-replace。
Node 会覆盖的 `rename` 不满足要求。任何时刻出现的无关 target 都只能导致
失败，不能被修改。

Orchestrator 只生成计划，不执行 promote 或 source rename。

### 10.2 持久阶段

最终化 journal 使用以下持久阶段：

```text
prepared -> target_staged -> source_preserved? -> target_installed
  -> db_committed -> cleaned
```

任何文件系统变更之前，Motrix 都会持久写入 `prepared`，其中包含规范化路径、
大小写等价判断、预期强身份、plan identity、精确 staging mapping、rollback
path 和 metadata 操作。Database commit/WAL durability point 必须先于任何文件
操作完成。

Target filesystem 上的原 source 可以在 `prepared` 后通过原生 no-replace
file/directory rename 直接安装；这是大型 BT 目录的正常路径。其他情况把选中
artifact 物化到 target filesystem 的 invocation 私有名称下。同设备普通文件
可以 hard-link，跨设备文件 copy；目录在不跟随 link 的前提下递归 copy，使用
独占 destination creation，fsync 每个完成文件，再按 postorder fsync 目录。
之后重新计算完整 `ArtifactIdentity`、fsync 私有项父目录并持久记录
`target_staged`。部分文件或目录 copy 始终私有，绝不能成为 target。

当 target 就是 source path，或需要其他破坏性 source move 时，source 通过
no-replace 语义移至记录的 target-filesystem rollback path。文件及受影响目录
持久后记录 `source_preserved`。随后用 no-replace 原子安装 target-local 临时
项；target 文件和父目录持久后记录 `target_installed`。有 replacement 时只
安装 replacement 临时项，原 source 永远不会覆盖它。每个 phase 在其代表的
文件系统状态已经持久后更新；如果崩溃发生在文件动作与 phase update 之间，
恢复逻辑使用记录的强身份消除歧义。

同文件系统直接 source rename 会跳过 `target_staged`，把强身份 source 以
no-replace 安装为 target。文件需要 fsync 自身与父目录；目录在
`target_installed` 前 fsync 已重命名 root 与受影响父目录。数据库失败或恢复
补偿时，adapter 把该精确身份 no-replace rename 回去。跨设备 source 在
`db_committed` 前保持不变，并走私有 copy 路径。
当 `source == target` 且没有 replacement 时，Motrix 重新验证 artifact 并确保
durable，然后不改变路径，直接从 `prepared` 前进到 `target_installed`。

目标安装完成后，一个 SQLite 事务同时提交：

- 任务最终路径、终态、时间戳和 instance path；
- task-file path rebase；
- 暂存的插件 metadata 操作；
- terminal occurrence；
- journal phase `db_committed`。

只有事务成功后，Motrix 才能删除 rollback artifact、已经过时的原 source、
target-local 临时文件与未使用 staging。每次删除前都要通过持有的 handle，把
当前 type 与完整身份和 journal 重验；不一致时保持路径不动并记录 cleanup
quarantine。随后 fsync 受影响目录；只有全部已知清理完成（或 mismatch 已持久
quarantine）才记录 `cleaned`，释放 mutation lease，并按 quarantine policy
删除或保留 journal。清理操作必须幂等。

### 10.3 补偿与崩溃恢复

Target staging 或安装失败时，Motrix 在必要时从 rollback path 恢复 source，
并让任务保持可恢复状态。数据库提交失败时，只删除强身份与 journal 匹配的
target，并恢复记录的 source。补偿也失败时保留 journal 供启动恢复，绝不能
把任务标为 Completed。

启动恢复必须早于 polling、引擎完成事件订阅和 post delivery：

- `prepared`：校验 source/replacement 身份后安全重试或取消；
- `target_staged`：校验私有临时项后继续；否则只丢弃该身份并重建；
- `source_preserved`：除非已校验的安装可以继续，否则恢复 source；
- `target_installed`：目标身份匹配时完成数据库事务，否则补偿；
- `db_committed`：保留已经提交的 target 并完成清理；
- 畸形、歧义或身份不符的行进入 quarantine，任务设置可恢复的最终化错误，
  但不删除任何字节。

恢复同时检查记录 phase 与所有相邻 phase 的可能文件布局，因此崩溃先于 phase
update 时仍无歧义。操作必须幂等；任何分支都不得跟随 symlink、覆盖未知路径
或把相同 size 当成身份。Fault-injection 测试在每个文件动作、文件/目录 fsync、
journal write 与 SQLite commit 前后停止，并覆盖同设备、跨设备、POSIX 大小写
敏感与 Windows 大小写折叠 adapter。矩阵包含 direct file、单文件 torrent、
多文件 torrent 目录、空目录、entry 上限、symlink/reparse 与 special-file
拒绝，以及递归 copy 和 postorder 目录 fsync 中途崩溃。
还要在 final rescan、`target_staged`、`target_installed`、database transaction、
compensation 与每次 cleanup deletion 前后注入 tree mutation；mismatch 必须
保留 byte 并 quarantine。

## 11. 可靠投递 `afterComplete` 与 `onError`

终态事务开始前，runtime 在 registry generation read lease 下快照候选并校验
自包含 delivery DTO；进入事务时再次验证该 generation，使并发 policy change
要么发生在快照前，要么等待提交。同一个 SQLite 事务写入任务终态、稳定
occurrence，并在下述有界 admission policy 允许时为每个候选写一条
post-delivery 行；行中包含 plugin/executable 身份、required grant、创建时
完整 effective-permission snapshot、`createdGeneration`、DTO、稳定
`deliveryId`、attempt count、next retry 和 status。Quota 拒绝的候选改为更新
有界 tombstone。禁止之后再根据当前 registry
枚举候选；畸形候选形成可观测 permanent row，不能静默消失。

Occurrence consumer 只调度已存在的行，再写入自己的 occurrence-consumer
receipt。它通过唯一 `(occurrenceId, hook, pluginId, version, digest)` key 保持
重放幂等。一个插件失败不能让无关 consumer 或插件保持 undispatched。

已准入 delivery 的语义是 at least once，状态如下：

```text
pending -> delivering -> delivered
                    \-> pending（可重试）
                    \-> dead_letter（永久错误/策略上限）
```

启动时，过期的 `delivering` lease 变回 `pending`。默认值是：两分钟 lease、
64 行 claim batch、8 个全局 delivery worker、每插件 lane 同时 1 个 delivery、
12 次 attempt、最长 7 天 active age。重试延迟为
`min(1 hour, 1 second * 2^(attempt-1))`，再乘注入的 `[0.75, 1.25]` jitter；
超过 attempt/age 上限进入 `dead_letter`。Scheduler 按 plugin ID round-robin，
一个插件不能占满 batch。Delivered/dead-letter 行保留 30 天，删除后保留聚合
audit counter。这些默认值可在 schema 安全边界内配置；测试注入 clock 与
jitter source。

Version 1 配置边界是精确值：lease 30 秒-10 分钟；claim batch 1-256；全局
worker 1-32；attempt 1-32；active age 1 小时-30 天；base delay 100 ms-1 分钟；
delay cap 1 分钟-24 小时且不得低于 base；terminal retention 1-90 天；breaker
threshold 1-100、window 1 分钟-1 小时、pause 1 分钟-24 小时。Jitter 固定为
`[0.75, 1.25]`，per-plugin concurrency 固定为 1。Quota 只能调低：每插件
active row 1-1,000、byte 2-64 MiB；全局 active row 1,000-10,000、byte
64-512 MiB；每插件 terminal row 1-4,000、byte 1-4 MiB；全局 terminal row
4,000-40,000、byte 4-40 MiB。Cross-field validation 要求每个 global bound
至少容纳一个 per-plugin bound。Version 1 中 post 1 GiB hard budget 不可提高，
core reserve 128 MiB minimum 不可降低。

激活失败、Worker crash 和 timeout 可重试；持久 DTO 畸形、精确 executable
identity 缺失或变化、插件停用/卸载/隔离，以及 required permission 撤销属于永久且
可观测错误。Circuit breaker 在十分钟内 5 次可重试失败后打开，暂停该插件
15 分钟且不消耗 attempt，之后允许一次 half-open probe；成功关闭，失败重开。
每行独立捕获插件错误，不能阻止其他插件执行。

Admission 在终态事务中原子预留 row 与 byte budget。Byte 按未压缩 UTF-8
payload 加固定 512-byte row charge 计算。默认每插件 1,000 active row/64 MiB，
全局 10,000 active row/512 MiB。Delivery/dead-letter 后立即把 terminal receipt
压缩到最多 1 KiB；每插件上限 4,000 row/4 MiB，全局 40,000 row/40 MiB。
Ledger 在 compact/prune 时释放精确 active byte，并在启动时根据表内容 reconcile。

任一 active quota 耗尽时，不写完整 DTO 或普通 delivery row。终态事务改为
更新按 `(pluginId, hook, reason, UTC day)` 唯一的固定 quota tombstone bucket，
其中只有 count、首尾 occurrence ID 与时间；单 bucket 最大 1 KiB。每个
plugin/reason 最多 32 个 daily bucket 加一个 lifetime rollup，全局最多 8,192
bucket 加一个 global overflow rollup；旧 bucket 合并进 rollup，所以 rejection
记录有界。这是显式、可观测 admission rejection，不是静默漏投或假 delivered。

Terminal receipt 通常保留 30 天；需要 row/byte quota 时，最旧 receipt 汇总进
同一有界 aggregate 后删除，绝不 prune active row。Post-delivery table 具有
1 GiB hard logical budget，database adapter 至少保留 128 MiB 配置容量供 task、
finalize journal、occurrence 与 quota tombstone 写入，plugin payload 不能消耗
该 reserve。达到全局 post hard cap 后，所有新 post candidate 走有界 tombstone，
无关任务终态与 occurrence 仍可提交。若物理磁盘连 core reserve 都失败，则是
全系统可重试 storage error，不能归因或伪装为 plugin delivery 结果。

`deliveryId` 在所有 attempt 中保持稳定。只有收到匹配的 Hook exit 后，
Motrix 才记录 receipt。若主进程在 Guest 外部副作用完成后、receipt 写入前
崩溃，可能发生重新投递；调用外部系统的插件必须使用 delivery ID 配合
`storage.compareAndSet` 或外部系统的幂等机制。

Delivery DTO 不依赖存活的 task row；删除任务不得 cascade 删除 post delivery。
升级绝不运行 superseded executable：barrier 原子地把该身份的 nonterminal row
转成 permanent `superseded`，lifecycle transaction/journal 提交后再删除旧 bundle。
停用、卸载、隔离或撤销 required grant 同样把受影响行转成显式 permanent
reason。Grant add 可以让 row 保持 pending，但 attempt 只能获得创建时完整权限
快照与当前集合的交集。同 executable 的 grant revoke 会中止 active attempt，
随后用缩小的交集重试；required grant 已缺失时转为 `permission_revoked`。
Row transition、bundle deletion、task deletion 与 policy change 必须共享
registry/database transaction，或使用 journaled two-phase coordinator，使重启
后的顺序仍明确。测试覆盖 claim 前、delivering 中、Guest side effect 后但
receipt 前的 grant add/revoke、upgrade、disable、uninstall 与 quarantine。

## 12. 权限威胁模型与安全要求

Guest 代码、manifest、bundle 消息、URL、metadata、staged file 和持久恢复
行都属于不可信输入。

运行时必须防御：

- host/path/port 混淆和 redirect 越权；
- Guest 选择 proxy endpoint 绕过网络授权；
- save/staging path 中的路径穿越、symlink 交换、不同分隔符、大小写行为和
  sibling-prefix 混淆；
- 使用另一任务上下文的过期或伪造 invocation 消息；
- Worker 在 timeout 或空闲回收后继续持有引用；
- 超大/过深 DTO、metadata quota 绕过和非有限数字；
- replacement/source 别名和对既有用户数据的覆盖；
- 任意文件阶段与数据库阶段之间的崩溃；
- 单插件耗尽 post-delivery queue 或 circuit breaker；
- policy 撤销与已激活 capability 发生竞态；
- 外壳特有装配意外绕过门禁。

Host 每次激活和取得 capability lease 时都针对 live permission generation
重新校验 effective permission；policy 变化使用第 6 节的独占 barrier。
Capability bridge 不信任 SDK 侧 `available` 标志。Audit log 必须去除敏感
header、proxy credential、secret
和私有 source metadata。恢复所需的用户绝对路径可以写入本地日志，但不能
进入公开文档或远程遥测。

## 13. 错误分类

日志、audit record、任务错误描述和 post-delivery 行使用稳定分类：

- `plugin.hook.input_invalid` 与 `plugin.hook.output_invalid`；
- `plugin.hook.not_registered`、`plugin.hook.timeout` 和
  `plugin.hook.worker_crashed`；
- `plugin.hook.permission_denied` 与 `plugin.http.host_not_permitted`；
- `plugin.hook.concurrent_protocol_violation`，表示通道/ID 违规；
- `plugin.runtime.reentrant_call` 与
  `plugin.runtime.permission_generation_stale`；
- `plugin.finalize.plan_invalid`、`target_exists`、`staging_invalid`、
  `artifact_too_large`、`file_commit_failed`、`db_commit_failed`、
  `recovery_quarantined`；
- `plugin.post.retryable`、`plugin.post.permanent`、
  `plugin.post.admission_rejected`、
  `plugin.post.dead_letter`，并包含显式 `queue_capacity`、`identity_missing`、
  `superseded`、`permission_revoked` 原因。

串行 Hook 错误继续使用按 role 区分的 fail-open/fail-closed 策略。Post-Hook
错误不能改变任务终态。暴露给插件的错误消息必须有界，且不得包含其他插件
的细节。

## 14. 兼容性

运行时支持 `@motrix/plugin-api` 2.0 context shape。继续返回 context 对象的
既有插件保持可用；实际效果来自 `ctx.update` 与 metadata operation。新增
DTO 字段是 additive，不改变既有字段含义。

Manifest v1 保持已发布的浏览器 pattern 端口语义：不带 port 的 pattern 同时
匹配显式和默认端口。改变该语义或新增 port grammar 必须升级 manifest schema
版本。公开 SDK 继续只通过 Hook context 暴露 metadata：pre-Hook 六方法，
post-Hook 四个只读方法。

可靠 post delivery 对 SDK 2.0 插件是 additive runtime feature，但类型化读取
`ctx.delivery` 需要 9.4 节定义并 pin 的 compatible SDK minor。Runtime protocol
schema、Worker object、generated declaration 与公开 package version 必须在发布
前通过同一个 field-parity test。

`beforeFinalize` 中的 `ctx.filePath` 继续表示建议的最终 target，与已发布的
filename-template 插件保持一致。`inputFilePath` 和 `targetFilePath` 把此前隐含
的区别显式化。

未声明 Hook 的插件继续使用原有激活和命令行为。缺失可选运行时组件只能在
隔离单元测试中作为 no-op。生产 Electron/Server 装配必须提供 runtime、
database、recovery 和 delivery 依赖，否则启动失败。

## 15. 可观测性

每次 invocation 都产生结构化 start/finish 记录，包括 Hook、任务 ID、插件
ID/version、invocation ID、role、排队延迟、激活时间、runtime、执行时间、
结果、错误分类和效果数量，但不记录敏感 payload value。

最终化 audit 记录 plan ID、source/target 分类、replacement owner、journal
phase、promote/discard 字节、补偿和恢复结果。Post-delivery 指标包含
pending/delivering/delivered/dead-letter 数量、attempt latency、retry 次数和
最老 pending age。

Electron 与 Server 使用相同事件名和字段含义。测试必须断言两套装配，而不
只是测试 core factory。

## 16. Electron 与 Server 装配

每个外壳按以下顺序执行：

1. 打开并迁移数据库；
2. 发现插件，创建 capability host 与 `PluginHost`；
3. 创建且只创建一个共享插件 Hook runtime；
4. 注册 runtime 的 occurrence consumer；
5. 恢复 finalize journal；
6. 恢复 task/session 状态，但不开放 producer；
7. 把同一个 runtime 注入 create、finalize、media、recovery 和 error 路径；
8. drain 已物化 delivery 与 occurrence，然后开放 polling 和引擎 completion
   producer；
9. 退出时停止准入，在预算内 drain 已接受工作，持久化 lease，最后停止插件
   Worker。

两套外壳可以在通知适配器和 path-policy 输入上不同，但 Hook eligibility、
DTO、调度、提交、恢复和投递策略必须完全一致。
两者调用同一个启动协调器；顺序测试断言其精确事件。

## 17. 内置插件验收矩阵

测试必须使用 `scripts/builtins.lock.json` 获取的真实构建产物，不能使用重新
编写的 fixture 或源码副本。

| 插件 | 锁定发布版 | 必须通过的真实 Hook 验收 |
|---|---:|---|
| `motrix.scraper-hook` | 1.0.0 | `beforeCreate` 通过真实 HTTP capability 执行 HEAD 与 GET，并把嵌套的相对 archive URL 改写为目标 URL。 |
| `motrix.url-resolver` | 1.0.0 | `beforeCreate` 的 API 请求与 redirect 始终位于 Commons host permission 内，再把独立 output policy 验证后的 `upload.wikimedia.org` URL 写回。 |
| `motrix.filename-template` | 1.1.1 | `beforeFinalize` 读取 `ctx.metadata.getAll()`，渲染嵌套 metadata，并提交自动 no-clobber rename。 |

矩阵还必须覆盖：空闲回收后的最终化、重启恢复、两个任务通过同一插件并发
完成、完整 `afterComplete`/`onError` DTO、替代产物不被原产物覆盖、事务
失败/补偿、崩溃恢复、恶意 host-vs-path URL，以及 Electron/Server 装配
对称性。

由于锁定 builtin 都未声明 post-Hook，必须另行构建一个 SDK 2.0 compatibility
plugin，让它通过真实 QuickJS 执行四个 Hook 但不读取 `delivery`；SDK >=2.1
fixture 执行两个 post-Hook 并读取稳定 `ctx.delivery.id`。二者都是 runtime
bundle，不能用 mocked callback。

## 18. 规范性不变量

- **H1**：Hook 候选不能只从 active plugin set 推导。
- **H2**：一个插件 VM 最多只能运行一个 Host 发起的 Guest 入口。
- **H3**：所有 invocation-scoped Worker 消息都携带当前 `invocationId`，且
  不能操作其他 invocation。
- **H4**：每个 Hook DTO 与结果都在两个信任边界执行运行时校验。
- **H5**：HTTP `beforeCreate` resolver selection 与每次 Guest HTTP
  request/redirect 只使用一个结构化 matcher。
- **H6**：后执行插件只能看到更早成功插件已经校验的效果。
- **H7**：pre-Hook `ctx.metadata` 实现 get/has/getAll/keys/set/delete，并具有
  确定性 read-after-write 行为；post-Hook 只暴露四个只读方法。
- **H8**：source 在首次 identity read 前必须 quiesce 并取得独占 task artifact
  mutation lease；lease 持有到 commit/compensation 和 identity-checked cleanup，
  未知变化的 byte 绝不能删除。
- **H9**：orchestrator 不 promote staging，也不 rename source。
- **H10**：最终化提交不能覆盖无关的既有 target。
- **H11**：replacement 取代 source rename，绝不能位于 source rename 之下
  被其覆盖。
- **H12**：任务终态、task-file path、plugin metadata、occurrence 与 journal
  commit phase 在一个 SQLite 事务中变化。
- **H13**：所有跨文件系统边界的最终化，在变更前都有持久 journal 和幂等
  恢复路径。
- **H14**：已准入的 post-Hook delivery 身份稳定，并在重启后继续存在，直到
  delivered 或明确 dead-letter；quota rejection 只由有界、可观测 tombstone
  contract 表示。
- **H15**：一个插件的 post-Hook 失败不能阻塞另一个插件或无关 occurrence
  consumer。
- **H16**：Electron 与 Server 构造并注入同一个 core runtime。
- **H17**：Hook 产生的下载 URL 走普通 task-source output policy，绝不使用
  插件 HTTP host-permission predicate。
- **H18**：finalizer/post-Hook eligibility 不依赖 HTTP source URL 或 active
  plugin set。
- **H19**：每个破坏性文件动作前都有持久强身份，动作后在 journal phase
  更新前完成文件/目录 durability。
- **H20**：任务终态、occurrence，以及每个候选的 delivery row 或有界
  quota-admission decision 在同一事务提交。
- **H21**：permission generation 变化必须先关闭准入并中止旧 capability
  lease，再发布新 policy。
- **H22**：lane call cycle 在入队前失败，不能形成死锁。
- **H23**：普通文件与目录树具有判别式强身份，并拥有同等 journaled
  same/cross-device recovery。
- **H24**：active payload、terminal receipt 与 quota tombstone 均有原子的
  per-plugin/global row 和 byte 上限；post data 不能消耗 core reserve。
- **H25**：历史 delivery 只能使用创建时权限与 live generation lease 的交集，
  升级绝不运行旧代码。

## 19. 验收标准

只有同时满足以下条件，实现才算完成：

1. 上述所有不变量都有聚焦的正例与负例测试；
2. 三个锁定 builtin archive 先通过锁定 size、SHA-256 与签名断言，再通过
   `PluginHost`、QuickJS 与 runtime 的真实 Hook 矩阵；
3. 真实编译的 SDK 2.0 四 Hook fixture 与 pinned SDK >=2.1 delivery fixture
   通过 Worker/Host/schema field parity 与 QuickJS invocation 测试；
4. 权限混淆、idle/reactivation、并发、重启、文件与 BT 目录
   replacement/rename、same/cross-device 数据库失败、crash phase、历史
   grant/upgrade、post-delivery quota 与 shell parity 测试全部通过；
5. schema parity、boundary、filename、lint、type-check、完整单元测试、
   Electron build 与 Server build 全部门禁通过；
6. 独立对抗性审查不存在尚未解决的正确性、安全、数据完整性、SDK 契约或
   双外壳漂移问题。

## 20. 初次独立对抗设计评审记录

独立只读评审者在 2026-08-31 给出 **FAIL**。11 条 finding 全部接受，没有
拒绝项。本表记录裁决与理由，不隐藏初次评审失败。

| ID | 严重度 | 裁决 | 解决方式与理由 |
|---|---|---|---|
| C1 | Critical | 已解决——接受 | 网络 `hostPermissions` 现在只约束 Guest 请求；Hook 输出 URL 使用独立 task-source policy，使锁定 Commons resolver 可以安全工作。 |
| H2 | High | 已解决——接受 | HTTP source matching 只选择 `beforeCreate` resolver；finalizer/post 候选使用 task activation 与逐调用 capability 检查，FTP/BT 不再漏掉。 |
| H3 | High | 已解决——接受 | 强身份改为必选，并规范记录 staging mapping、no-follow handle、no-replace install、target-local 跨设备 copy、fsync 点、路径等价分支和相邻 phase 恢复。 |
| H4 | High | 已解决——接受 | Candidate snapshot 与 delivery row 和任务终态一起提交，并定义精确 executable retention 与 lifecycle/delete 顺序。 |
| H5 | High | 已解决——接受 | 启动时先恢复 journal 与 task/session，再 drain post delivery；两套外壳使用同一个有序 coordinator。 |
| H6 | High | 已解决——接受 | 拒绝 Guest 自选 HTTP proxy，只允许 Host 管理的 proxy route。 |
| H7 | High | 已解决——接受 | Manifest v1 省略 port 并匹配所有合法端口；明确 IPv6、query、percent encoding 和共享 matcher corpus。 |
| H8 | High | 已解决——接受 | Permission-generation barrier 关闭准入、取消 lease、drain/终止 lane，并拒绝旧代次消息。 |
| M9 | Medium | 已解决——接受 | 传播 call chain，在排队前拒绝 self/cyclic plugin re-entry，并定义取消传播。 |
| M10 | Medium | 已解决——接受 | 区分 pre/post metadata 表面，bridge metadata 为内部接口，并定义 DTO 精确上限与 QuickJS AbortSignal 顺序。 |
| M11 | Medium | 已解决——接受 | 明确 lease、backoff、公平性、attempt/age、breaker、queue cap、retention、task independence 与确定性测试控制。 |

评审也确认中英文初稿实质等价。

### 第一次复审

同一独立评审者在第一轮修订后仍返回 **FAIL**。C1、H2、H5-H7 与 M9 保持
关闭，但 H3/H4/H8/M10/M11 被重新归纳成 4 条 High finding。四条全部接受，
没有拒绝项。

| ID | 严重度 | 裁决 | 解决方式与理由 |
|---|---|---|---|
| N1 | High | 已解决——接受 | `ArtifactIdentity` 覆盖文件和确定性目录树，并明确 same/cross-device no-replace install、递归 durability/recovery 和真实多文件 BT case。 |
| N2 | High | 已解决——接受 | 创建 generation 仅用于审计；历史权限是创建/当前权限交集，升级原子 supersede 旧 row 且绝不运行旧代码。 |
| N3 | High | 已解决——接受 | 稳定 delivery envelope、post context、task/error snapshot、严格 schema/version 行为、最低公开 SDK minor、compile fixture 与真实 QuickJS 断言均已精确定义。 |
| N4 | High | 已解决——接受 | 原子 per-plugin/global row/byte quota 覆盖 active 与 terminal data；terminal payload compact，cap hit 使用有界 tombstone，plugin storage 不能消耗 core reserve。 |

这些成对修订后必须进行第二次复审；返回 PASS 前，实施计划仍被门禁阻断。

### 第二次复审

评审者关闭了所有原始 finding 与 N1-N4，但针对一个新 High 返回 **FAIL**。
该 finding 已接受，没有拒绝项。

| ID | 严重度 | 裁决 | 解决方式与理由 |
|---|---|---|---|
| N5 | High | 已解决——接受 | Finalization 现在要求 identity capture 前成功 quiesce engine/Host 并取得独占 artifact-mutation lease；每个动作前后、commit/delete 前重验完整身份，mismatch 保留 byte 并 quarantine。同时补入 mutation injection、精确配置边界和 SDK 2.0 post compatibility 测试。 |

必须进行第三次复审；返回 PASS 前，实施计划仍被门禁阻断。

### 第三次复审与门禁结论

独立评审者返回 **PASS**。C1、H2-H8、M9-M11 与 N1-N5 全部关闭，没有新的
Critical 或 High finding；评审确认两种语言实质等价，验收期望可以确定判定。
残余实施风险是平台是否真正支持 held no-follow handle、目录 durability 与原子
no-replace primitive；规范已要求不支持的平台 fail closed。因此设计评审门禁
关闭，可以开始实施计划。
