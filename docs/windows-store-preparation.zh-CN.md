# Windows 包准备

[English](windows-store-preparation.md)

Motrix 的 Windows 打包支持仍在开发中。准备工具校验输入并装配测试布局，独立的
Windows SDK 脚本生成未签名测试 AppX。这些工具不会签名、安装或提交商店，也不
代表已兼容 Microsoft Store。StartupTask、包关联和通知激活已实现供测试；
浏览器自动发现和安装生命周期仍需继续开发，Windows 包内运行验证尚未完成。

SDK 检查完成后，按 [Windows 测试包运行验收](windows-store-runtime-testing.zh-CN.md)
在可丢弃的 Windows 11 测试机执行本地测试签名、安装、升级和清理。这是手动测试
流程，不改变未签名的 CI 工作流。

## 发布元数据

将发布元数据放在源码 checkout 之外。以下是本地测试的结构示例；两个尖括号占位符
应分别替换为 `package.json` 和 `git rev-parse HEAD` 的精确值：

```json
{
  "schemaVersion": 1,
  "profile": "test",
  "architecture": "x64",
  "productVersion": "<package.json version>",
  "packageVersion": "1.0.0.0",
  "source": { "commit": "<full lowercase commit SHA>" },
  "identity": {
    "name": "Motrix.Store.Test",
    "publisher": "CN=Motrix Store Test",
    "publisherDisplayName": "Motrix Store Test"
  },
  "previousPackageVersions": []
}
```

这一固定身份仅供可丢弃的测试环境使用。`store` profile 需要从 Partner Center
取得真实身份字段、稳定产品版本，以及精确的 `source.tag`：`v<productVersion>`。
工具拒绝使用已知 Motrix 测试身份。可选的 `storeProductId` 只是一个标识符，填写它
不代表已经验证相应商店条目存在。

产品版本与 Windows 四段包版本相互独立。包版本每段范围为 0 到 65535；Store 提交
还要求首段非零、第四段为零。Motrix 要求候选版本高于提供的全部
`previousPackageVersions`，比较时包含 Store 分配的第四段修订号。这一递增策略
不能证明输入已经覆盖所有提交和 flight；分配发布版本前仍须在 Partner Center
核对完整历史。

## 校验源码 checkout

在已安装依赖的开发 checkout 中运行：

```sh
node scripts/verify-windows-store-source.mjs --repo-root . --metadata /path/to/release-metadata.json
```

命令输出 JSON，失败时返回非零退出码。它核对实际提交、产品版本、工作区是否干净，
以及提供的精确 tag。Store 模式还要求源码提交属于本地
`refs/remotes/origin/main` 的历史。所需 refs 应提前 fetch；校验器不会访问网络。
请使用完整、干净的 checkout，不要包含 Git replacement refs、grafts、隐藏的索引
改动、自定义 clean/process filters 或子模块。被忽略的构建输出可以保留。

校验器忽略 global/system Git 配置。创建新的 Windows 构建 checkout 时，使用
`git clone --config core.autocrlf=false <repository> <new-directory>`，避免检出
内容依赖机器的全局 CRLF 转换设置。Store CI 已在 checkout 之前设置该选项。

本地报告通过**不能证明**远端 refs 是最新状态、tag 已受保护，或已有应用 bundle
确实由该源码构建。这些检查仍由发布工作流及候选验证负责。

## 目录构建配置

`scripts/windows-store-builder-config.mjs` 中的
`createWindowsStoreBuilderConfig` 基于现有 Electron staging 生成目录构建配置。
它保留运行时资源、许可文件、staging hooks 和 fuses，选择 Windows x64 `dir`，
关闭全局及 Windows 更新源发布和可执行文件签名。输出目录必须是绝对路径。

生成对象必须写成**完整配置文件**，通过 `--config` 传入，不能作为命令行覆盖项
重新合并到 NSIS 配置。调用 electron-builder 时同时使用
`--win --x64 --publish never`。这一步只准备后续 Windows SDK 打包所需的目录
payload；普通 Electron `appId` 不能证明 AppX 包身份。

