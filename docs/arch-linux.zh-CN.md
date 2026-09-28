# Arch Linux 与 Omarchy

[English](arch-linux.md)

Omarchy 使用 Arch Linux 软件包和 `pacman`。Motrix 发布构建提供 `x64`
（`x86_64`）和 `arm64`（`aarch64`）原生 `.pacman` 包。请从包含此格式的
[GitHub Release](https://github.com/agalwood/Motrix/releases) 附件中下载。
较早的版本可能只提供 AppImage、DEB 和 RPM。

`.pacman` 是 electron-builder 为原生 Arch 包使用的后缀。压缩包使用
Zstandard 压缩，包含 Arch 软件包元数据，与 `.pkg.tar.zst` 包属于同一类
格式。请保留发布时的文件名：Motrix 的应用更新器会从发布清单中选择
`.pacman` 附件。

## 安装

运行 `uname -m` 查看架构。输出 `x86_64` 时选择 `x64`，输出 `aarch64`
时选择 `arm64`（ARM 文件名使用 `aarch64`）。安装前先通过 Omarchy 的 Update 菜单更新系统；普通
Arch Linux 使用 `sudo pacman -Syu`。

在下载文件所在目录执行以下命令，把占位符替换为实际文件名：

```bash
sudo pacman -U ./Motrix-<version>-<arch>.pacman
motrix
```

Pacman 会把应用安装到 `/opt/Motrix`，添加 `motrix` 命令，并安装启动器、
图标以及 Torrent、Magnet、Motrix URL 处理程序。安装包自带 Electron、
aria2 和原生辅助程序。Pacman 会解析声明的系统库依赖，无需单独安装系统
Electron 包。请以普通用户身份运行 Motrix。

如果系统托盘需要 AppIndicator 支持，可安装可选的
`libayatana-appindicator` 包。启动后可在 Motrix 的集成设置中配置浏览器
扩展配对。

## 更新与卸载

下载新版 `.pacman` 文件后，使用相同的 `pacman -U` 命令更新。安装包也
携带 Motrix 应用内更新流程所需的元数据。由于下载的软件包不是已配置的
软件仓库，单独运行 `pacman -Syu` 不会获取 Motrix 新版本。

```bash
sudo pacman -R motrix
```

卸载会移除已安装的应用和桌面入口，下载文件与用户配置仍保留在用户目录
中。安装包声明了与 `motrix-bin` 等现有 AUR 变体的冲突，便于 pacman
处理迁移，避免重叠安装。

## 构建与验证

构建并暂存 Linux 桌面应用后，在对应架构的 Linux 上打包。发布工作流
会提供原生构建输入和打包工具，包括 `zstd` 与 `bsdtar`；后者在 Arch
上由 `libarchive` 提供，在 Ubuntu 上由 `libarchive-tools` 提供：

```bash
pnpm exec electron-builder --linux pacman --x64 --publish never
node scripts/verify-pacman-artifact.mjs --dir release --version <version> --arch x64
bash scripts/smoke-pacman-package.sh release
```

ARM 构建使用 `--arm64` 和 `--arch arm64`。CI 和发布工作流会检查两种
架构的最终压缩包、元数据、桌面处理程序以及 Electron 和原生程序内容。
Docker 冒烟测试使用官方 x86_64 Arch 镜像，检查安装、共享库解析、aria2
执行、重新安装和卸载。它不会验证完整的 Omarchy／Hyprland 图形会话；
托盘、Wayland 渲染和浏览器配对仍需桌面测试。ARM 包不运行这项 x86_64
安装测试。

这些产物通过 Motrix Release 分发，不会自动发布或更新 AUR 条目，也不会
把 Motrix 加入 Omarchy 的软件仓库。
