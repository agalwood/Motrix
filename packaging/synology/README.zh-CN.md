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

当前构建经过 Linux 模拟和 DSM 用户态 ABI 验证，**尚未通过真实设备验收**。
最低版本表示本次核对的工具链与资源接口，不表示所有新版本 DSM 或所有 x86_64
机型均已通过。Gemini Lake 工具链对应 Linux 4.4.302、glibc 2.36；
[Node 24 官方支持的 Linux 内核基线](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)
高于 DSM 的 4.4 内核。成功通过 sysroot 加载不能证明内核或系统调用兼容。
目标 NAS 上的安装和持续下载测试仍是发布条件。

## 使用与权限

使用本地管理员账号登录 DSM 后，从桌面打开 Motrix。入口沿用 DSM 的主机名和
端口，路径为 `/motrix/`，包括 HTTP、WebSocket 和静态资源。无需安装 Web Station。
应用没有单独的登录密码，也不收集 DSM 密码。上游 socket 权限为 `0600`，
需验证目标 DSM 网关是否能访问。如果不能，应补充有明确依据的网关专用授权，
不能把 socket 改成所有用户可写，也不能提升整个应用的权限。

Web 服务、下载引擎、插件和文件系统辅助程序均以 `motrix` 套件账号运行。
套件没有 root 进程，不申请 setuid、Linux capability、sudo 规则或特权辅助服务。
DSM 资源管理器负责创建 `motrix` 共享文件夹和注册 Nginx 配置。
下载范围同时受已配置目录、管理员账号权限和套件账号权限约束。授权目录必须
存在、位于已挂载存储卷中，且不能通过符号链接改指其他位置。默认目录从
`/var/packages/Motrix/shares/motrix` 解析；存储离线时不会在系统卷重建替代目录。

可在套件目录下的 `var/directories.json` 明确配置额外目录，例如：
`{"roots":["/volume1/motrix","/volume2/Downloads"]}`。
请先在 DSM 共享文件夹权限中给内部系统用户 `motrix` 授权。Motrix 复用现有 Server
目录选择器，只浏览已授权范围；选择目录本身不会增加权限。后端会在新增任务、
恢复、重新下载、BT 文件选择、写入已有输出和删除时重新检查。
支持从浏览器上传本地 `.torrent` 文件。本版没有注册 DSM `.torrent` 文件关联，
也没有接入 File Station 打开/定位操作：这些集成尚无经过验证的稳定公开接口，
因此保持不可用，不调用 fnOS 接口，也不接受任意文件路径作为替代入口。

目录授权和账号/ACL 状态会在操作入口刷新。删除复用现有基于目录句柄的文件
系统辅助程序、文件身份检查和持久化恢复日志。撤回授权不会立即取消下载引擎
已经打开的文件；撤回后台下载目录授权前请先停止套件。实机仍需验证 DSM ACL
继承、挂载点替换、存储离线和文件提交中断。

## 客户端配对

安装向导可设置 CLI/浏览器扩展端口，默认 **16802**。扩展 WS/WSS 地址留空时，
浏览器扩展入口关闭。启用时需配置可访问的客户端 WS/WSS 地址及完整 Motrix Web
地址，包含 `/motrix/`。通过 HTTP 显示配对码必须明确勾选可信网络许可。
配置的 Origin 必须与当前页面一致；填写 HTTPS 地址不代表可以在 HTTP 页面显示码。
这些选项保存在 `var/package-settings.json`。修改前先停止套件，保存后重新启动。
无效扩展配置会关闭相关入口，不会退回无认证访问。

沿用现有 CLI device-code 和扩展 MBP1 协议。配对界面显示当前账号，按钮为
**使用当前账号配对**；下一步需要在浏览器扩展中输入配对码。服务端核对页面
预期账号与当前可信身份。共享通知不包含配对码，只有认领者能取得配对码。

客户端凭据绑定本地账号 ID 和账号数据库版本。每次客户端请求均重新查询可信
账号状态；停用、过期、降权、记录缺失或查询失败都会拒绝访问。root 所有的
passwd/group 数据库发生任何变化时，会保守地让全部既有绑定失效，包括 UID
被复用的情况，此时需要重新配对。明确撤销凭据仍走既有协议。DSM 会话 Cookie
不会写入配对状态，也不能作为 CLI 凭据使用。Web 事件票据只能使用一次，绑定
当前 Origin 并短期有效；连接至少每分钟重新认证。

## 生命周期与数据保留

套件生命周期脚本以套件账号执行，通过 `flock` 串行化。进程记录包含 PID、
进程出生时间、启动标识，以及可执行文件和入口检查。停止会等待正常退出，
超时则保留进程记录。升级先停止旧进程，再替换文件，并保留 DSM FHS `var`
目录中的任务数据库、配置、插件、配对绑定和删除恢复状态。下载文件留在共享目录。

