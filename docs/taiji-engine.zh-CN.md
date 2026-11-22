# taiji 引擎与迁移

[English](./taiji-engine.md) | 简体中文

桌面端与 Server 使用同一套随应用分发的 taiji 引擎，不会回退到 aria2 或系统下载引擎。
引擎 RPC 使用 `taiji.*` 命名空间，浏览器扩展与 Motrix CLI 继续使用 MDXP。

## 升级已有配置

升级前请备份配置目录和下载目录，并退出旧版 Motrix。新版本会在启动引擎前将
`aria2.db` 导入独立的 `taiji.sqlite3`；此前设置过的旧引擎数据库路径仍会作为导入来源。
源数据库只读打开，迁移保留任务 GID、暂停意图、输出路径映射及支持的 HTTP 请求状态。
Motrix 任务历史仍保存在 `motrix.db`。

具有可用检查点的 HTTP 未完成文件会采用 taiji 的 `.part` 文件名，已有字节会保留。
如果需要退回旧引擎，请同时保留下载文件备份和旧配置备份。

启动时，taiji 会冻结恢复出的下载、校验和做种队列。Motrix 先清理已完成任务的引擎归属，
保留隔离任务的暂停状态，并检查 Server 目录权限，再放行可恢复的任务。原本暂停的任务
不会自动开始。迁移中断后可以重试，成功后才写入迁移凭据。源数据库被改动、未知数据结构、
任务身份冲突、凭据缺失或未完成文件路径冲突都会阻止迁移，不会覆盖已有任务。
已有迁移凭据但 taiji 数据库丢失时，也会停止启动，要求先恢复数据库备份。

新引擎自行管理 SQLite 持久化，旧的数据库启用开关、数据库路径和引擎历史条数不再提供
编辑入口。进度检查点间隔和 RPC 设置仍可配置。taiji 的写操作要求认证，旧配置中若没有 RPC 密钥，
会自动生成并保存新密钥。节点连接与 DHT 共用监听端口；磁盘分配和缓存由 taiji 自动管理，
不再显示旧引擎的分配方式和缓存大小控件。

自动引擎迁移支持 `aria2.db` 的 schema 1–6。Motrix 1.x 的 `.aria2` 控制文件导入
仍保持隔离，不会自动激活。本版 taiji 尚不支持 SFTP；不支持的操作会明确失败，不会回退引擎。

## Magnet 连接

Fetching 阶段支持 TCP、uTP、入站 metadata 连接、PEX，以及 BEP55 `ut_holepunch`。
支持介绍其他 peer 的节点，即使自身无法提供 metadata，也可以保留连接。需要打洞时，
Motrix 会先将中继连接从 TCP 切换到 uTP，再请求双方建立连接。优先传输协议获得
短暂先行时间后即可尝试备用协议；明确指定仅 TCP 或仅 uTP 时仍遵守该限制。
PEX 中的能力标志可用于提前触发打洞。

多个 magnet 共用会话级监听端口和活跃的 IPv4/IPv6 DHT 路由表。Metadata 分块由
多个 peer 协作获取，限制在途请求数，并对缺失分块重新分配请求；超时以实际进展
判断，慢 peer 或断线不会丢弃其他 peer 已提供的数据。验证通过的 metadata 在会话
内缓存，最多 128 条、16 MiB，复用时使用新 magnet 的 tracker 列表。链接明确提供的
HTTP(S) `xs`、`fl`、`as` 来源会与 peer 发现并行，并须通过身份及所需 v2 layer 校验。
不会默认启用公共 metadata 缓存服务。

Metadata-only 获取有独立的 4 个并发槽位，普通下载队列满时仍可获取文件列表，暂停
和启动恢复保护继续生效。仅取 metadata、保存/加载 metadata、跟随下载和获取后暂停
等选项在任务创建时即持久化，并在重启后恢复。

桌面端和 Server 都通过共享 NAT 管理器映射实际监听端口。网关分配结果会传回 taiji，
让 tracker、DHT 和 peer 宣告对应的外部端口。映射结果跟随监听实例更新；额外端口在监听停止后
清理，桌面端的共享基础端口映射仍由 NAT 服务管理。共享 metadata 监听在整个会话
期间保留，包括两次获取任务之间。穿透 NAT 仍需要可达的 peer 或合适的中继，不能恢复已经没有资源的种子。

可复现测试使用 Linux 网络命名空间、两个 SNAT 路由器、libtorrent peer 和 miniupnpd。
安装并启动 Docker 后运行：