## 准备目录构建

使用干净的 Windows x64 开发 checkout，并安装仓库指定的 Node、pnpm 和 Rust 版本。
以下命令将元数据、本地源码校验与完整 builder 配置串联起来：

```powershell
$storeBuild = Join-Path $env:TEMP 'motrix-store-build-a'
node scripts/prepare-windows-store-build.mjs --repo-root . --metadata C:\path\release-metadata.json --out $storeBuild
```

输出必须是尚不存在的绝对路径，其父目录已存在，且位于 checkout 之外。命令不会
覆盖已有输出，依次写入 `electron-builder.json`、`release-metadata.json`、
`source-report.json`，最后写入 `build-plan.json`。最后一个文件记录输入摘要与
builder 参数数组；它是准备记录，不是构建证明。命令不会自动执行构建。

随后对同一个 checkout 执行现有 Windows 包构建与 staging 流程：

```powershell
pnpm run ensure:electron-runtime
pnpm run fetch:engine --platform win32 --arch x64
pnpm run build:builtin
pnpm run build:native-host -- --platform win32 --arch x64
pnpm run build:finalize-fs -- --platform win32 --arch x64
pnpm run build:windows-platform --platform win32 --arch x64
pnpm run build:electron
pnpm run stage:electron -- --platform win32 --arch x64
pnpm exec electron-builder --config "$storeBuild\electron-builder.json" --win --x64 --publish never
```

逐条检查退出码，失败时停止。目录 payload 应位于准备目录下的
`payload/win-unpacked`。期间不要修改源码、复用另一 checkout 的构建输出，或将旧
stage 当作全新构建的证据；发布工作流来源记录与最终 payload 验证仍是独立要求。

## 校验 payload 并装配测试布局

```powershell
node scripts/verify-windows-store-payload.mjs --app-dir "$storeBuild\payload\win-unpacked" --metadata "$storeBuild\release-metadata.json"
```

JSON 报告将现有 Electron 包校验与 Windows 路径、x64 PE machine、产品版本比对和
文件摘要检查组合起来。它拒绝链接、大小写碰撞、签名密钥/证书文件、更新器配置和
未声明的可执行文件/安装包，同时读取目录和实际 ASAR 内容。包版本目前只记录元数据
提供的值，尚未写入 AppX；machine 检查通过不表示程序已经运行或验证过签名。

仅对 `test` 元数据，装配通过校验的 payload 与现有资产：

```powershell
$storeLayout = Join-Path $env:TEMP 'motrix-store-layout-a'
node scripts/prepare-windows-store-layout.mjs --repo-root . --app-dir "$storeBuild\payload\win-unpacked" --metadata "$storeBuild\release-metadata.json" --out $storeLayout
```

输出必须全新，且位于源码和 payload 目录之外。命令重新验证复制后的 payload，逐项
比较物理文件摘要，再写入完成记录 `layout-report.json`。它还输出源码和 payload
报告、元数据、`TEST-ONLY.txt`，以及以下 SDK 输入：

```text
layout/
  AppxManifest.xml
  Assets/*.scale-200.png
  app/                       # 未改变、已验证的目录 payload
pri-root/Assets/             # 相同资产文件，供 PRI 索引
priconfig.xml
```

普通测试 manifest 包含一个具有包身份的桌面应用和 `runFullTrust`，并为 `app\Motrix.exe`
声明需主动启用的 `MotrixStartup` 任务，设置 `Enabled="false"` 与
`--opened-at-login=1`。同时声明 `motrix`、`mo`、`magnet` 协议和 `.torrent` 文件。
生产 native-host alias 声明等待浏览器联动适配包身份；下文显式诊断模式使用
独立测试探针。当前配置的 Windows
阈值为 10.0.19045.0，并非 Windows 兼容性实测结论。现有四张图片按 scale-200
资源命名，manifest 引用逻辑路径；PRI 配置从仅含 `Assets/` 的独立
`pri-root` 根目录开始索引，保留逻辑资源名中的 `Assets/` 层级。该命令**不会生成**
`resources.pri` 或 AppX，仍需 Windows SDK 资源解析和打包/解包验证。

