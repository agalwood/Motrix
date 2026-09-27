# Windows 包准备

[English](windows-store-preparation.md)

Motrix 的 Windows 打包支持仍在开发中。准备工具校验输入并装配测试布局，独立的
Windows SDK 脚本生成未签名测试 AppX。这些工具不会签名、安装或提交商店，也不
代表已兼容 Microsoft Store。StartupTask 已实现供测试；包关联、浏览器集成和
安装生命周期仍需继续开发，Windows 包内运行验证尚未完成。

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

manifest 包含一个具有包身份的桌面应用和 `runFullTrust`，并为 `app\Motrix.exe`
声明需主动启用的 `MotrixStartup` 任务，设置 `Enabled="false"` 与
`--opened-at-login=1`。协议、文件关联与 native-host alias 声明等待对应运行时
实现。当前配置的 Windows
阈值为 10.0.19045.0，并非 Windows 兼容性实测结论。现有四张图片按 scale-200
资源命名，manifest 引用逻辑路径；PRI 配置从仅含 `Assets/` 的独立
`pri-root` 根目录开始索引，保留逻辑资源名中的 `Assets/` 层级。该命令**不会生成**
`resources.pri` 或 AppX，仍需 Windows SDK 资源解析和打包/解包验证。

目前拒绝装配 Store profile：生产资产变体和包集成尚未完成。测试布局只应用于隔离
Windows 用户或 VM；即使不声明 native-host alias，现有浏览器注册仍使用官网版
路径，需要适配包身份。

## Windows 启动集成

Store 目录构建包含 `bin/motrix-windows-platform.exe`。helper 先核实进程的真实
Windows 包身份，再调用 WinRT `StartupTask`；只接收有长度限制和版本字段的 JSON
请求，操作固定 `MotrixStartup` 任务。Electron 从包内资源绝对路径调用 helper，
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

`Windows Store package check` 工作流使用 Windows runner，对 checkout 的提交
执行上述测试，身份与包版本固定为测试值。它自行构建 payload，不使用签名或提交
凭据；artifact 仅含 JSON/XML 报告和进程日志，不上传图片或 AppX。绿色结果仅证明该提交
通过这些 SDK 检查。

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