```sh
node tests/nat/run.mjs

# 同时运行延迟和故障矩阵；可选基线为同架构的旧版 Linux 引擎，
# 以只读方式挂载到测试容器。
node tests/nat/run.mjs --performance --samples 5 --baseline /path/to/previous/taiji
```

命令会在隔离的特权容器中构建锁定的引擎源码，执行开启和关闭功能的对照实验，校验
metadata 身份，并检查外部端口冲突后的分配、续租和清理。容器权限用于内部网络命名
空间和防火墙，不修改宿主机路由。证据和抓包保存在 `output/taiji-nat-lab/`。
测试覆盖指定 SNAT 拓扑，不代表所有路由器或对称 NAT 都能穿透。

## 编辑下载来源

任务详情的“概览”页支持编辑 HTTP/FTP 下载来源和 BitTorrent Web Seed，每行一个 URL。
HTTP/FTP 任务至少保留一个来源，且各来源必须提供同一文件；清空 Web Seed 后仍可从 peer
下载。修改会保留任务身份，运行中的传输会重新连接。HTTP 只有通过资源与输出身份校验后，
才会复用已有下载检查点。

修改后的列表会在重启和任务恢复后保留。清空的 Web Seed 在重新添加种子时仍保持为空，
原始种子 metadata 和 infohash 不变。磁链的 `ws=` 来源会在获取 metadata 后带入种子任务。
获取 metadata 后，排队、暂停、下载或做种中的任务可编辑来源；隔离的旧任务和已完成历史
只读。其他客户端已修改列表时，请重新加载后再应用。桌面端与 Server 行为一致，Server
还会检查下载目录写入权限。

Tracker 编辑会保留种子原始 announce 层级、手动添加的地址及已排除的补充地址。
磁链选文件时，确认后的补充 tracker 会在开始下载内容前应用。

## 重命名种子文件

在种子任务的“文件”页，点击文件旁的重命名按钮。排队、暂停、下载及做种中的任务均可使用。
活动传输会短暂重新连接，任务身份、原始种子 metadata 和已下载分块保持不变。
填充文件和等待文件选择的任务不可编辑。已完成历史只读，可先重新做种再修改文件名。

请输入不含文件夹路径的文件名；引擎会拒绝已被占用的目标。Motrix 会等待引擎确认新路径后
再显示成功。新名称会在重启、重试和重新做种时保留，应用在接收结果前中断也能恢复。
Server 使用同样的入口，并检查操作员身份与目录权限。整个种子文件夹的位置仍通过存储管理调整。

Motrix 按任务管理默认 tracker，并设置 `bt-tracker-apply-existing=false` 关闭 taiji 的全局热更新。
引擎对私有种子的全局 tracker 豁免继续生效。

## 从源码构建

请安装项目要求的 Node.js 与 pnpm、Git、Rust 1.94.1 或更新版本，以及目标平台的
Rust 标准库。Linux 构建还需要用 `musl-tools` 编译 C 依赖。常规开发与打包命令通过
`pnpm run fetch:engine` 构建锁定的引擎。

```sh
# 获取锁定的上游提交，并构建 release 版本。
pnpm run fetch:engine

# 从现有本地 taiji 仓库读取锁定提交。
node scripts/build-taiji.mjs --source /path/to/taiji

# 本地引擎测试可使用 debug 版本；打包要求 release 构建凭据。
node scripts/build-taiji.mjs --source /path/to/taiji --debug
pnpm exec vitest run src/core/engine/taiji
```

构建不会修改传入的仓库，而是在独立缓存中验证上游提交和 Cargo 锁文件。
Motrix 直接构建 taiji 上游源码，不再维护下游集成补丁。
`scripts/taiji-source.lock.json` 固定源码，`scripts/engine.lock.json` 定义普通
SemVer 引擎版本及目标平台；两边仓库同步维护同一套固定 RPC 接口。

产物位于 `extra/<platform>/<arch>/`，包含 `taiji`（Windows 为 `taiji.exe`）、
`taiji-build.json` 和 `taiji-licenses.txt`。打包校验覆盖源码身份、release 构建模式、
原生架构、二进制摘要与许可证摘要。Server 可用 `MOTRIX_TAIJI_BIN` 显式指定引擎位置，
指定的二进制必须实现锁定的 Motrix 集成契约。

Server 产物体积预算为 64 MiB，包含源码构建的引擎及其许可证；本地 macOS arm64
暂存包约为 55.9 MiB。依赖体积与原生库数量继续独立校验。
