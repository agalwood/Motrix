# 官方可选插件

官方可选插件通过插件市场安装。选择插件，点击**安装**，检查权限后确认。
可选权限默认关闭，需用户单独授予。安装后可在详情页禁用、更新或卸载，
桌面应用和服务器应用均支持这些操作。

Motrix 使用内置的官方签名公钥验证完整安装包后，才会显示
**已验证 Motrix 官方签名**。市场中的标签本身不能证明官方身份。
安装包大小、SHA-256、清单中的插件标识、版本、引擎要求和声明权限
也必须与市场条目一致。

应用会保留签名安装包，并在发现插件和执行插件前重新验证。
可信清单和执行代码均从安装包读取，不使用解压目录中的对应文件。
签名无效时不会加载插件。

官方可选插件与社区插件使用相同的权限确认、可选权限授权和升级确认流程。
官方签名允许使用 `motrix.*` 命名空间，但不授予 `pre-resolve` 等
内置插件专属的 hook 角色。随应用分发的内置插件继续使用独立的签名更新通道，
不能通过可选安装覆盖。

## 宿主版本兼容性

`motrix.media-merge` 也是官方可选插件。当前清单要求
`>=2.0.0-beta.47 <3.0.0`：拒绝 beta.46；接受 beta.47、后续 2.0 beta 和
符合范围的 2.x 正式版；拒绝 3.0.0。安装前需要配置 FFmpeg，并确认必需的
`ffmpeg` 权限。

不兼容的市场条目仍可查看，但安装按钮禁用。详情页显示完整版本范围、当前宿主
版本，并提示升级或切换到满足要求的版本。宿主在下载前检查市场版本要求，读取包后
还会在权限确认前独立检查清单。导入安装包时，若清单版本检查失败，也返回所需版本和
当前版本。桌面端和 Server 使用相同的本地化提示；失败时不安装插件、不保存授权。
存在版本上限时，不应将范围简写为“某版本+”。

以下截图使用本地界面示例数据展示实际组件，不代表插件包已在在线市场发布。

![官方可选插件权限确认（简体中文）](../screenshots/motrix-official-plugin-consent-cn-light.png)

![beta.46 因版本不兼容而无法安装音视频合并插件（简体中文）](../screenshots/motrix-plugin-version-requirement-cn-light.png)

## 发布要求

注册表 v2 格式保持不变。官方可选插件条目需要提供安装包 URL、大小、SHA-256，
以及使用应用信任的密钥对完整 `.moext` 字节签署的 Ed25519 `package.signature`。
现有两种注册表来源均受支持，官方身份由签名验证确定。
标记为 `builtin`、但未随应用内置的条目，必须具有有效的官方签名才能进入可选安装流程。

清单必须支持非内置运行。已退役的 `motrix.scraper-hook` 1.0.0 使用
`pre-resolve`，仍不能作为可选插件安装。需要先发布并上架改为 `enrich`
的新实现，再恢复提供此插件。仅更新应用不会发布该安装包。
未签名的本地文件或任意下载 URL 不能声明官方身份；此安装通道从注册表获取独立签名。

## 安全策略支持

安全策略实现覆盖 Electron 和 Server 中的内置、官方可选、社区及手动导入插件。
**本次变更尚未配置生产策略服务。** 在 `src/shared/plugin-security-trust.ts`
中接入独立公钥和签名基线前，服务不启动、不发请求，也不提供远程禁用能力。
已有的安装包签名验证继续生效。

接入后，每个宿主每 12 小时检查一次公共静态 HTTPS 策略，加入 ±10% 随机偏移。
请求使用 ETag 并合并并发检查；检查时间和失败退避会持久化，重启不会重复请求。
启动或桌面端唤醒时，已到期的检查随机延迟 5～30 秒。失败后依次约 15 分钟、
1 小时、3 小时重试，并遵守有上限的 `Retry-After`。单次请求限时 5 秒，响应上限
256 KiB。不上传已安装插件清单，各窗口不单独轮询。Server 与桌面端共用核心实现；
执行插件和切换页面不发网络请求。普通同步失败只记日志，不反复弹窗。