目前拒绝装配 Store profile：生产资产变体和包集成尚未完成。测试布局只应用于隔离
Windows 用户或 VM。Windows 包暂不支持浏览器自动发现；包版不会注册或移除
官网版的浏览器连接组件。

## Windows 启动集成

Store 目录构建包含 `bin/motrix-windows-platform.exe`。helper 先核实进程的真实
Windows 包身份，再调用 WinRT `StartupTask`；启动操作使用有长度限制和版本字段的
JSON 请求，针对固定 `MotrixStartup` 任务。Electron 从包内资源绝对路径调用 helper，
串行处理请求，并限制执行时间和输出大小。失败时不回退到传统登录项注册。

包启动时只读取 Windows 状态，不应用已保存的偏好。常规设置显示 Windows 的五种
状态，仅在用户主动修改并保存后申请变更；用户在系统中禁用或策略控制的任务引导
至 Windows 启动设置。返回 Motrix 时刷新状态。单独修改“登录时显示主窗口”不会
申请启用启动任务。失败时保留已提交的设置快照，并显示启动设置错误供重试。
非包版 Windows 和 macOS 保留原有 Electron 登录项行为。

清单使用官方文档中的 [desktop 扩展参数](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-desktop-extension)
和 [StartupTask 启用属性](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-desktop-startuptask)。
编译和单元测试不证明包身份继承、WinRT 激活或登录启动已经可用。Windows 11 必须验证：

- 全新安装及首次启动：默认禁用，打开设置不会自动启用。
- 主动启用和禁用：Windows 与 Motrix 状态一致，重启应用后仍一致。
- 在 Windows 设置中禁用：返回 Motrix 尊重该选择，并丢弃冲突的未保存草稿。
- 存在策略控制时：应用不能覆盖系统选择。
- 启用后注销再登录：启动器收到 `--opened-at-login=1`，窗口行为遵循已保存偏好。
- 两个递增包版本之间升级及卸载：启动注册随包生命周期正确更新和移除。

记录文字日志和观察到的状态。SDK 工作流只上传 JSON/XML/log 证据，不安装包或执行
上述运行时验证。

## Windows 链接与默认应用