卸载默认保留应用数据。明确选择**删除任务、配置和配对信息**后，才会在成功
停止服务后删除套件自己的状态。下载文件始终保留。保留数据后重新安装可恢复
同一个共享实例，但仍需满足当前账号和目录权限。实际生命周期顺序及资源清理
由 DSM 管理；真实安装、修复、升级和卸载验收仍未完成。

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
模拟 DSM 认证程序仅存在于一次性容器中，验证的是集成行为，不能证明真实 DSM
程序的可用性、输出格式或执行权限。包内构建记录包含源码 commit 和工作区是否有未提交改动。
请将 `.abi.json` 和测试日志与 SPK、SHA-256
一同保留，不要仅凭这些结果发布正式版本或宣称实机兼容。

## 实现依据与边界

以下资料于 2026-11-05 按 DSM 7.2.2 核对：

| 范围 | 依据与实现边界 |
| --- | --- |
| 套件结构与元信息 | [SPK 结构](https://help.synology.com/developer-guide/synology_package/introduction.html)、[INFO](https://help.synology.com/developer-guide/synology_package/INFO.html)、[多语言字段](https://help.synology.com/developer-guide/synology_package/INFO_optional_fields.html)。英文默认值，另提供 `chs`/`cht` 介绍和向导。 |
| 最小权限 | [权限配置](https://help.synology.com/developer-guide/privilege/privilege_config.html)、[DSM 7 变化](https://help.synology.com/developer-guide/breaking_changes.html)。使用 `run-as: package`；root 套件需要群晖额外授权。 |
| 存储与生命周期 | [FHS](https://help.synology.com/developer-guide/integrate_dsm/fhs.html)、[data-share](https://help.synology.com/developer-guide/resource_acquisition/data_share.html)、[向导规范](https://help.synology.com/developer-guide/synology_package/wizard/WIZARD_UIFILES_v2.html)。FHS 状态跨升级保留，资源管理器不删除下载共享目录。 |
| 桌面与代理 | [桌面配置](https://help.synology.com/developer-guide/integrate_dsm/config.html)、[web-config](https://help.synology.com/developer-guide/resource_acquisition/web_config.html)、[Web Station 方案](https://help.synology.com/developer-guide/resource_acquisition/web_service.html)。采用 DSM Nginx worker、Unix upstream 和明确的 WebSocket 转发，不接受 fnOS 身份 Header。 |
| 登录身份 | [应用认证](https://help.synology.com/developer-guide/integrate_dsm/web_authentication.html)说明 `authenticate.cgi` 及 CGI 环境。调用不经过 shell，限制时间和输出，传入 Cookie 和网关地址上下文；套件账号能否执行仍需按 DSM 版本验证。 |
| 账号与 ACL 状态 | `synouser --get`、`synoacltool -get-perm` 是依赖 DSM 版本的命令适配，**不是有稳定公开承诺的 JSON API**。只接受完整的本地有效管理员记录和明确有效权限位；不能用缓存的网关身份替代实时状态。如果命令需要提权或格式改变，入口会拒绝访问，必须完成实机验证的账号服务设计后，才能声明支持相应 DSM 版本。 |
| 架构 | [官方架构映射](https://help.synology.com/developer-guide/appendix/platarchs.html)、[机型 CPU 列表](https://kb.synology.com/en-global/DSM/tutorial/What_kind_of_CPU_does_my_NAS_have)。DS920+/DS220+ 属于 Gemini Lake；DS220j 是 RTD1296（ARMv8），不能安装 x86_64 包。 |
| 工具链 | [官方选择说明](https://help.synology.com/developer-guide/compile_applications/download_dsm_tool_chain.html)、[环境准备](https://help.synology.com/developer-guide/getting_started/prepare_environment.html)、[spksrc Gemini Lake 输入](https://github.com/SynoCommunity/spksrc/tree/master/toolchain/syno-geminilake-7.2)。准确归档 SHA-256 记录在 `scripts/synology-runtime.lock.json`。 |
| 成熟开源参考 | [SynoCommunity/spksrc](https://github.com/SynoCommunity/spksrc) 及其 [Transmission 生命周期](https://github.com/SynoCommunity/spksrc/blob/master/spk/transmission/src/service-setup.sh)，用于核对 FHS 保留和套件账号运行；没有照搬安装时下载依赖的做法。 |

ARM64 有可行基础：[RTD1296 7.2 工具链](https://github.com/SynoCommunity/spksrc/blob/master/toolchain/syno-rtd1296-7.2/Makefile)
采用 GCC 12.2、glibc 2.36 和 AArch64 target，但仍需单独锁定 sysroot，验证
ELF/SQLite/Node、指令集和真实 ARM 硬件。ARMv7 还需要当前 Server staging 矩阵
没有提供的运行时和原生模块支持。因此构建器只输出 x86_64，不交付 ARM 包，
也不宣称完成 ARM 验收。