规则按插件 ID 和版本范围，或完整 `.moext` 的 SHA-256 匹配。版本下限包含、上限
不包含，比较保留预发布版本语义。安装包哈希与执行入口文件哈希分别记录。新安装
的插件保留包哈希；旧版解压插件和随应用分发的内置种子可能缺少该哈希，针对这些
安装的公告必须同时包含 ID/版本规则。开发目录也接受 ID/版本检查。这是已知威胁
封禁机制，不能替代恶意代码检测，也不构成安全认证。

宿主在安装权限确认前、提交安装时、激活时及现有执行策略租约中检查规则。
新禁用规则先关闭执行入口、取消租约，终止插件执行环境并跳过插件自己的退出
回调；排队的后置投递以 `security_revoked` 原因终止。串行 Hook 返回的暂存结果
在引擎派发和数据库提交前再次校验；已派发的创建请求沿用现有引擎补偿清理流程。
保留配置、权限、插件文件
及用户原来的启用偏好。缓存验证失败会暂停执行，但不会永久丢弃排队投递。
已经完成的外部操作无法撤回。

已确认的禁用在离线和签名元数据过期后继续有效，其他已有插件可离线运行。
新外部安装包可以离线安装，但首次激活需要最近 24 小时内成功检查可信策略，且
签名元数据尚未过期。宿主保存与具体安装包绑定的检查凭据，重启后仍可使用。
内置覆盖更新在提交前要求策略新鲜。解除禁用必须通过更高签名版本明确撤回公告；
遗漏或缩小原规则会被拒绝。更新到未受影响的版本也可解除对应禁用。
解除后按用户原来的启用偏好恢复正常激活，不重放已终止的投递。未实现此机制的
历史客户端无法执行这些规则。

### 策略格式与发布

`src/shared/schemas/plugin-security.ts` 是权威的严格协议。正文包含
`schemaVersion: 1`、单调递增的 `revision`、UTC `issuedAt`/`expiresAt` 和
`advisories` 数组。每条公告有唯一 `id`、`status`（`active` 或 `withdrawn`）、
`reason`（`malware`、`vulnerability` 或 `compromised`），以及至少一条
`affected` 匹配条件。任意一条条件命中即生效：

```json
[
  { "kind": "plugin", "pluginId": "example.demo", "fromInclusive": "1.0.0", "beforeExclusive": "1.2.0" },
  { "kind": "archive", "sha256": "<64 lowercase hexadecimal characters>" }
]
```

可选的 `fixedVersion` 和 HTTPS `motrix.app` 公告 `url` 只用于提示。
协议不允许下发命令、代码、自动安装或删除操作。后续快照必须保留已撤回的记录
及原有匹配条件。范围错误时，撤回旧公告，再用新 ID 发布更正后的规则。

签名信封为 `{payload, signatures}`。`payload` 是正文 UTF-8 原始字节的标准
base64；每个 Ed25519 签名覆盖 UTF-8 前缀 `motrix-plugin-security-v1\n`
与解码后的正文。任一内置策略公钥验证成功即可接受；不得复用安装包签名密钥。
这是有边界的签名静态策略协议，并未实现完整 TUF 角色体系。策略有效期上限为
14 天，即使规则未变化，也须在过期前重新签发。HTTP 304 不会延长签名有效期。
过期检查可发现长期陈旧的分发内容，但无法把新禁用规则送达离线客户端。
网络防回滚依赖本地持久化版本和随包基线；替换客户端或其可信本地配置不在保护范围内。

使用独立管理的 Ed25519 私钥离线生成信封：

```sh
node --import tsx scripts/sign-plugin-security.mjs \
  --input policy.json --key /secure/policy-signing.pem \
  --previous previous-signed.json --output next-signed.json
pnpm run check:plugin-security -- --require-configured
```

只有初始策略可省略 `--previous`。工具验证格式和版本变更、验证签名结果，且拒绝
覆盖已有产物；不会生成密钥或发布文件。将公钥、初始空规则签名基线及真实 HTTPS
地址接入构建，在分发启用此功能的版本前执行强制配置校验。不得提交私钥，也不得
用生产密钥签署测试封禁。轮换时先通过宿主版本分发同时信任新旧公钥的构建，再切换
签名方；新密钥签名时传入 `--previous-public-key /trusted/old-public.pem`，
使用旧公钥验证上一份信封，不能把验签失败当作首次发布。