测试清单按[桌面协议和文件关联文档](https://learn.microsoft.com/windows/apps/desktop/modernize/desktop-to-uwp-extensions)
传递带引号的 `%1` 参数。`Document` 多选模式为每个选中的 torrent 文件分别激活
应用；启动器把后续激活交给已运行实例。`mo://` 和 `motrix://` 复用路由校验，
链接只预填新建任务表单或打开已有任务、插件详情，不提交下载或安装插件。
资源 URL 不再进入本地 torrent 文件扫描，避免重复派发。

在 Windows 包模式下，helper 从当前包的应用列表验证主应用 `Motrix` 的 AUMID，
通过 [AssocQueryStringW](https://learn.microsoft.com/windows/win32/api/shlwapi/nf-shlwapi-assocquerystringw)
查询 `.torrent`、`magnet` 默认处理程序并比较 AUMID。读取失败、传统处理程序
没有 AUMID 等情况保持未知。主应用出现在列表中不证明每项关联扩展都已注册。
该分支不读取传统安装器注册信息或 UserChoice，不写入默认选择。
界面校验响应，查询失败时清除过期状态。

适用的 Windows 11 版本使用已验证主 AUMID 打开[应用专属默认应用页](https://learn.microsoft.com/windows/apps/develop/launch/launch-default-apps-settings)；
较早系统或身份无法确认时打开通用默认应用页。当前清单仍使用配置值 19045 作为
`MaxVersionTested`。系统升级后可能需要提高此值才能重新索引该应用的定向链接，
应结合真实 Windows 验证确定。

Windows 11 还须验证：

- 三种协议和 torrent 文件的冷启动、运行中激活，包括空格、中文路径及多文件选择。
- 畸形链接不会创建任务、安装插件或重复派发文件。
- 在 Windows 设置中切换默认应用，返回 Motrix 后状态刷新；无法读取时仍显示未知。
- 官网版与包版共存，不擅自改变用户的默认选择；升级和卸载只处理各自声明。
- 全新安装及系统升级后，应用专属设置页均可使用；记录系统版本、包身份和实际打开位置。

SDK 打包通过本身不代表上述激活或默认关联检查通过。

## Windows 包通知

包版从 `src/shared/config/windows-package.json` 读取固定 toast 激活 CLSID，
Electron 与清单中的 COM/toast 声明共用该值。通知初始化前先设置 CLSID；应用
ready 后初始化通知 presenter，使尚未展示新通知的进程也能接收 COM 激活。
官网等其他发行方式保留现有初始化行为。

历史通知点击的参数可能为空。包版在启动完成前只保留有界的显示主窗口请求，
不把激活参数解释为 URL、文件路径或任务命令。仍在内存中的业务通知保留已有
任务导航、文件定位行为；同一事件循环中的实例点击优先于全局兜底，这不代表
能够消除之后重复到达的所有事件。包版插件通知点击也会打开主窗口。
退出时丢弃尚未执行的激活请求。

实现依据当前锁定的 Electron 通知实现及微软的 [toast 激活](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-desktop-toastnotificationactivation)
和 [COM 可执行服务器](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-com-exeserver)
契约，不使用 Windows App SDK 专用激活参数。Windows 11 仍须验证通知投递、
运行中点击、重启或进程退出后的通知中心点击、启动期间点击、重复事件及官网版
共存；还应测试插件通知替换、关闭并观察包身份。`Notification.isSupported()`
返回成功和 SDK 打包通过均不能证明这些运行时行为。

## 浏览器注册隔离

Windows 包的 Native Messaging 注册策略为 `unsupported`。安装器在解析 host
路径或接触 manifest、开发 sidecar、浏览器注册表键之前返回；注册、独立清理、
启动回滚及受信任扩展变更均遵守该约束。host 路径解析器也拒绝 Windows 包误用。
官网等直接发行版保留现有注册方式，Flatpak 保留外部管理策略。

设置通过独立于桥服务的查询获取策略，因此关闭浏览器联动时仍会显示包版限制。
包版隐藏扩展安装卡片和 Native Messaging 恢复建议，保留开关、已配对客户端
列表和撤销控制。MDXP 桥运行正常不代表 Native Messaging 可用；其认证行为
保持不变。

这项隔离不等于已支持 Store 浏览器联动。稳定的包 host、正确的 profile 发现、
浏览器 stdio 行为、冷启动、升级后首次启动前连接、卸载和共存仍需 Windows 11
证据及浏览器扩展配合。不能将传统 host 直接暴露为 Store alias：它现有的数据
和启动路径属于官网版。

## Native Messaging 诊断进程检查

SDK 工作流还会使用 Windows .NET Framework 编译器，编译独立的 x64 诊断控制台
程序，并测试其二进制标准输入输出。探针只接受固定的公开挑战值，不读取 Motrix
profile、endpoint、凭据或注册表，不启动 Motrix。该程序不进入普通测试 AppX，
也不作为二进制 artifact 上传。

在 Windows 的 PowerShell 7 中使用新目录，可执行同样的进程检查：

```powershell
$probeOutput = Join-Path $env:TEMP 'motrix-store-native-messaging-probe'
./scripts/build-windows-store-native-messaging-probe.ps1 -OutputDirectory $probeOutput
./tests/scripts/windows-store-native-messaging-probe.test.ps1 -ProbePath (Join-Path $probeOutput 'motrix-store-p0-probe.exe') -ReportPath (Join-Path $probeOutput 'direct-stdio-report.json')
```

任一命令失败都应停止。`build-report.json` 记录源码／程序摘要和 x64 控制台检查；
`direct-stdio-report.json` 仅在响应帧、子进程退出码、无效输入拒绝及超时检查
全部通过后记录 `ok: true` 和 `directStdioVerified: true`。失败时可以写入
`ok: false` 报告，但命令仍然失败，不能以报告存在判断成功。直接运行成功时必须
报告不存在包身份。浏览器格式的参数只是
模拟输入，不是真实浏览器启动。

这些报告仅证明编译与直接进程行为，`packagedActivationVerified`、
`browserNativeMessagingVerified` 和 `mbp1Verified` 均保持 false。探针通过下文
诊断模式安装时，预期固定的 `Motrix.Store.Test` 包身份。普通测试 manifest
没有诊断 Application 或 alias。包激活、外部注册可见性、三浏览器行为、升级后未首次启动的连接及 MBP1
配对仍需独立实施和验证。

### 装配诊断测试包

可选 metadata 字段 `testDiagnostics: "native-messaging-probe-v1"` 仅在固定测试
身份下接受，Store metadata 拒绝该字段。从同一个干净 checkout 编译探针后，
创建独立的 metadata 文件和布局：

```powershell
$diagnosticMetadata = Get-Content -LiteralPath "$storeBuild\release-metadata.json" -Raw | ConvertFrom-Json -AsHashtable
$diagnosticMetadata.testDiagnostics = 'native-messaging-probe-v1'
$diagnosticMetadataFile = Join-Path $env:TEMP 'motrix-store-diagnostic-input.json'
$diagnosticMetadata | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $diagnosticMetadataFile -Encoding utf8NoBOM -NoClobber
$diagnosticLayout = Join-Path $env:TEMP 'motrix-store-diagnostic-layout'
node scripts/prepare-windows-store-layout.mjs --repo-root . --app-dir "$storeBuild\payload\win-unpacked" --metadata $diagnosticMetadataFile --out $diagnosticLayout --probe-build-dir $probeOutput
```

两个输出路径都必须尚未使用。将 `$diagnosticLayout` 作为下文 SDK 命令的准备
目录。布局流程检查探针实际 x64 控制台头和摘要，将编译报告中的源码摘要与
checkout 关联，复制后再次核对字节。`diagnostic-build-report.json` 保留在包外，
它是构建关联记录，不是经过签名的证明。

诊断 manifest 增加隐藏的 `MotrixNativeHostP0` 应用与
`motrix-store-p0-native-host.exe` 执行 alias，两者指向
`diagnostics/motrix-store-p0-probe.exe`。Electron payload 保持原样，仍拒绝未声明的
EXE；helper 复用现有图标。prepared、indexed、unpacked 检查均要求精确的附加文件
和 manifest，SDK 会依据相同的四个 PRI 资源检查两个应用的引用。

诊断包与普通测试包使用相同身份，不能并排安装。A→B 实验应准备两个递增包版本，
保持身份、helper 和 alias 相同。按[测试签名与安装指南](windows-store-runtime-testing.zh-CN.md)
操作后，再独立验证 alias 激活和浏览器发现。上述直接进程测试预期没有包身份，
不能用于验证已安装的 alias。该模式没有实现浏览器 host 注册或 MBP1 连接。

## CLI 集成边界

当前 Windows 包尚不支持 CLI 默认自动发现。包版使用独立于官网版的数据目录，
因此检测到全局 `motrix` 命令不代表它能够选中或连接这个包。

包版在 shell 或可执行文件探测前返回 CLI 集成不支持，并拒绝从应用内通过任何
包管理器发起 CLI 安装。设置显示限制，不提供安装命令，也不宣称可以自动连接。
此状态中的 CLI 版本或路径为 null 表示未检查，不表示系统没有安装 CLI。官网等
直接发行版和服务端保留现有行为。

这是当前集成的能力边界，不代表微软禁止 CLI 工具。已有 MDXP 认证、配对审批
和撤销仍可使用。CLI 选择包版目标、官网版共存、激活及从包外访问 profile 需要
兼容的 CLI 版本和 Windows 验证，之后才能宣称支持自动发现。

## 执行 Windows SDK 包检查

在 Windows 的 PowerShell 7 中选择同时包含 `makepri.exe` 和 `makeappx.exe` 的已安装 x64 SDK
目录，然后运行：

```powershell
./scripts/pack-windows-store-test.ps1 -PreparedDirectory $storeLayout -SdkBinDirectory 'C:\Program Files (x86)\Windows Kits\10\bin\<installed-sdk-version>\x64'
```

SDK 脚本要求布局中尚无 `resources.pri`，并创建全新的同级目录
`<布局目录名>.sdk-output`。它检查输入，生成和导出 PRI，核对逻辑图片路径与
scale-200 候选，打包未签名 AppX，再解包比对实际 manifest、资产、payload 与 PRI
摘要。只有全部成功才写入 `sdk-result.json`。失败时保留部分输出供诊断；重试应
使用新的准备目录。

打包命令使用 `/l` 处理限定资源；这个参数会跳过特定本地化检查，不能证明全部
manifest 语义。脚本不使用 `/nv`。MakeAppx 的验证范围有限，打包/解包通过不代表
安装、运行时、WACK 或 Store 认证通过。

只读布局校验器可独立检查以下阶段，并输出 JSON 报告：

```powershell
node scripts/verify-windows-store-layout.mjs --prepared $storeLayout --phase prepared
# 生成索引后执行；第一条命令会拒绝已有 PRI：
node scripts/verify-windows-store-layout.mjs --prepared $storeLayout --phase indexed
node scripts/verify-windows-store-layout.mjs --prepared $storeLayout --phase unpacked --layout "$storeLayout.sdk-output\unpacked"
```

`Windows Store package check` 工作流从当前 checkout 在 Windows runner 上执行上述检查，
使用固定测试身份和包版本，自行构建 payload，不使用发布者签名或商店提交凭据。
artifact 仅含 JSON/XML 报告和进程日志，不含图片、包或证书。

手动 dispatch 还会在可丢弃的 hosted runner 上测试诊断包副本。Windows PowerShell 5.1
包装脚本只接受该 CI 环境，创建不可导出的临时测试私钥，为新副本签名并核验，以当前
runner 账户安装，然后调用[已安装 alias 检查器](windows-store-runtime-testing.zh-CN.md#检查已安装的诊断-alias)。
结束后仅删除本次包、证书和信任项、临时签名副本，并复查清理结果；SDK 未签名原包
保持原样。PR 运行跳过安装步骤。不使用发布者证书、PFX、私钥导出或商店投递。

运行报告记录实际 runner 镜像、操作系统、账户上下文和各项结果。GitHub Windows
hosted runner 使用管理员账户；Server 基线不能证明 Windows 11 普通用户行为、真实
浏览器 Native Messaging、MBP1、升级或商店认证。SDK 报告只代表 SDK 检查，已安装
alias 的结论必须有单独成功的运行报告。参见 [MSIX 支持平台](https://learn.microsoft.com/windows/msix/supported-platforms)
和 [hosted runner 权限](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)。

未签名的目录包、合法元数据或通过本地校验，都不等于可分发的 Store 包。仍须执行
真正的 Windows 打包、包身份核验、WACK，以及安装和升级测试。

## 参考资料

- [包身份和版本范围](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/package-identity-overview)
- [Store 包与版本要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [Partner Center 身份详情](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)
- [桌面包 manifest](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)
- [应用图标资产要求](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)
- [PRI 配置](https://learn.microsoft.com/en-us/windows/uwp/app-resources/makepri-exe-configuration)
- [MakeAppx 命令及验证边界](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
