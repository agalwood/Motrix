# Flatpak 安装

[English](flatpak.md)

从包含 `.flatpak` 产物的 [Motrix GitHub Release](https://github.com/agalwood/Motrix/releases)
下载主程序包。2.0 的 beta.39 及更早 beta 版本仅包含 Native Host 配套程序，不能用它安装主程序。

| `uname -m` | 主程序包 | 可选的浏览器配套程序 |
|------------|----------|--------------------|
| `x86_64` | `Motrix-<version>-x86_64.flatpak` | `Motrix-Native-Host-<version>-linux-x64.tar.gz` |
| `aarch64` | `Motrix-<version>-aarch64.flatpak` | `Motrix-Native-Host-<version>-linux-arm64.tar.gz` |

## 安装和运行

先通过发行版的包管理器安装 Flatpak。添加 Flathub 以获取共享运行时，再以普通用户
安装下载的主程序包。将占位符替换为实际文件名：

```bash
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user ./Motrix-<version>-<arch>.flatpak
flatpak run app.motrix.native
```

应用 ID 为 `app.motrix.native`。Beta 包使用 Flatpak 的 `beta` 分支，正式版本使用
`stable` 分支。使用浏览器配套程序时，请只保留其中一个分支。这里添加 Flathub 是
为了获取依赖，不会安装旧的 `net.agalwood.Motrix`，也不代表 Motrix 2.x 已上架
Flathub。旧 ID 对应另一个应用，不会自动升级为新 ID。

沙箱默认允许访问下载目录；其他目录通过文件选择器 portal 授权。应用数据保存在
`~/.var/app/app.motrix.native/` 下。切换安装包格式不会自动迁移原有 Motrix 数据。

## 浏览器扩展

普通下载不需要 companion。若要启用受支持的宿主机浏览器的 Native Messaging
集成，请先安装主程序，再下载同版本、对应架构的 Native Host 配套程序，并按照
[companion 安装指南](../packages/native-host/README.zh-CN.md)操作。

主程序包包含沙箱内的 broker；companion 在沙箱外运行，由用户单独安装。两者不能
相互替代，仅安装 `.tar.gz` 不会安装 Motrix 主程序。

## 升级和卸载

退出 Motrix，下载相同架构、相同分支的新版本 `.flatpak`，再次执行
`flatpak install --user ./…flatpak`。Flatpak 会提示更新现有安装。如果安装了浏览器
companion，还需要按照其文档使用 `install --force` 单独升级。

这些包不会配置 Motrix remote。`flatpak update` 可以更新共享运行时，但不会从
GitHub 发现新的 Motrix 单文件包。主程序每次更新都需要从 Release 下载。

```bash
flatpak uninstall --user app.motrix.native
```

如果安装了 companion，请单独卸载它。只有确定要删除应用保存的数据时，才添加
`--delete-data`。

## 构建和发布检查

Release 工作流复用 PR CI 使用的 x86_64/aarch64 原生 Flatpak 构建流程。它归档
发布事件对应的提交，核对源码版本、发布预检版本及 AppStream 版本，并固定源码
归档的校验和。每个包都会实际安装，检查应用 ID、架构、分支、版本、aria2 功能和
私有 broker 协议。x86_64 还会检查宿主机 companion 的 Native Messaging 帧通信。

两种架构都成功后才能组装和发布 Release。主程序包属于必需发布产物，不进入
Electron 的自动更新 manifest。手动运行 Release 工作流只验证构建，不会发布。
这些检查不能替代对 portal、托盘和浏览器配对的交互式桌面测试。