只通过受保护的部署工作流发布已审核信封，使用 CDN 缓存静态对象，设置较短边缘
TTL（例如 5 分钟）、稳定 ETag 和原子替换。保留带版本的审计产物；误封用更高版本
明确撤回，不恢复旧对象。正常网络下，12 小时检查周期可能约 13 小时才发现新规则，
另加 CDN 和网络延迟。存储失败时保留内存禁用并阻止新的首次激活；磁盘写入失败时，
无法承诺断电后仍能保存刚收到的策略。


## 运维操作手册：独立签名密钥

本手册按“离线签名、受保护流程发布、客户端定时读取”执行。命令适用于 macOS/Linux，
在包含本实现的 Motrix 仓库根目录运行，使用仓库锁定的 Node/pnpm 环境与已安装依赖。
下列命令是操作说明，编写手册不会生成生产密钥、上传策略或启用客户端。
按步骤逐条执行；任何命令退出非 0 时，先解决错误，再继续后续步骤。

**当前状态：** 客户端和签名工具已实现；生产公钥、签名基线尚为空。检查到的下载
Worker 源码只有下载及 registry 路由，尚未提供 `/security/plugins-v1.json`；本仓库也
没有安全策略发布工作流。步骤 4 是需要先完成的部署集成，不能仅上传文件就视为上线。

### 1. 准备独立的操作目录

选择仓库外、访问受控的本地目录；示例使用 `$HOME/.motrix-policy`。该目录包含私钥，
应放在受控加密存储上，单独保存加密备份。不要加入 Git、普通构建产物或插件发布任务。
每次新开终端都重新设置这些环境变量：

```sh
umask 077
export MOTRIX_POLICY_HOME="$HOME/.motrix-policy"
mkdir -p "$MOTRIX_POLICY_HOME/keys" "$MOTRIX_POLICY_HOME/policies" "$MOTRIX_POLICY_HOME/artifacts"
chmod 700 "$MOTRIX_POLICY_HOME" "$MOTRIX_POLICY_HOME/keys"
node --version
pnpm --version
```

客户端和下载 Worker 只需要公钥/已签名文件，不需要私钥。私钥不会传给 CDN。

### 2. 首次生成 Ed25519 密钥

只运行一次；命令拒绝覆盖已有文件，不会打印私钥：

```sh
node --input-type=module <<'NODE'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
const dir = path.join(process.env.MOTRIX_POLICY_HOME, 'keys')
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
writeFileSync(path.join(dir, 'policy.private.pem'),
  privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
writeFileSync(path.join(dir, 'policy.public.pem'),
  publicKey.export({ format: 'pem', type: 'spki' }), { flag: 'wx', mode: 0o644 })
console.log('Public key SHA-256:', createHash('sha256')
  .update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex'))
NODE
```

记录显示的公钥指纹，并与另一位维护者通过可信渠道核对。
`policy.private.pem` 只供签名操作使用，`policy.public.pem` 可以公开并随宿主分发。
当前签名工具读取未加密 PKCS#8 PEM，不支持口令提示；文件的加密存储和解锁由操作环境
负责。不要把私钥或其 base64 文本放进聊天、工单、PR 或命令行参数。

### 3. 生成首次空策略并签名

首次发布使用 `revision: 1`，有效期 14 天，暂不封禁任何插件：

```sh
node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
const now = Date.now()
const policy = {
  schemaVersion: 1, revision: 1,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 14 * 86400_000).toISOString(),
  advisories: [],
}
writeFileSync(path.join(process.env.MOTRIX_POLICY_HOME, 'policies/rev-1.json'),
  JSON.stringify(policy, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
NODE
node --import tsx scripts/sign-plugin-security.mjs \
  --input "$MOTRIX_POLICY_HOME/policies/rev-1.json" \
  --key "$MOTRIX_POLICY_HOME/keys/policy.private.pem" \
  --output "$MOTRIX_POLICY_HOME/artifacts/rev-1.signed.json"
export MOTRIX_POLICY_CANDIDATE="$MOTRIX_POLICY_HOME/artifacts/rev-1.signed.json"
```

