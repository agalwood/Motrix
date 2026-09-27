# Windows 包准备

[English](windows-store-preparation.md)

Motrix 的 Windows 打包支持仍在开发中。以下工具用于校验构建输入，不会生成
AppX/MSIX、签名、提交商店，也不代表已兼容 Microsoft Store。启动任务、包关联、
浏览器集成和安装生命周期仍需要实现及 Windows 验证。

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

未签名的目录包、合法元数据或通过本地校验，都不等于可分发的 Store 包。仍须执行
真正的 Windows 打包、包身份核验、WACK，以及安装和升级测试。

## 参考资料

- [包身份和版本范围](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/package-identity-overview)
- [Store 包与版本要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [Partner Center 身份详情](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)
