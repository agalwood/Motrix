# Windows 测试包运行验收

[English](windows-store-runtime-testing.md)

在 Windows 上完成[包准备](windows-store-preparation.zh-CN.md)后使用本指南。
这里给出固定身份 `Motrix.Store.Test` / `CN=Motrix Store Test` 的**本地测试签名与手动安装**
步骤，适用于可丢弃的 Windows 11 x64 VM 或专用测试机。示例是待执行、待记录的操作，
不代表任何运行检查已经通过。生产 Store 身份、微软签名、WACK 和商店提交仍是独立关卡。

SDK 工作流只上传文字证据。须从目标干净提交在 Windows 本地构建实际包；下载 CI
报告不会得到安装包。准备脚本使用 PowerShell 7；下面的 PKI 和 Appx 操作统一使用
**64 位 Windows PowerShell 5.1**（`powershell.exe`），避免 PowerShell 7 模块兼容性
差异，参见[模块兼容表](https://learn.microsoft.com/powershell/windows/module-compatibility)。
逐一替换路径和占位符，不要把所有代码块拼成无人值守脚本。

## 1. 核对包并保留未签名原件

第 1、2 节使用同一签名用户的**同一个提升权限的 64 位 Windows PowerShell 5.1 会话**。
指定已通过 SDK 检查的准备目录、含 SignTool 的已安装 x64 SDK、
checkout 之外的全新输出目录，以及目标源提交。输出目录的父目录须已存在。
以下检查把包文件摘要与本地准备记录对应起来，不证明发布来源可信；保留原 SDK
记录，不修改其内容。

```powershell
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$prepared = 'C:\path\motrix-store-layout-a'
$sdkBin = 'C:\Program Files (x86)\Windows Kits\10\bin\<installed-sdk-version>\x64'
$lab = 'C:\path\motrix-store-runtime-a'
$expectedCommit = '<full lowercase source commit SHA>'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or -not [Environment]::Is64BitProcess) {
  throw 'Use 64-bit Windows PowerShell 5.1 for these steps'
}
if ($expectedCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'Set the expected source commit' }
$metadata = Get-Content -LiteralPath "$prepared\release-metadata.json" -Raw | ConvertFrom-Json
$source = Get-Content -LiteralPath "$prepared\source-report.json" -Raw | ConvertFrom-Json
$sdk = Get-Content -LiteralPath "$prepared.sdk-output\sdk-result.json" -Raw | ConvertFrom-Json
if ($metadata.profile -cne 'test' -or $sdk.profile -cne 'test' -or
    $metadata.identity.name -cne 'Motrix.Store.Test' -or
    $metadata.identity.publisher -cne 'CN=Motrix Store Test' -or
    $sdk.identity.name -cne $metadata.identity.name -or
    $sdk.identity.publisher -cne $metadata.identity.publisher -or
    $metadata.source.commit -cne $expectedCommit -or
    $source.ok -ne $true -or $source.observed.commit -cne $expectedCommit -or
    $source.observed.productVersion -cne $metadata.productVersion -or
    $sdk.productVersion -cne $metadata.productVersion -or
    $metadata.packageVersion -notmatch '^\d+\.\d+\.\d+\.\d+$' -or
    $sdk.packageVersion -cne $metadata.packageVersion -or
    $sdk.status -cne 'completed' -or $sdk.signed -ne $false) {
  throw 'The local test metadata and completed SDK evidence do not match'
}
$unsigned = Join-Path "$prepared.sdk-output" "Motrix-Store-Test-$($metadata.packageVersion)-x64.appx"
$unsignedHash = (Get-FileHash -LiteralPath $unsigned -Algorithm SHA256).Hash.ToLowerInvariant()
if ($unsignedHash -cne $sdk.package.sha256) { throw 'Unsigned package hash mismatch' }
$signTool = Join-Path $sdkBin 'signtool.exe'
if (-not (Test-Path -LiteralPath $signTool -PathType Leaf)) { throw 'SignTool was not found' }
if (Test-Path -LiteralPath $lab) { throw 'Choose a new runtime output directory' }
New-Item -ItemType Directory -Path $lab | Out-Null
$signed = Join-Path $lab ([IO.Path]::GetFileName($unsigned))
[IO.File]::Copy($unsigned, $signed, $false)
```

## 2. 创建临时签名证书并签名副本

继续使用**同一个签名会话**，保留上一步变量。若会话已经关闭，按记录恢复路径和
变量，不重新创建或覆盖输出目录。证书具有代码签名 EKU，属于终端实体而非 CA。不可导出的私钥保留
在该用户的 `CurrentUser\My`，只导出 CER 公钥。Subject 须与 manifest Publisher
精确一致。依据微软的[包签名证书要求](https://learn.microsoft.com/windows/msix/package/create-certificate-package-signing)
和[公钥证书导出](https://learn.microsoft.com/powershell/module/pki/export-certificate)说明。

```powershell
$cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=Motrix Store Test' `
  -FriendlyName 'Motrix Store Test - disposable lab only' `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 `
  -HashAlgorithm SHA256 -KeyUsage DigitalSignature -KeyExportPolicy NonExportable `
  -NotAfter (Get-Date).AddDays(30) `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$thumbprint = $cert.Thumbprint
Export-Certificate -Cert $cert -FilePath (Join-Path $lab 'motrix-store-test.cer') -Type CERT -NoClobber | Out-Null
$thumbprint | Set-Content -LiteralPath (Join-Path $lab 'certificate-thumbprint.txt')
$thumbprint
```

升级 B 时复用 A 的未过期证书，不重新执行创建命令：用
`$cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\<recorded-thumbprint>"` 载入。
签名必须使用拥有该私钥的同一 Windows 用户。

SignTool 按精确指纹从当前用户个人证书库选择证书。`/sha1` 用于定位证书，
`/fd SHA256` 才是与 MakeAppx 一致的包签名摘要算法。不使用 `/sm`、自动选择证书
或 PFX。该短期测试步骤不使用时间戳服务，应在证书到期前完成测试。参见
[SignTool 参数](https://learn.microsoft.com/windows/win32/seccrypto/signtool)和
[包签名](https://learn.microsoft.com/windows/msix/package/sign-app-package-using-signtool)。

```powershell
if ($cert.Subject -cne 'CN=Motrix Store Test' -or -not $cert.HasPrivateKey -or
    $cert.NotAfter -le (Get-Date)) { throw 'A matching, unexpired private signing certificate is required' }
& $signTool sign /sha1 $cert.Thumbprint /s My /fd SHA256 $signed
if ($LASTEXITCODE -ne 0) { throw 'Test package signing failed' }
$signedHash = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash.ToLowerInvariant()
[ordered]@{
  sourceCommit = $expectedCommit
  productVersion = $metadata.productVersion
  packageVersion = $metadata.packageVersion
  unsignedSha256 = $unsignedHash
  signedSha256 = $signedHash
  certificateThumbprint = $cert.Thumbprint
  signed = $true
  installed = $false
  windowsRuntimeVerified = $false
  storeReady = $false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $lab 'signing-record.json')
```

## 3. 在测试机信任公钥证书

在可丢弃目标机器上使用**管理员** Windows PowerShell 5.1，填入相同输出路径，
并独立核对签名会话显示的指纹。若构建机与测试机不同，仅传递已签名 AppX、公钥
CER 和文字记录，通过可信渠道核对签名后的 SHA-256，不传递私钥。

导入位置为 `LocalMachine\TrustedPeople`，会影响此机器全部用户的信任关系，
不向根证书库添加 CA。记录是否原先已有相同信任，清理时避免删除原有条目。
命令依据微软 [Import-Certificate](https://learn.microsoft.com/powershell/module/pki/import-certificate)。

```powershell
$ErrorActionPreference = 'Stop'
$lab = 'C:\path\motrix-store-runtime-a'
$expectedThumbprint = '<thumbprint displayed in the signing session>'
if ($expectedThumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Set the exact certificate thumbprint' }
$cer = Join-Path $lab 'motrix-store-test.cer'
$publicCert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($cer)
if ($publicCert.Subject -cne 'CN=Motrix Store Test' -or
    $publicCert.Thumbprint -ine $expectedThumbprint -or $publicCert.HasPrivateKey) {
  throw 'Unexpected public certificate'
}
$trustPath = "Cert:\LocalMachine\TrustedPeople\$expectedThumbprint"
$trustRecord = Join-Path $lab 'trust-record.json'
if (Test-Path -LiteralPath $trustRecord) { throw 'Keep the original trust record; do not overwrite it' }
[ordered]@{
  thumbprint = $expectedThumbprint
  existedBefore = (Test-Path -LiteralPath $trustPath)
} | ConvertTo-Json | Set-Content -LiteralPath $trustRecord
Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
```

## 4. 以测试用户核验、安装和启动

回到目标测试用户的**非提升权限** Windows PowerShell 5.1；每个账户的包注册独立。
以文字保存 SignTool 结果和包身份。部署失败时保留错误码与 ActivityId，使用
`Get-AppxLog -ActivityID '<reported-guid>'` 提取该次操作日志，分享前脱敏用户路径。
不绕过签名检查或强制降级。

```powershell
$ErrorActionPreference = 'Stop'
$lab = 'C:\path\motrix-store-runtime-a'
$sdkBin = 'C:\Program Files (x86)\Windows Kits\10\bin\<installed-sdk-version>\x64'
$record = Get-Content -LiteralPath (Join-Path $lab 'signing-record.json') -Raw | ConvertFrom-Json
$signed = Join-Path $lab "Motrix-Store-Test-$($record.packageVersion)-x64.appx"
if ((Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash -ine $record.signedSha256) {
  throw 'Signed package hash mismatch'
}
& (Join-Path $sdkBin 'signtool.exe') verify /pa /v $signed
if ($LASTEXITCODE -ne 0) { throw 'Signature/trust verification failed; do not install' }
$before = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($before.Count -ne 0) { throw 'This is not a clean install; use the upgrade procedure instead' }
Add-AppxPackage -Path $signed -ErrorAction Stop
$packages = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($packages.Count -ne 1) { throw 'Expected exactly one current-user test package' }
$installed = $packages[0]
if ($installed.Publisher -cne 'CN=Motrix Store Test' -or
    $installed.Version.ToString() -cne $record.packageVersion -or
    $installed.Status.ToString() -cne 'Ok') { throw 'Installed package identity/version/status mismatch' }
$installed | Select-Object Name, Publisher, Version, PackageFullName, PackageFamilyName, Architecture, SignatureKind, Status | Format-List
```

### 检查已安装的诊断 alias

若包以 `testDiagnostics: "native-messaging-probe-v1"` 构建，可在安装后、启动 Motrix
之前运行此可选诊断。使用准备包时同一 checkout 中的 Node 24 和锁定依赖，传入该包
已经生成 PRI 的准备目录。显式指定当前安装的四段包版本，以及父目录已存在的新
JSON 报告路径。工具以当前测试用户运行，不执行签名、安装、浏览器注册或主应用启动。

```powershell
$diagnosticLayout = 'C:\path\motrix-store-diagnostic-layout'
$expectedPackageVersion = '1.0.0.0'
$aliasReport = 'C:\path\motrix-store-runtime-a\alias-report.json'
node scripts/test-windows-store-native-messaging-alias.mjs --prepared $diagnosticLayout --expected-package-version $expectedPackageVersion --report $aliasReport
if ($LASTEXITCODE -ne 0) { throw 'Installed diagnostic alias verification failed' }
```

检查器对比已安装 manifest、探针字节与准备记录，再通过绝对 WindowsApps alias
发送固定公开挑战。必须得到一个有界帧、空 stderr、预期版本，以及与完整包名和
helper AUMID 相符的 SHA-256 摘要。摘要用于比对，并非认证凭据。三个案例结束后
会重新检查安装包，拒绝测试期间发生的升级。失败会写失败报告并以非零状态退出。

Chromium、Firefox 形状的参数是模拟输入。成功报告只证明所记录环境中的诊断 alias
激活、身份和管道，不证明真实浏览器发现、MBP1、主应用行为或微软签名商店安装。
验证“升级后尚未首次启动”时，在安装 B 后使用 B 的准备目录和版本再次运行，随后
再启动主应用。

手动 hosted CI 使用固定 payload 执行此顺序：A 的三个 alias 案例、原地升级 B、
主应用尚未启动时重跑三个案例。`alias-report-a.json` 和 `alias-report-b.json` 须显示
各自的预期版本、不同完整包名，以及相同包家族和 helper 应用身份。该实验验证包版本
变化时 alias 的重定向，不覆盖主应用数据迁移或真实浏览器连接；运行报告将此结果与
一般升级验收分开记录。

### 在真实浏览器中检查诊断 Native Messaging

独立浏览器检查器会使用新建的临时 profile，打开已安装的 Google Chrome、Microsoft
Edge 和 Mozilla Firefox。仅在已安装诊断包的可丢弃测试账户中运行。它会为当前用户
临时注册固定的 `app.motrix.bridge.store.p0` host，不使用正式 Motrix host。
传入一个父目录已存在、尚未创建的输出目录：

```powershell
$diagnosticLayout = 'C:\path\motrix-store-diagnostic-upgrade-layout'
$expectedPackageVersion = '1.0.1.0'
$browserOutput = 'C:\path\motrix-store-runtime-b\browser'
$relayBuild = 'C:\path\motrix-store-firefox-relay'
pwsh -NoProfile -File scripts/build-windows-store-firefox-alias-relay.ps1 -OutputDirectory $relayBuild
if ($LASTEXITCODE -ne 0) { throw 'Diagnostic relay build failed' }
node scripts/test-windows-store-native-messaging-browser.mjs --prepared $diagnosticLayout --expected-package-version $expectedPackageVersion --output-directory $browserOutput --firefox-relay-build-dir $relayBuild
if ($LASTEXITCODE -ne 0) { throw 'Diagnostic browser verification failed' }
```

该显式实验为 Firefox 注册普通 PE 中转入口，再由它调用固定诊断 alias；Chrome 和 Edge 直接调用 alias。中转入口只转发一次固定挑战，不读取配置或连接 MBP1。检查器核对源码、编译报告和实际 EXE 摘要，并记录 `hostLaunchMode`。省略 `--firefox-relay-build-dir` 可重现 Firefox 直连 alias 的路径；两种模式不能混为同一验证结果。此实验使用临时目录，不证明生产环境的中转文件部署、跨升级保留或卸载清理已实现。

每个浏览器都必须在注册前连接失败、注册后收到固定诊断回复、撤销注册后再次失败。
检查器拒绝任何已存在的同名测试 host 注册，包括其他注册表视图和 Edge 回退位置。
它只清理所有权仍与本次运行匹配的注册和文件。Chrome/Edge 加载解包测试扩展，
Firefox 加载临时附加组件，不访问现有浏览器 profile 或登录账户。缺少浏览器或
不支持扩展加载方式均为失败，不能用其他浏览器替代所要求的品牌。
Chrome 和 Edge 使用有界面的 CDP 会话，Firefox 使用无界面的 BiDi 会话；报告将
自动化模式与实际浏览器版本一并记录。

回复必须匹配安装包版本、完整包名与 helper 身份摘要。浏览器证据记录扩展消息和断连；
原始 stdio 帧与进程退出码由独立 alias 检查器验证。CI 只保留 `browser-report.json`，
记录浏览器版本、摘要、案例和清理结果，不上传截图或 profile 文件。手动 hosted CI
在 B 的 alias 检查后、卸载 B 前执行此检查。它只测试 B 的诊断 host 浏览器发现，
不证明浏览器连接跨升级保留、正式 MBP1 host 或 Windows 11 普通用户验收通过。

### 启动 Motrix 并记录运行场景

```powershell
Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$($installed.PackageFamilyName)!Motrix"
```

直接运行解包目录中的 `app\Motrix.exe` 不能证明包激活成功。使用上述已安装 AUMID
或开始菜单入口。`Add-AppxPackage` 成功也不能证明应用行为正常。记录 Windows
版本/build、x64 架构、产品版本、源提交、签名前后摘要、证书指纹、包版本和实际 AUMID。

逐项记录 `pass`、`fail`、`not-run` 或 `not-applicable` 及实际观察；后两项必须说明原因：

| 范围 | 必须观察的行为 |
|---|---|
| 首次启动与共存 | 无系统 Node/pnpm 依赖；包版与官网版的 profile、设置、凭据、锁和任务记录互不混用。两版默认共用系统 Downloads 目录，测试时须分别选择不同的可丢弃下载目录。 |
| 下载与运行组件 | HTTPS、获授权 torrent/magnet、暂停恢复/重启、Unicode 路径、SQLite 读写、aria2 与文件整理 helper。 |
| 登录启动 | 初始禁用；打开设置不启用；显式保存尊重系统/用户策略；注销登录遵循窗口显示偏好。 |
| 激活与默认应用 | motrix、mo、magnet、torrent 冷热激活、多选 Unicode 路径、畸形链接、默认应用刷新与定向设置页。链接只预填或导航。 |
| 通知 | 完成/错误通知路由、延迟重复回调、历史通知冷启动、启动/退出竞争、插件替换/关闭/点击及官网版共存。 |
| 浏览器与 CLI 限制 | 包版准确提示自动发现尚不支持，不修改官网 host 注册表/文件，不探测 CLI 或从应用内安装；已有配对/撤销仍可管理。这不证明浏览器/CLI 支持。 |
| 更新 | 包版不启动 NSIS 更新器；A→B 后身份、启动项、关联、通知和测试数据保留。 |

仅回传文字观察和脱敏日志，不包含截图、profile 数据库、endpoint 文件、配对码、
token、凭据、私钥或私人下载地址。缺少观察的项目仍为未验证。

## 5. 同一测试包家族内升级

正常退出 Motrix。从目标干净提交为 B 创建全新的构建、布局、SDK 输出与运行目录。
提高四段包版本（例如 `1.0.0.0` → `1.0.1.0`），在 `previousPackageVersions` 中
包含 A，保持 Name/Publisher/架构不变并复用 A 的证书。不修改已完成布局或复用旧
staging 输出。为 B 重复第 1、2 节，跳过新建证书和导入信任。复制第 4 节的
验证部分（到 SignTool 退出码检查为止），**把复制代码内部的 `$lab = ...` 赋值
改成 B 的目录**后执行，再运行下面的升级代码，不执行全新安装部分。
微软的 [Add-AppxPackage 更新](https://learn.microsoft.com/powershell/module/appx/add-appxpackage)
要求包家族相同。

```powershell
# Set $lab to the new B runtime directory. Repeat the signed hash and
# SignTool verification from the install section before this block.
$before = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($before.Count -ne 1 -or $before[0].Publisher -cne 'CN=Motrix Store Test') {
  throw 'Expected the existing test package'
}
if ([version]$record.packageVersion -le [version]$before[0].Version) {
  throw 'Upgrade requires a strictly higher package version'
}
$previousFamily = $before[0].PackageFamilyName
Add-AppxPackage -Path $signed -ErrorAction Stop
$after = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($after.Count -ne 1 -or $after[0].PackageFamilyName -cne $previousFamily -or
    $after[0].Version.ToString() -cne $record.packageVersion -or
    $after[0].Status.ToString() -cne 'Ok') { throw 'Upgrade identity/version/status mismatch' }
```

重新启动已安装的包，复测受影响场景，分别保留 A/B 观察。仅用可丢弃的下载、设置和
配对数据测试持久化；安装成功不能代替迁移验证。

## 6. 卸载并只清理本次测试证书

记录卸载前基线并退出 Motrix 后，以同一非提升权限测试用户执行。卸载可能删除测试
应用数据。不删除其他用户的包，不使用通配符删除包，不手动删除 profile。后续清理
之前先记录实际残留的注册项和文件。

```powershell
$ErrorActionPreference = 'Stop'
$packages = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($packages.Count -ne 1 -or $packages[0].Publisher -cne 'CN=Motrix Store Test') {
  throw 'Expected exactly the current-user Motrix test package'
}
Remove-AppxPackage -Package $packages[0].PackageFullName -ErrorAction Stop
if (@(Get-AppxPackage -Name 'Motrix.Store.Test').Count -ne 0) { throw 'Test package is still registered' }
```

全部使用该证书的测试包均已移除后，管理员会话使用 **A 的原始信任记录**移除信任：

```powershell
$ErrorActionPreference = 'Stop'
$lab = 'C:\path\motrix-store-runtime-a'
$trust = Get-Content -LiteralPath (Join-Path $lab 'trust-record.json') -Raw | ConvertFrom-Json
if ($trust.thumbprint -notmatch '^[0-9A-Fa-f]{40}$' -or $trust.existedBefore -ne $false) {
  throw 'Do not remove pre-existing trust or an unrecognized certificate'
}
$trustPath = "Cert:\LocalMachine\TrustedPeople\$($trust.thumbprint)"
$trusted = Get-Item -LiteralPath $trustPath
if ($trusted.Subject -cne 'CN=Motrix Store Test') { throw 'Unexpected certificate subject' }
Remove-Item -LiteralPath $trustPath -ErrorAction Stop
```

最后回到原签名用户会话，按记录指纹删除证书及私钥；之后无法再使用该私钥签名升级。
保留文字证据，不再需要时另行清理可丢弃输出。证书 provider 的
[`-DeleteKey`](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/about/about_certificate_provider)
同时删除关联私钥：

```powershell
$thumbprint = '<the same recorded certificate thumbprint>'
if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Set the exact certificate thumbprint' }
$keyPath = "Cert:\CurrentUser\My\$thumbprint"
$cert = Get-Item -LiteralPath $keyPath
if ($cert.Subject -cne 'CN=Motrix Store Test') { throw 'Unexpected certificate subject' }
Remove-Item -LiteralPath $keyPath -DeleteKey -ErrorAction Stop
```
