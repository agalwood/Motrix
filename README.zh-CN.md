# @motrix/torrent

用于 BitTorrent v1、v2 和 hybrid 元数据的 TypeScript/ESM 库。不执行网络或文件
IO，不依赖 Node API、Buffer、fetch、Streams 或 WebCrypto。SHA-1 和 SHA-256
由 `@noble/hashes` 实现，在非安全 HTTP 浏览器环境中也能工作。本项目是元数据
库，不是下载引擎，也不实现 peer-wire 协议。

```sh
npm install @motrix/torrent
```

```ts
import { parseTorrent, parseMagnet } from '@motrix/torrent'

const metadata = parseTorrent(bytes) // Uint8Array, synchronous
switch (metadata.identity.kind) {
  case 'v1':
    console.log(metadata.identity.sha1)
    break
  case 'v2':
    console.log(metadata.identity.sha256)
    break
  case 'hybrid':
    console.log(metadata.identity.sha1, metadata.identity.sha256)
}
const piece = metadata.v1?.pieces.at(0) // borrowed 20-byte view
const magnet = parseMagnet('magnet:?xt=urn:btmh:1220' + 'ab'.repeat(32))
```

包内包含 ESM JavaScript 和 TypeScript 声明，支持 tree-shaking。公开入口为
`@motrix/torrent`、`@motrix/torrent/bencode` 和 `@motrix/torrent/magnet`。
运行环境为 Node.js 22.12+、Electron 和现代浏览器，唯一运行时依赖是
`@noble/hashes`。[English](README.md)

## 解析约定

- bencode 整数使用 `bigint`，文件长度和偏移保持精确；调用方需要显式检查下载
  引擎的数值范围，才能转换为 `number`。
- 字节串、文件树键、info 字节和 hash 表直接引用输入。在解析结果的生命周期内，
  请勿修改输入或返回的视图。`infoRange` 是原始 info 的半开字节区间。编码器用于
  创建新元数据，不能用来重建已有种子的身份。
- 字典使用二进制键（`BDictionary`），没有对象原型属性碰撞。未知字段和属性保留
  在原始字典中。解码时的查询索引直接引用原始键，条目数受节点预算约束；文件路径
  索引也不会展开为字符串。解析器检查整数、长度、重复键、截断和多余尾随字节，默认要求键
  按原始字节规范排序。
- `allowUnsortedKeys` 可显式接受历史 v1 文件中未排序的字典，同时保留原始 hash；
  它不会允许重复键或非法数字。v2 始终要求规范编码，未知 `meta version` 会报错。
- 默认限制：输入、输出及字节串为 64 MiB；嵌套深度 64；节点数一百万（含键）；
  整数最多 128 位十进制数字。调用方可调低限制，深度上限不能超过 128。
  编码器也执行这些限制。
- v1 检查 piece 数量与拼接后的文件长度是否匹配。v2 检查文件树、piece 大小、根
  hash 和完整 piece layers，并使用零子树 padding 验证 Merkle 根。校验临时内存
  为对数级，不会预先将整个 piece 表展开成十六进制字符串。
- hybrid 的两种布局必须具有相同的文件顺序、长度、symlink 和 piece 对齐。
  padding 和 symlink 语义保持严格校验；隐藏、可执行等提示性属性与未知标志独立
  保留，允许两种视图不同。零字节文件不占 piece 空间，末尾 padding 可省略。这验证的是元数据一致性；
  不读取实际数据，就无法证明 v1 与 v2 的 hash 指向完全相同的内容。
- 完整 `.torrent` 输入必须包含所需的全部 piece layers。与 libtorrent 的部分
  元数据模式不同，缺失层会被拒绝。BEP 9 消息交换和部分元数据拼装不在范围内。
- 保留 private、announce tiers、webseed、注释、创建信息、padding 和文件属性。
  按 BEP 12，显式存在的空 announce-list 也优先于 announce。URL 仅作为元数据；
  调用方负责 URL 校验、tracker 策略、网络访问和 SSRF 防护。
- 路径保持原始字节组件，不会规范化、净化、合并或写入文件系统。v1 路径相对于
  name 根目录；v2 路径遵循 file tree，不自动添加 name 前缀。落盘映射需要针对
  目标平台拒绝或显式处理危险名称与路径碰撞。
- magnet 支持十六进制或 Base32 的 btih、SHA-256 btmh（`1220` multihash）、双
  身份，以及 dn、tr、ws、xs、as、x.pe、BEP 53 闭区间文件选择。区间不会展开为
  巨大数组，未知参数保留；冲突身份和错误转义会被拒绝。上限为 64 Ki 个字符及
  1024 个参数。裸 hash 可用 `normalizeBtih` 处理。
- 不提供 parse-torrent 的对象、20 字节裸 hash、stream-magnet、远程 URL、Blob
  和文件路径重载。调用方先执行 IO，再将 Uint8Array 交给对应解析函数。

## 调用方职责

文件读取、URL 下载、网络目标校验、文件系统映射和下载引擎选择由调用方负责。
例如：

```ts
const metadata = parseTorrent(new Uint8Array(await file.arrayBuffer()))
```

[Motrix 应用](https://github.com/agalwood/Motrix) 通过引擎适配层使用本库。能够解析
元数据，并不代表某个下载引擎能够下载 v2，或同时校验 hybrid 的两种 hash。

## 验证

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec playwright install chromium firefox webkit
pnpm test:browser
```

`pnpm check` 执行 lint、源码和测试的严格类型检查、Node 测试、ESM 构建，并在隔离
消费者中安装和验证实际 npm tarball。验证后的发布包保存在忽略目录 `output/package/`。

测试包含 libtorrent 独立预期、与仅用于测试的 parse-torrent 11.0.24 对照、异常
输入、确定性往返属性测试和字节模糊测试。Chromium、Firefox、WebKit 在拦截的非
loopback HTTP 源上验证编译后的 ESM，无需 WebCrypto。浏览器结果保存到
`output/playwright/manual/torrent-core/`。版本和许可见
[fixture 来源说明](test/fixtures/README.md)。

实现从 [Motrix 源码快照](https://github.com/agalwood/Motrix/tree/a2aae7a02e4b93190ee6ff5aceae1c7429ffd30f/packages/torrent)
提取，保留了包的 Git 历史。npm 包独立维护。

协议参考：[BEP 3](https://www.bittorrent.org/beps/bep_0003.html)、
[BEP 9](https://www.bittorrent.org/beps/bep_0009.html)、
[BEP 12](https://www.bittorrent.org/beps/bep_0012.html)、
[BEP 19](https://www.bittorrent.org/beps/bep_0019.html)、
[BEP 27](https://www.bittorrent.org/beps/bep_0027.html)、
[BEP 47](https://www.bittorrent.org/beps/bep_0047.html)、
[BEP 52](https://www.bittorrent.org/beps/bep_0052.html)、
[BEP 53](https://www.bittorrent.org/beps/bep_0053.html)。