用公钥独立验证，并检查输出中版本、日期和空规则数组：

```sh
node --import tsx --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { verifySecurityPolicy } from './src/core/plugin/security/policy-verifier.ts'
const publicKey = readFileSync(path.join(process.env.MOTRIX_POLICY_HOME, 'keys/policy.public.pem'), 'utf8')
const policy = verifySecurityPolicy(readFileSync(process.env.MOTRIX_POLICY_CANDIDATE, 'utf8'), [publicKey])
if (Date.parse(policy.expiresAt) <= Date.now()) throw new Error('Policy expired')
console.log(JSON.stringify(policy, null, 2))
NODE
```

本步骤只生成本地文件。后续更新必须提供 `--previous`，不可重新从版本 1 开始。

### 4. 补齐发布入口和受保护工作流（首次上线前开发步骤）

建议采用下面的部署契约；桶名、绑定名和环境名是建议新建的名称，不表示它们已经存在。

| 项目 | 建议配置 |
| --- | --- |
| 固定客户端 URL | `https://dl.motrix.app/security/plugins-v1.json` |
| 独立 R2 桶 / Worker 绑定 | `motrix-plugin-security` / `PLUGIN_SECURITY` |
| 当前对象 | `plugins-v1.json`，按完整文件替换 |
| 不可覆盖的历史对象 | `history/rev-<revision>.json` |
| 响应 | `application/json`、稳定 `ETag`、`Cache-Control: public, max-age=300` |
| 读取 | 公开 `GET`/`HEAD`；匹配 `If-None-Match` 时返回 `304`；不重定向 |
| 发布权限 | 独立受保护环境，例如 `plugin-security-feed`；仅持有该桶的发布凭据 |

