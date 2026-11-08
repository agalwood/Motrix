# 群晖 DSM 原生 Motrix

Motrix 可直接在 NAS 上下载文件和种子。这个实验性原生 SPK 内置 Node.js、
Motrix Server/Web UI、aria2 和文件系统辅助程序。运行时不依赖 Docker，安装时
不下载依赖、不运行 npm。作者：[Dr_rOot](https://github.com/agalwood)。

请通过**套件中心 → 手动安装**安装对应 SPK，并先核对旁边的 `.sha256` 文件。
本套件**尚未上架群晖套件商店**，不能将它描述为可从官方商店安装。

## 支持范围

提供 **DSM 7.2.2-72806 及以上**的 x86_64 和 ARM64 手动安装包。第一版采用**管理员共享实例**：
所有获授权的本地 DSM 管理员共同管理同一组任务、设置和插件。普通账号、已停用
账号、域账号和 LDAP 账号不能访问。目前没有按用户隔离任务或分别计算配额。

同一个 ARM64 SPK 包含一套 AArch64 程序，套件中心按下表中的三个 Package Arch 识别兼容平台。机型来自[群晖 DSM 固件归档](https://archive.synology.com/download/Os/DSM/7.2.2-72806-9)。

| Package Arch | 机型 |
| --- | --- |
| rtd1296 | DS118、DS218、DS218play、DS220j、DS418、DS418j、DS420j、RS819 |
| rtd1619b | DS124、DS223、DS223j、DS423 |
| armada37xx | DS119j、DS120j |

这三个官方 sysroot 分别验证同一个包，CPU 指令测试使用 Cortex-A53 模拟。低内存机型还需要实测内存压力。单独的 `rtd1619` 在锁定的 DSM SDK 目录中缺少对应工具链。ARMv7/32 位不在本包范围内。DS718+ 和 DS423+ 使用 x86_64 包。[工具链目录](https://archive.synology.com/download/ToolChain/toolchain/7.2-72806) · [群晖平台映射](https://help.synology.com/developer-guide/appendix/platarchs.html)

**2.3.0-11 仪表盘**。DS718+ 上的 2.3.0-10 在健康的活动记录刷新期间也显示过期提示，实测日历高度从 186 降至 162 像素。新版最终 ARM64 SPK 在隔离 Chromium 和模拟 DSM 网关中经过了同样的票据续期。597 像素宽的日历显示 12 个月份标签和 3 个星期标签，引擎标题保持 Ready。真正的快照请求失败时，提示与重试按钮出现在标题栏，网格位置和大小保持稳定。此项验证使用 Linux 容器，尚无 2.3.0-11 实机验收。

**2.3.0-12 仪表盘实机验收**。DS718+（DSM 7.4.1）从第 10 版升级后，新加载的
Dashboard 只申请了 1 次建连票据。在同一条已打开的 WebSocket 上直接监听了 110 秒，
收到 3 次续期通知，每次均返回 HTTP 204，期间没有关闭连接或申请新建连票据。
连续 180 秒观测中，Activity 日历始终为 597 × 186 CSS 像素，12 个月份和 3 个星期标签
均可见，位置稳定。没有出现过期提示，Engine 标题始终为 Ready。

![DSM 实测宽度下的活动日历，含月份和星期标签](../../screenshots/motrix-dsm-dashboard-activity.png)

2026-11-07，**DS718+（DSM 7.4.1）** 从 2.3.0-9 手动升级到 **2.3.0-10** 后，
通过了同名目录替换测试。HTTP 任务向明确授权的测试目录写入 27,648 字节。
把目录移走，在原路径放入另一个目录和同名文件后，Motrix 拒绝了旧任务的读取和删除，
两份文件的哈希均未改变。重启后套件进入修复页，引擎停止，再次保存相同路径也无法
转移原授权。放回原目录并重启后，原任务的 HEAD 和 GET 都返回 200，
下载内容的 SHA-256 与源文件一致，此时可以正常删除任务及原文件。

2026-11-07，**DS718+（Apollo Lake，DSM 7.4.1）** 通过套件中心从 **2.3.0-8
原位升级到 2.3.0-9**。实机上的构建提交与已校验的 SPK 一致，从 DSM 打开 Motrix
可进入管理员仪表盘。将一个已授权的空测试目录改名后，重启套件进入目录修复页，
下载引擎停止，直连端口关闭，匿名请求看不到目录路径。管理员在修复页恢复原授权
列表并重启套件后，服务和引擎均恢复就绪。
通过 Web UI 下载的 33,280 字节 HTTP 文件写入了恢复后的目录，文件属主为 `motrix`，
SHA-256 与源文件一致。勾选同时删除文件后，任务和文件均已移除。

实机安装的 Chrome 扩展 0.1.23 发起配对后，同一管理员的两个标签页都在集成设置中看到
请求，只有点击认领的页面收到配对码。扩展在请求发起 99 秒后提交配对码，成功
通过 WSS 连接并读取活动任务列表。撤销测试凭据后，连接断开。验收结束时，扩展
已切回原后端，Motrix 没有测试任务，HTTP 配对码和 WSS 入口已关闭，直连端口为 16802。

此前 **2.3.0-8** 已通过管理员登录、套件设置、客户端端口配置、NAS 种子选择、
File Station 定位、HEAD/Range 文件读取、定向文件删除及历史任务保留。
4 MiB HTTP 下载在 2.3.0-6 → 2.3.0-7 原位升级后继续完成，SHA-256 与源文件一致，
2.3.0-8 还修复了旧 HTTP 历史任务缺失的单文件元数据。

此前 2.3.0-5 已通过实机 HTTP/BT 下载、重新下载、目录与符号链接拒绝、非 root
进程检查，以及 CLI 协议配对和撤销。验收后已清理合成任务、测试文件及临时服务，
直连端口恢复为 16802，扩展入口保持关闭。这不表示所有 DSM 版本或机型均已兼容。

Linux 模拟和固定校验和的 Gemini Lake/Apollo Lake DSM 7.2.2 用户态 ABI 检查也已
通过。最低版本表示工具链与资源接口范围。实机内核为 Linux 4.4.302，
[Node 24 官方支持的 Linux 内核基线](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)
更高；基础操作已通过，但长时间下载、真实账号停用/重建、ACL 撤销、物理存储卷卸载或替换、
文件提交中断等仍需受控实机测试。官方 Motrix CLI 0.5.0 已通过 DSM HTTPS 网关
完成配对并执行 `list` 和 `stats`。重启套件后，同一凭据先收到 HTTP 403，管理员
重新打开 Motrix 后恢复为 HTTP 200。撤销凭据后收到 HTTP 401。测试容器将证书域名
解析到 NAS 内网 IP，并验证了 TLS 证书链和名称。Mac 将证书域名解析到 NAS 内网 IP 后，
Chrome 扩展 0.1.23 已通过 WSS 配对。管理员认领配对码后在扩展中输入。套件重启并
重新验证 DSM 会话后，扩展使用原凭据重连，成功查询任务和统计，通过弹窗添加并删除
了 51 字节测试下载，文件 SHA-256 与源文件一致。撤销后连接断开，任务查询被拒绝。
ARM64 的验证范围见下方机型表，尚无 ARM 群晖实机验收。

## 使用与权限

使用本地管理员账号登录 DSM 后，从桌面打开 Motrix。入口沿用 DSM 的主机名和
端口，路径为 `/motrix/`，包括 HTTP、WebSocket 和静态资源。无需安装 Web Station；有效 ACL 查询需要 File Station 可用。
应用没有单独的登录密码，也不收集 DSM 密码。套件通过 DSM 官方权限机制加入 `http` 组，
仅将上游 socket 设为 `motrix:http`、权限 `0660`，供非 root Nginx 网关连接。
配置和应用数据仍仅限套件账号访问；组成员身份不能替代会话和账号认证。

Web 服务、下载引擎、插件和文件系统辅助程序均以 `motrix` 套件账号运行。
套件没有 root 进程，不申请 setuid、Linux capability、sudo 规则或特权辅助服务。
DSM 资源管理器负责创建 `motrix` 共享文件夹和注册 Nginx 配置。
`http` 组还允许连接 DSM 已有的本地 SCGI socket。适配层只调用固定的系统接口：
`login.cgi` 获取当前会话的 SynoToken，`SYNO.Core.NormalUser.get` 识别会话所有者，
`SYNO.Core.User.get` 查询该本地账号的 `expired` 状态。非特权 `id` 命令独立核对
UID 和当前是否属于管理员组 101。File Station `List.getinfo` 返回指定路径的
有效 ACL 权限，返回的实际路径必须与请求完全一致。适配层不能调用读取文件内容或
修改 DSM 设置的接口；诊断不会返回原始响应或凭据。

下载范围同时受已配置目录、管理员账号权限和套件账号权限约束。授权目录必须
存在、位于已挂载存储卷中，且不能通过符号链接改指其他位置。默认目录从
`/var/packages/Motrix/shares/motrix` 解析；存储离线时不会在系统卷重建替代目录。
从第 10 版开始，套件会记录每个授权根目录的文件系统设备号和 inode，在启动和文件操作时核对。
即使在保存设置后、重启前换入同名目录，新目录也不能继承原授权。可将原目录放回原位，
或为替代目录选择不同的路径并重新授权。旧版配置只有路径，升级后首次确认所有根目录
均可用时，套件才会记录当时的目录身份。
启动时如果有已配置的下载目录缺失或不可访问，Motrix 会打开管理员恢复页面。请恢复
这些目录或修改授权列表，再到套件中心重启 Motrix。恢复页面运行期间，下载引擎、
插件和客户端入口暂停，任务数据库和恢复日志保持原样。套件所在存储卷及套件自己的
数据目录仍须可用。

在 **设置 → NAS** 中管理授权目录和客户端连接。先在 DSM 共享文件夹权限中，
给内部系统用户 `motrix` 授权；再将 `/volume1/downloads` 等已有路径加入 Motrix
授权目录列表，点击应用，并在套件中心停止后重新启动 Motrix。变更会等待旧引擎
停止后生效，界面会显示待生效设置和当前连接地址。多人同时修改时，需要重新
加载最新配置，避免覆盖他人的变更。目录选择器只浏览已授权范围，选择本身不会授权。
后端会在新增任务、恢复、重新下载、BT 文件选择和删除时重新检查权限。

可上传本机 `.torrent` 文件，也可从已授权的 NAS 目录选择种子。已完成的单文件
任务支持 **下载到本机**，服务端使用经过身份核对的文件句柄读取，并支持 HTTP
Range 续传。**在 File Station 中显示** 会打开任务所在目录；该启动链接已在
DS718+、DSM 7.4.1 验证，其他版本仍需实机验收。尚未注册 File Station 的
`.torrent` 右键关联。

第 13 版会记录每个任务实际使用的下载目录。打开已完成的文件或删除下载内容时，Motrix 会核对原始落盘记录或经过校验的种子文件。旧任务或未完成的下载如果缺少文件归属记录，可以选择仅移除任务并保留文件。已有的 BT 下载可以使用原始种子重新定位或校验。多文件种子目录内有其他文件时，Motrix 会保留整个目录。

引擎启动时先暂停载入持久化任务，核对任务归属、实际落盘路径及当前目录授权，
再恢复之前正在运行的合法任务。无法确认归属或已失去授权的引擎任务保持暂停。
自动重建引擎中丢失的任务时，也会重新检查目录授权。
目录授权和账号/ACL 状态会在操作入口刷新。删除复用现有基于目录句柄的文件
系统辅助程序、文件身份检查和持久化恢复日志。撤回授权不会立即取消下载引擎
已经打开的文件；撤回后台下载目录授权前请先停止套件。实机仍需验证 DSM ACL
继承、挂载点替换、存储离线和文件提交中断。

## 客户端配对

安装向导设置直连客户端端口，默认 **16802**。在 **设置 → NAS** 中可复制
沿用 DSM HTTPS 地址的 CLI 入口，路径为 `/motrix/client`。网关仅转发既有 CLI
协议接口，不转发 DSM Cookie；直连端口仍可使用和调整。

浏览器扩展入口默认关闭。可在 **设置 → NAS** 中启用，建议地址沿用当前 DSM
地址和 `/motrix/bridge` 路径，HTTPS 对应 WSS。高级连接设置支持另行配置的公网
地址，Motrix Web 地址必须包含 `/motrix/`。两个客户端地址应使用 DSM HTTPS 证书
覆盖的域名，并在局域网 DNS 中将该域名解析到 NAS 内网 IP。直接填写 IP 时，证书
必须包含该 IP。即使浏览器已打开 DSM 页面，Chrome 扩展后台也会独立校验 TLS 连接。
通过 HTTP 显示配对码需要明确许可。
配置的 Origin 必须与当前页面一致，填写 HTTPS 地址不代表可在 HTTP 页面显示码。
应用设置后需停止并重新启动套件。无效配置会关闭扩展入口。
沿用现有 CLI device-code 和扩展 MBP1 协议。在 **设置 → 集成 → 浏览器扩展配对请求**
可找到仍在有效期内的请求。配对界面显示当前账号，按钮为
**使用当前账号配对**；下一步需要在浏览器扩展中输入配对码。服务端核对页面
预期账号与当前可信身份。共享通知不包含配对码，只有认领者能取得配对码。

客户端凭据绑定本地账号 ID 和账号数据库版本。每次客户端请求均重新查询可信
账号状态；停用、过期、降权、记录缺失或查询失败都会拒绝访问。root 所有的
passwd/group 数据库发生任何变化时，会保守地让全部既有绑定失效，包括 UID
被复用的情况，此时需要重新配对。明确撤销凭据仍走既有协议。DSM 会话 Cookie
不会写入配对状态，也不能作为 CLI 凭据使用。内存中最多保留 64 个会话上下文，
达到上限时淘汰最久未使用的上下文；每次客户端操作都会实时核对 DSM 会话和账号。
退出 DSM、会话过期、上下文被淘汰或 Motrix 重启后，对应管理员需重新打开 Motrix。
升级保留配对凭据和任务，但账号提供新的已验证会话前，客户端操作均被拒绝。Web 事件票据只能使用一次，绑定
当前 Origin 并短期有效。从第 12 版起，DSM 仪表盘可以在同一条 WebSocket 上持续接收事件。
每个授权窗口最长 60 秒。约 45 秒时，服务器只向该连接发送一次性随机值，浏览器通过
同源 HTTPS 携带当前 DSM 会话应答。账号、账号版本和 Origin 均匹配后续期。
错过期限、会话失效或账号变化会关闭事件流。网络断开或套件重启后仍需重新连接。
旧版页面缺少续期支持，会在原期限到达时重连。

无法验证账号时，页面会显示有限的诊断，例如
`account / rejected` 或 `account / commandFailed / accessDenied`。
已登录的浏览器访问 `/motrix/rpc/auth/status` 也可获取这些状态；其中不包含 Cookie、
令牌、账号名或命令原始输出。认证和账号检查失败时仍拒绝访问，诊断不是授权回退。
代理会传递 CGI 协议和端口，后端补充经过长度校验的主机与浏览器信息，供 DSM 本地 API 使用。

## 生命周期与数据保留

套件生命周期脚本以套件账号执行，通过 `flock` 串行化。进程记录包含 PID、
进程出生时间、启动标识，以及可执行文件和入口检查。停止会等待正常退出，
超时则保留进程记录。升级先停止旧进程，再替换文件，并保留 DSM FHS `var`
目录中的任务数据库、配置、插件、配对绑定和删除恢复状态。下载文件留在共享目录。

卸载默认保留应用数据。明确选择**删除任务、配置和配对信息**后，才会在成功
停止服务后删除套件自己的状态。下载文件始终保留。保留数据后重新安装可恢复
同一个共享实例，但仍需满足当前账号和目录权限。使用第 9 版最终 SPK 的 Linux
模拟验证了两种重装方式。保留数据后，任务数据库和引擎持久化文件的内容逐字节一致，
原任务和设置可用。管理员重新打开 Motrix 后，旧 CLI 凭据可以查询原任务。
选择删除数据后，重装得到空任务列表，旧凭据失效。两种方式均保留了 HTTP 和
BT 下载文件。DSM 负责实际的生命周期顺序和资源清理，全新安装、修复及卸载后的
数据保留仍需实机验收。

## 受控 DSM 实机验收

使用备用 DSM 或隔离的 Virtual DSM。准备一个独立测试管理员和测试共享文件夹，创建一个已完成的小任务，记录文件 SHA-256、任务标识、目录设置和测试客户端的查询结果。保留另一名可登录的管理员。测试凭据只存于临时客户端配置中。

| 场景 | 操作与通过条件 | 对数据的影响 |
| --- | --- | --- |
| 账号降权或停用 | 用测试管理员登录并配对 CLI/扩展，先确认能查询合成任务。从另一个管理员会话将测试账号移出 administrators，再用原网页及原客户端查询，应拒绝；另行重复停用场景。恢复组成员身份并重新登录，按需要重新配对。核对任务及文件哈希。 | 不删除下载文件。账号数据库版本变化可能使其他已有配对也需要重新授权。 |
| 卷离线与恢复 | 套件及应用数据位于测试卷 A，唯一测试下载根目录位于独立测试卷 B。停止套件，关机，在测试环境中安全分离仅承载 B 的磁盘，再启动 DSM 和套件。确认修复页可访问、引擎停止、客户端端口关闭、原路径未被重建。关机接回原盘，再次验证卷和根目录身份、任务和哈希。若设备号已变化，按修复页提示明确授权其他路径。 | B 上所有服务和共享文件夹在离线期间均不可用。删除卷或存储池会擦除数据。生产卷、系统盘和 RAID 成员不得用作试验盘。[群晖存储池说明](https://kb.synology.com/en-id/DSM/help/DSM/StorageManager/storage_pool_create_storage_pool?version=7) |
| 卸载并重装 | 在测试实例先做可恢复的套件状态及下载文件备份。保留数据卸载，再装回相同架构和版本的 SPK。重新打开 Motrix 后检查原任务、设置、旧凭据和文件哈希。再在可丢弃的实例勾选删除应用数据卸载重装，验证任务列表为空、旧凭据被拒绝、共享目录内合成文件的哈希不变。 | 两种方式均停止服务。清除选项会删除整个实例的任务、设置和配对信息。 |

## 构建与验证

使用 Node 24.18.0、仓库锁定的 pnpm 和 Rust 版本、Python 3.12+
（或支持 tar extraction filter 的 Python 3.11），以及用于隔离验收的 Docker。
在对应架构的 Linux 构建机安装 Rust musl target（x64 或 aarch64）和 GNU binutils。ARM64 还需安装 qemu-user。示例构建 ARM64，x86_64 使用 `arch=x64`。

```sh
arch=arm64
MOTRIX_SKIP_ELECTRON_REBUILD=1 MOTRIX_SKIP_ENGINE_FETCH=1 pnpm install --frozen-lockfile
pnpm run fetch:engine -- --platform linux --arch "$arch"
pnpm run build:server
pnpm run stage:server -- --platform linux --arch "$arch" --libc gnu --strict
pnpm run build:synology -- --arch "$arch" --output-dir "release/synology-$arch/project"
pnpm run verify:synology -- --spk "release/synology-$arch/Motrix-2.3.0-13-dsm-$arch.spk"
```

GitHub Actions 的 `synology.yml` 在原生 x64 和 ARM64 runner 上分别构建，再从最终 SPK 解包测试。稳定版发布成功后，`synology-publish.yml` 用该 tag 的确切提交重建两种架构。受保护的发布作业校验 tag、构建提交、两份安装包、校验和和逐平台 ABI 报告，再附加到已有 GitHub Release。失败重试不覆盖已有文件。输出不等同于群晖商店上架。

本地可将两种架构各自的 `.spk`、`.spk.sha256` 和 `.spk.abi.json` 放入同一个目录，用只读命令复核。传入 SPK 收据中记录的版本和完整源码提交。

```sh
python3 scripts/synology_publication.py verify "$asset_dir" "$version" "$source_sha"
```

每次构建使用新的输出目录。增加数字 revision 可生成支持原位升级的 SPK，同时
保持应用版本不变。在 macOS 交叉构建时，还必须从锁定 Rust 源码构建 Linux
文件系统辅助程序，不能放入 macOS 二进制。构建复用 Server staging、依赖裁剪、
引擎完整性检查、内置插件签名校验和许可证生成流程。Node 归档使用现有 NAS
runtime lock 校验。NAS 上不安装 Electron、npm、编译器或工具链。

SPK 构建器会解包实际外层归档和 `package.tgz`，拒绝目录穿越、链接、重复成员
及 macOS 元数据，检查文件哈希和执行权限，并重新执行 Server 包验证。
每个 ELF 的架构、动态依赖和符号版本都与该包声明平台对应的官方 sysroot
比对；包内 Node 和 SQLite 还会经 DSM loader 加载并执行 SQLite 读写。
aria2 和文件系统辅助程序为静态程序。SDK 仅用于构建，不包含在分发 SPK 中。

普通 Server smoke 和 DSM 生命周期模拟均针对**最终 SPK 解包后的文件**运行。
模拟 DSM SCGI API 仅存在于一次性容器中，验证的是集成行为，不能证明真实 DSM
接口的可用性、输出格式或访问权限。包内构建记录包含源码 commit 和工作区是否有未提交改动。
请将 `.abi.json` 和测试日志与 SPK、SHA-256
一同保留，不要仅凭这些结果发布正式版本或宣称实机兼容。

## 实现依据与边界

以下资料覆盖 DSM 7.2.2 和 DSM 7.4.1；实机核对更新于 2026-11-07：

| 范围 | 依据与实现边界 |
| --- | --- |
| 套件结构与元信息 | [SPK 结构](https://help.synology.com/developer-guide/synology_package/introduction.html)、[INFO](https://help.synology.com/developer-guide/synology_package/INFO.html)、[多语言字段](https://help.synology.com/developer-guide/synology_package/INFO_optional_fields.html)。英文默认值，另提供 `chs`/`cht` 介绍和向导。 |
| 最小权限 | [权限配置](https://help.synology.com/developer-guide/privilege/privilege_config.html)、[官方 Web 套件分组示例](https://help.synology.com/developer-guide/examples/compile_web_package.html)。使用 `run-as: package` 和 `join-groupname: http`；root 套件需要群晖额外授权。 |
| 存储与生命周期 | [FHS](https://help.synology.com/developer-guide/integrate_dsm/fhs.html)、[data-share](https://help.synology.com/developer-guide/resource_acquisition/data_share.html)、[向导规范](https://help.synology.com/developer-guide/synology_package/wizard/WIZARD_UIFILES_v2.html)。FHS 状态跨升级保留，资源管理器不删除下载共享目录。 |
| 桌面与代理 | [桌面配置](https://help.synology.com/developer-guide/integrate_dsm/config.html)、[web-config](https://help.synology.com/developer-guide/resource_acquisition/web_config.html)、[Web Station 方案](https://help.synology.com/developer-guide/resource_acquisition/web_service.html)。采用 DSM Nginx worker、Unix upstream 和明确的 WebSocket 转发，不接受 fnOS 身份 Header。 |
| 登录身份 | [应用认证](https://help.synology.com/developer-guide/integrate_dsm/web_authentication.html)说明 Cookie 和 CGI 上下文。新版不再直接执行 `authenticate.cgi`，也不使用 r4 提权辅助程序。已用 DSM 7.4.1 的真实浏览器会话验证 `login.cgi` 和 `SYNO.Core.NormalUser.get`；本地 SCGI 传输仍依赖 DSM 版本，需要逐版本验收。 |
| 账号与 ACL 状态 | DSM 7.4.1 已验证 `SYNO.Core.User.get` 单独查询 `additional=["expired"]`；附带 `groups` 会报 3106。UID 和管理员组通过非特权 `id` 核对。[官方 File Station API](https://global.download.synology.com/download/Document/Software/DeveloperGuide/Package/FileStation/All/enu/Synology_File_Station_API_Guide.pdf)规定了 `List.getinfo` 和有效 ACL 字段，已在两个明确授权的共享目录完成浏览器查询。这些接口检查不等同于完整 SPK 实机验收。 |
| 架构 | [官方架构映射](https://help.synology.com/developer-guide/appendix/platarchs.html)、[机型 CPU 列表](https://kb.synology.com/en-global/DSM/tutorial/What_kind_of_CPU_does_my_NAS_have)。DS920+/DS220+ 属于 Gemini Lake；DS220j 是 RTD1296（ARMv8），不能安装 x86_64 包。 |
| 工具链 | [官方选择说明](https://help.synology.com/developer-guide/compile_applications/download_dsm_tool_chain.html)、[环境准备](https://help.synology.com/developer-guide/getting_started/prepare_environment.html)、[spksrc Gemini Lake 输入](https://github.com/SynoCommunity/spksrc/tree/master/toolchain/syno-geminilake-7.2)。准确归档 SHA-256 记录在 `scripts/synology-runtime.lock.json`。 |
| 成熟开源参考 | [SynoCommunity/spksrc](https://github.com/SynoCommunity/spksrc) 及其 [Transmission 生命周期](https://github.com/SynoCommunity/spksrc/blob/master/spk/transmission/src/service-setup.sh)，用于核对 FHS 保留和套件账号运行；没有照搬安装时下载依赖的做法。 |
