# Motrix v1.8.19 测试样本

这些样本由官方 Motrix `v1.8.19` Git 树中实际随应用发布的
**aria2 1.36.0 可执行文件**生成。生成器从 Git 提取该文件，检查 SHA-256
后再运行，不使用当前 Motrix 引擎、相邻引擎工作区或真实用户配置。
可执行文件本身不提交到仓库。

在 macOS arm64 上，从仓库根目录运行：

```sh
node tests/fixtures/legacy-v1/generate.mjs
```

本地仓库须包含标签 `v1.8.19`，对应提交
`a0a1fe90f7e9f6d305ed2b512f62c8d36c2fb95a`。权威可执行文件路径为
`extra/darwin/arm64/engine/aria2c`，Git 对象为
`f4a274061acbbc22c6eb1ab487ffdc0e80ad1b71`，SHA-256 为
`1527c4d071c16c1266880e93750e385cdd4e9d2a950d7f56cb5a21125e3bd311`。
源码参考：[官方 Motrix v1.8.19 Git 树](https://github.com/agalwood/Motrix/tree/v1.8.19)。

生成器建立临时配置目录及独立的下载目录，与普通安装的目录关系一致。
HTTP、RPC 和 tracker 都只监听回环地址，并关闭 DHT、PEX 和局域网发现。
HTTP 内容及包含两个文件的私有种子都是生成的测试数据，不含私人令牌、
tracker、凭据或用户路径。

`download.session`、两份 `.aria2` 以及 RPC 保存的 `.torrent` 均为旧引擎
的真实输出。`.aria2` 和 `.torrent` 字节没有修改。`partial.bin.gz` 是实际
部分 HTTP 下载文件的 gzip 压缩版本，解压后的字节未作修改。文本中的配置、
下载目录前缀和 HTTP 端口使用占位符；种子保留生成时的回环 tracker 端口。
重新生成时端口、未完成块边界及种子文件名可能变化，`provenance.json`
记录每份结果的摘要及来源引擎身份。

`user.json` 和 `system.json` 是从标签中的 `ConfigManager.js` 求值获得的
默认配置，使用临时路径及英文区域设置。它们**不代表运行完整旧版 Electron
应用生成的配置**。引擎使用这些默认配置和标签中的 `aria2.conf` 启动，并
应用生成器中明确列出的回环网络隔离选项。

RPC 保存的种子文件名是整个元信息文件的 SHA-1，与种子的 info hash 不同。
会话引用的种子位于配置目录授权范围之外。扫描测试验证这种真实布局会产生
不可选择的 `metadata-required` 项，不会根据 `system.json` 读取任意下载
目录。另一个明确标注的测试变体把元信息放入授权范围，用于验证解析与文件
选择。原始外部目录布局需要用户额外授权所引用的种子文件后才能导入。

这些样本证明了对该标签引擎序列化格式的兼容性，不证明跨平台安装包迁移、
历史 HTTP 校验信息可用性，或任意旧文件的安全续传。