由下载 Worker 的维护流程实现精确路径匹配、R2 读取和边缘缓存，不开放公共写入接口，
不修改已有下载 URL。通过 Worker 读取 R2 时，应显式设计缓存行为，并使用 `httpEtag`
生成规范的 ETag 响应头；这些字段见 [Cloudflare R2 API 文档](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。
缓存命中也必须正确处理条件请求，不为每个客户端回源解析整份策略。
Worker 缓存接入可参考 [Cloudflare Cache API 示例](https://developers.cloudflare.com/r2/examples/cache-api/)。

发布工作流至少需要完成以下步骤：

1. 接收不可变的已签名产物及其 SHA-256，使用受保护版本的验证代码和固定公钥验证。
   工作流只拿发布凭据，不拿签名私钥；不允许提交者替换验证公钥或执行任意输入代码。
2. 验证格式、签名、有效期、大小和版本迁移；读取源站当前对象/发布账本校对上一版本。
   首次创建须确认源站不存在旧版本；不能把下载失败或 404 简单当作可重置版本的授权。
3. 审核受影响 ID、版本边界、哈希、修复版本及撤回内容；串行发布，并在写入前重新核对
   源站版本或 ETag，防止并发发布覆盖较新的策略。
4. 先保存不可覆盖的历史对象，再整体替换固定对象；清理该 URL 的缓存或等待缓存到期。
5. 重新从公网固定 URL 下载，验签并核对版本及产物哈希；成功后记录发布者、审核者、
   时间、版本、签名公钥指纹和产物 SHA-256。

现有应用更新的 `app-update-feed` 工作流不会发布此策略；应为新桶单独配置发布
凭据。完成并审核上述集成后，通过新的受保护流程发布步骤 3 的产物。

### 5. 验证公网产物，再建立本地当前版本

发布成功后执行；不要添加 `-L` 掩盖重定向：

```sh
export MOTRIX_POLICY_URL='https://dl.motrix.app/security/plugins-v1.json'
curl --fail --silent --show-error --compressed --proto '=https' \
  --max-time 10 --max-filesize 262144 \
  --dump-header "$MOTRIX_POLICY_HOME/artifacts/published.headers" \
  --output "$MOTRIX_POLICY_HOME/artifacts/published.signed.json" \
  "$MOTRIX_POLICY_URL" &&
cmp "$MOTRIX_POLICY_CANDIDATE" "$MOTRIX_POLICY_HOME/artifacts/published.signed.json"
```

检查 `published.headers` 的状态为 `200`、内容类型正确、ETag 存在。`cmp` 必须退出 0，
表示 CDN 返回的完整文件与已验签的候选产物一致。若不一致，检查是否已有更新发布或
缓存未刷新，不覆盖服务端的更高版本。另用实际 ETag 发送 `If-None-Match` 请求，
确认未变化时返回 `304`。

确认发布账本与候选版本一致后，保存本地当前版本；历史 `rev-*.signed.json` 继续保留：

```sh
cp "$MOTRIX_POLICY_HOME/artifacts/published.signed.json" \
  "$MOTRIX_POLICY_HOME/artifacts/current.signed.json"
```

下一次操作前，与发布账本核对 `current.signed.json`。多人操作时，不能仅凭自己本地
的最后一次文件决定最新版本；从受控历史产物取得并验签最新成功版本。

### 6. 把公钥和签名基线接入客户端

下面第一个命令只打印公开配置。把输出对象替换到
`src/shared/plugin-security-trust.ts` 中 `PLUGIN_SECURITY_TRUST` 的对象值，保留类型声明
和 `PLUGIN_SECURITY_SIGNATURE_CONTEXT`。然后运行第二个命令：

```sh
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
import path from 'node:path'
const home = process.env.MOTRIX_POLICY_HOME
console.log(JSON.stringify({
  url: process.env.MOTRIX_POLICY_URL,
  publicKeys: [readFileSync(path.join(home, 'keys/policy.public.pem'), 'utf8')],
  baseline: readFileSync(path.join(home, 'artifacts/current.signed.json'), 'utf8'),
}, null, 2))
NODE
pnpm run check:plugin-security -- --require-configured
```

期望输出 `Plugin security trust verified; baseline revision 1.`，并且退出 0。
配置仅能通过代码审核和宿主版本发布分发，不使用运行时环境变量覆盖信任。
后续宿主发布应使用最新已审核快照作为基线，保留全部历史公告；不能再次嵌入空规则。
若基线已过期，先按步骤 8 续签和发布，再更新基线，不放宽构建检查。

### 7. 验证后发布宿主

执行仓库的架构、lint、类型检查，安全策略/安装/宿主相关测试和双端生产构建，
再通过现有宿主发布流程发版。确保发布任务执行
`pnpm run check:plugin-security -- --require-configured`；普通构建允许未配置的开发版本，
因此不能只依赖普通构建成功来判断已启用。

测试封禁只使用独立测试密钥、测试地址和隔离配置，不用生产密钥给真实插件发布演练
封禁。正式客户端验收应确认启动读取基线、插件页“检查更新”可成功同步、状态刷新正常。
没有实现此机制的历史宿主必须升级；仅更新插件不能给旧宿主补上此能力。

### 8. 日常续签：每 7 天一次

14 天是签名文件的有效期；12 小时是客户端检查间隔；24 小时是新外部包首次激活所需的
最近成功检查时间。三者不同。规则未变也应每 7 天续签一次，为失败重试留出时间；
到期前 72 小时尚未续签时应由维护侧监控提醒。本手册不创建定时任务。

先核对最新成功版本，再从它生成下一份正文，保留所有活动及已撤回公告：

```sh
node --import tsx --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { verifySecurityPolicy } from './src/core/plugin/security/policy-verifier.ts'
const home = process.env.MOTRIX_POLICY_HOME
const publicKey = readFileSync(path.join(home, 'keys/policy.public.pem'), 'utf8')
const previous = verifySecurityPolicy(readFileSync(path.join(home, 'artifacts/current.signed.json'), 'utf8'), [publicKey])
const now = Date.now()
const next = { ...previous, revision: previous.revision + 1,
  issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 14 * 86400_000).toISOString() }
const file = path.join(home, `policies/rev-${next.revision}.json`)
writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log('Next revision:', next.revision, 'Draft:', file)
NODE
```

记录命令打印的版本号。需要禁用或撤回时，按步骤 9/10 编辑这份 JSON；普通续签不改
`advisories`。下面的 `2` 只是第一次续签示例，改为刚打印的版本号：

```sh
export MOTRIX_POLICY_REVISION=2
node --import tsx scripts/sign-plugin-security.mjs \
  --input "$MOTRIX_POLICY_HOME/policies/rev-$MOTRIX_POLICY_REVISION.json" \
  --key "$MOTRIX_POLICY_HOME/keys/policy.private.pem" \
  --previous "$MOTRIX_POLICY_HOME/artifacts/current.signed.json" \
  --output "$MOTRIX_POLICY_HOME/artifacts/rev-$MOTRIX_POLICY_REVISION.signed.json"
export MOTRIX_POLICY_CANDIDATE="$MOTRIX_POLICY_HOME/artifacts/rev-$MOTRIX_POLICY_REVISION.signed.json"
```

重复步骤 3 的**验证命令**（使用刚设置的候选路径），再执行步骤 4
的发布流程和步骤 5 的公网核对。仅在发布成功后更新 `current.signed.json`。
写文件报 `EEXIST` 表示文件已存在，先核对现有产物；不要为了重跑而覆盖已发布历史。

### 9. 紧急禁用插件

先执行步骤 8 的“生成下一份正文”，然后向 `advisories` 追加公告。下面是虚构插件示例：

```json
{
  "id": "MTX-2026-001",
  "status": "active",
  "reason": "vulnerability",
  "affected": [
    { "kind": "plugin", "pluginId": "example.demo", "fromInclusive": "1.0.0", "beforeExclusive": "1.2.0" }
  ],
  "fixedVersion": "1.2.0"
}
```

该规则覆盖 `1.0.0 <= version < 1.2.0`，预发布版本按 SemVer 顺序比较；不受影响的
`1.2.0` 不会因为这条 ID/版本规则被禁用。只有修复包确已可用时才填写 `fixedVersion`。
恶意插件可用 `reason: "malware"`，分发渠道失陷可用 `"compromised"`；若需要禁用某 ID
的全部版本，省略版本上下限。可选公告链接必须是已发布的 HTTPS `motrix.app` URL。

要匹配已确认有问题的完整安装包，计算 `.moext` 哈希：

```sh
node --input-type=module - /path/to/affected.moext <<'NODE'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
console.log(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'))
NODE
```

再向 `affected` 添加 `{ "kind": "archive", "sha256": "<实际的 64 位小写十六进制哈希>" }`。
条件之间是“或”，不是“且”。旧版解压安装可能没有包哈希，因此通常同时提供 ID/版本
规则；重新打包会改变哈希，本机制不会自动识别未知恶意变体。

复核后完成步骤 8 的签名和步骤 4/5 的发布验证。在线客户端通常在下一轮检查发现，
最慢约 13.2 小时再加 CDN/网络延迟；这不是实时推送或绝对送达承诺。用户可以主动
“检查更新”，但不能只靠刷新页面立即获得新规则。离线客户端无法收到新规则。

### 10. 撤回误封或发布修复

生成更高版本正文，找到原公告，只把 `status` 改为 `withdrawn`，保留 `id` 和原始
`affected`。范围需要更正时，撤回旧 ID，同时使用新 ID 添加更正后的公告。
不要删除记录、修改旧版本产物、回传旧策略或将版本号归零。

同一插件若仍命中另一条活动规则，仍会被禁用。确认修复版本处于全部活动规则之外后，
正常发布修复插件即可解除相应匹配；仅设置 `fixedVersion` 字段不会自动豁免或安装。
撤回后配置和用户启用偏好保留，后续按正常激活流程执行；已经终止的历史投递不重放。

### 11. 计划内密钥轮换

1. 用步骤 2 的生成代码创建新密钥，先把两个输出文件名改为
   `policy-next.private.pem` / `policy-next.public.pem`，不要覆盖旧密钥。
2. 先发布同时包含新旧公钥的宿主版本；旧密钥仍保留在 `publicKeys` 中。
3. 为需要继续支持的旧宿主保留双签：执行步骤 8，用旧密钥签署下一版本，然后对
   **同一份正文**用新密钥签署，并合并信封：

```sh
node --import tsx scripts/sign-plugin-security.mjs \
  --input "$MOTRIX_POLICY_HOME/policies/rev-$MOTRIX_POLICY_REVISION.json" \
  --key "$MOTRIX_POLICY_HOME/keys/policy-next.private.pem" \
  --previous "$MOTRIX_POLICY_HOME/artifacts/current.signed.json" \
  --previous-public-key "$MOTRIX_POLICY_HOME/keys/policy.public.pem" \
  --output "$MOTRIX_POLICY_HOME/artifacts/rev-$MOTRIX_POLICY_REVISION.new-signed.json"
node --import tsx --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { verifySecurityPolicy } from './src/core/plugin/security/policy-verifier.ts'
const home = process.env.MOTRIX_POLICY_HOME
const rev = process.env.MOTRIX_POLICY_REVISION
const read = (file) => readFileSync(path.join(home, file), 'utf8')
const oldEnvelope = JSON.parse(read(`artifacts/rev-${rev}.signed.json`))
const newEnvelope = JSON.parse(read(`artifacts/rev-${rev}.new-signed.json`))
if (oldEnvelope.payload !== newEnvelope.payload) throw new Error('Payloads differ')
const dual = JSON.stringify({ payload: oldEnvelope.payload,
  signatures: [...oldEnvelope.signatures, ...newEnvelope.signatures] }) + '\n'
for (const name of ['policy', 'policy-next']) {
  verifySecurityPolicy(dual, [read(`keys/${name}.public.pem`)])
}
writeFileSync(path.join(home, `artifacts/rev-${rev}.dual-signed.json`), dual,
  { flag: 'wx', mode: 0o600 })
console.log('Dual signature verified with each key independently')
NODE
export MOTRIX_POLICY_CANDIDATE="$MOTRIX_POLICY_HOME/artifacts/rev-$MOTRIX_POLICY_REVISION.dual-signed.json"
```

4. 发布 `.dual-signed.json` 候选并执行步骤 5 核对。支持期内每次续签和规则更新都保持
   双签。只信任旧公钥的客户端无法验证仅用新密钥签署的策略。
5. 旧宿主支持期结束后，审核切换到仅新密钥签名的计划；相应更新本地验签/签名路径、
   发布工作流和宿主公钥集，归档旧私钥。不要在新宿主普及前直接移除旧签名。

若私钥已经泄露，这不是普通轮换：攻击者也可能签发更高版本。立即停用受影响的签名/
发布凭据，通过可信宿主更新移除失陷公钥并接入新的审核基线；本协议没有在线撤销内置
公钥的能力，双签不能恢复只信任失陷密钥的旧宿主的安全性。

### 12. 常见故障与验收记录

| 现象 | 处理 |
| --- | --- |
| `not provisioned` / 强制配置检查退出 1 | 检查步骤 6，不能把开发模式构建成功当作已启用 |
| HTTPS 404 或重定向 | 核对 Worker 路由、对象名和实际发布记录；不要重置版本 |
| `Untrusted security policy signature` | 核对公钥指纹、签名用途、轮换阶段和原始文件；不要关闭验签 |
| `rollback` / `revision reused` | 使用最新成功版本作为前序，增加版本号并重新签名 |
| `removed or narrowed without withdrawal` | 保留旧记录及匹配条件，用 `withdrawn` 撤回 |
| `expired` | 保留公告，更新日期和版本，重新签发；304 不会续期 |
| 新插件提示联网，已有插件可用 | 检查最近成功同步是否超过 24 小时，或签名是否过期 |
| 缓存损坏或磁盘不可写 | 检查宿主 `plugin:security` 日志及磁盘，恢复可信同步；不要删缓存绕过禁用 |
| 发布成功但客户端仍旧 | 核对 ETag、缓存、宿主版本、12 小时调度和网络退避 |

每次发布留下：正文/信封、版本、有效期、公钥指纹、产物 SHA-256、前序版本、审核记录、
工作流结果和公网核对结果。密钥仅留在密钥保管系统，不随这份记录归档到代码库。
