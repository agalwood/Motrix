# 群晖 DSM 原生 Motrix

Motrix 可直接在 NAS 上下载文件和种子。这个实验性原生 SPK 内置 Node.js、
Motrix Server/Web UI、aria2 和文件系统辅助程序。运行时不依赖 Docker，安装时
不下载依赖、不运行 npm。作者：[Dr_rOot](https://github.com/agalwood)。

请通过**套件中心 → 手动安装**安装对应 SPK，并先核对旁边的 `.sha256` 文件。
本套件**尚未上架群晖套件商店**，不能将它描述为可从官方商店安装。

## 支持范围

首个目标是 **DSM 7.2.2-72806 及以上、x86_64**。第一版采用**管理员共享实例**：
所有获授权的本地 DSM 管理员共同管理同一组任务、设置和插件。普通账号、已停用
账号、域账号和 LDAP 账号不能访问。目前没有按用户隔离任务或分别计算配额。

修订版 **2.3.0-8** 已于 2026-11-07 在 **DS718+（Apollo Lake）、DSM 7.4.1**
完成以下原生流程测试，包括管理员登录、套件设置、客户端端口配置、NAS 种子选择、
File Station 定位、HEAD/Range 文件读取、定向文件删除及历史任务保留。
4 MiB HTTP 下载在 2.3.0-6 → 2.3.0-7 原位升级后继续完成，SHA-256 与源文件一致，
随后升级到 2.3.0-8。最终修订还会修复旧 HTTP 历史任务缺失的单文件元数据。

此前 2.3.0-5 已通过实机 HTTP/BT 下载、重新下载、目录与符号链接拒绝、非 root
进程检查，以及 CLI 协议配对和撤销。验收后已清理合成任务、测试文件及临时服务，
直连端口恢复为 16802，扩展入口保持关闭。这不表示所有 DSM 版本或机型均已兼容。

Linux 模拟和固定校验和的 Gemini Lake/Apollo Lake DSM 7.2.2 用户态 ABI 检查也已
通过。最低版本表示工具链与资源接口范围。实机内核为 Linux 4.4.302，
[Node 24 官方支持的 Linux 内核基线](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)
更高；基础操作已通过，但长时间下载、真实账号停用/重建、ACL 撤销、存储离线/替换、
文件提交中断等仍需受控实机测试。官方 Motrix CLI 0.5.0 已通过 DSM HTTPS 网关
完成配对并执行 `list` 和 `stats`。重启套件后，同一凭据先收到 HTTP 403，管理员
重新打开 Motrix 后恢复为 HTTP 200。撤销凭据后收到 HTTP 401。测试容器将证书域名
解析到 NAS 内网 IP，并验证了 TLS 证书链和名称。已安装的 Chrome 扩展在配对前因
证书未覆盖 WSS 地址中的 IP 而停止。扩展设置页可发现服务、获取 nonce，并以
`motrix-bridge.v1` 子协议建立 WebSocket 连接。尚无 ARM 构建及实机验收。

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
套件启动前，所有已配置的存储目录必须可用。

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
沿用现有 CLI device-code 和扩展 MBP1 协议。配对界面显示当前账号，按钮为
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
当前 Origin 并短期有效；连接至少每分钟重新认证。

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
同一个共享实例，但仍需满足当前账号和目录权限。实际生命周期顺序及资源清理
由 DSM 管理；全新安装、修复及卸载后的数据保留仍需实机验收。

## 构建与验证

使用 Node 24.18.0、仓库锁定的 pnpm 和 Rust 版本、Python 3.12+
（或支持 tar extraction filter 的 Python 3.11），以及用于隔离验收的 Docker。
在具备 `x86_64-unknown-linux-musl` Rust target 的 Linux x86_64 构建机上运行：

```sh
MOTRIX_SKIP_ELECTRON_REBUILD=1 MOTRIX_SKIP_ENGINE_FETCH=1 pnpm install --frozen-lockfile
pnpm run fetch:engine -- --platform linux --arch x64
pnpm run build:server
pnpm run stage:server -- --platform linux --arch x64 --libc gnu --strict
pnpm run build:synology -- --output-dir release/synology/project --revision 1
pnpm run verify:synology -- --spk release/synology/Motrix-2.3.0-1-dsm-x64.spk
```

每次构建使用新的输出目录。增加数字 revision 可生成支持原位升级的 SPK，同时
保持应用版本不变。在 macOS 交叉构建时，还必须从锁定 Rust 源码构建 Linux
文件系统辅助程序，不能放入 macOS 二进制。构建复用 Server staging、依赖裁剪、
引擎完整性检查、内置插件签名校验和许可证生成流程。Node 归档使用现有 NAS
runtime lock 校验。NAS 上不安装 Electron、npm、编译器或工具链。

SPK 构建器会解包实际外层归档和 `package.tgz`，拒绝目录穿越、链接、重复成员
及 macOS 元数据，检查文件哈希和执行权限，并重新执行 Server 包验证。
每个 ELF 的架构、动态依赖和符号版本都与固定校验和的官方 Gemini Lake sysroot
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

ARM64 有可行基础：[RTD1296 7.2 工具链](https://github.com/SynoCommunity/spksrc/blob/master/toolchain/syno-rtd1296-7.2/Makefile)
采用 GCC 12.2、glibc 2.36 和 AArch64 target，但仍需单独锁定 sysroot，验证
ELF/SQLite/Node、指令集和真实 ARM 硬件。ARMv7 还需要当前 Server staging 矩阵
没有提供的运行时和原生模块支持。因此构建器只输出 x86_64，不交付 ARM 包，
也不宣称完成 ARM 验收。
