# Flatpak Native Messaging companion

Motrix 的 Flatpak 浏览器集成明确拆为两层：

1. `motrix-flatpak-native-host` 在 Flatpak 沙箱外作为浏览器 Native Messaging host 运行，负责浏览器 manifest、启动固定的 Motrix Flatpak 应用，以及仅转发带帧边界的配对请求。
2. `motrix-native-host-broker` 在 Motrix Flatpak 沙箱内运行，负责解析 Bridge endpoint、执行 localhost 健康检查并获取一次性 nonce。外层 companion 不会重复实现或弱化这一安全边界。

GitHub Release 会为受支持的 64 位 Linux 架构分别发布独立压缩包：

- `Motrix-Native-Host-<version>-linux-x64.tar.gz`
- `Motrix-Native-Host-<version>-linux-arm64.tar.gz`

每个压缩包都包含项目许可证、中英双语第三方声明，以及 Rust 可执行文件所需的完整第三方许可证文本。

## 安装

请先安装 Motrix Flatpak，再从同一个 Motrix GitHub Release 下载与宿主机 CPU 匹配的压缩包：

```sh
tar -xzf Motrix-Native-Host-<version>-linux-<arch>.tar.gz
cd Motrix-Native-Host-<version>-linux-<arch>
./motrix-flatpak-native-host install
./motrix-flatpak-native-host status
```

安装器会把 companion 复制到：

```text
$XDG_DATA_HOME/motrix/native-messaging/motrix-flatpak-native-host
```

未设置 `XDG_DATA_HOME` 时使用 `~/.local/share`。配置写入 `$XDG_CONFIG_HOME/motrix/native-messaging/flatpak-companion.json`，未设置时回退到 `~/.config`。安装器会为 Chrome、Chromium、Edge 和 Firefox 写入用户级 Native Messaging manifest。

如果 Flatpak 位于非标准路径，请传入经过确认的绝对路径：

```sh
./motrix-flatpak-native-host install --flatpak-bin /absolute/path/to/flatpak
```

只有在确定要替换现有 companion 配置时才使用 `--force`。要删除已安装二进制、配置和由它管理的 manifest，请运行：

```sh
./motrix-flatpak-native-host uninstall
```

完整命令说明可通过 `./motrix-flatpak-native-host --help` 查看。

## 安全与生命周期说明

Flatpak 应用无法自行安装这个宿主机侧组件或浏览器 manifest；安装必须由宿主机用户显式执行。Companion 是独立原生可执行文件，不依赖 Node.js、Electron、运行时网络下载，也不依赖 `PATH` 中的解释器；唯一可配置的外部可执行文件是经校验的 Flatpak 绝对路径。

安装过程会拒绝 symlink、非当前用户所有或允许 group/other 写入的路径组件。新建私有目录固定使用 `0700`，已安装 companion 使用 `0700`，config 与 manifest 使用 `0600`，不受调用方 umask 影响。自定义 Flatpak executable 会以 canonical path 保存，并在 companion 每次运行时重新校验。

标准 manifest 覆盖直接安装在宿主机上的浏览器。如果浏览器自身也运行在沙箱中，则可能需要由其发行渠道另行提供并信任的 Native Messaging proxy；仅安装本压缩包不会自动打通这类浏览器。

Companion 只注册 Motrix 内置的官方扩展身份。在 Flatpak 应用内添加的自定义扩展 ID 不会同步到宿主机 companion，因此本安装器不会注册这些 ID。

升级 companion 压缩包后，请运行 `install --force`，随后运行 `status`。普通 Motrix `.deb` 和 `.rpm` 包不会携带这个仅用于 Flatpak 的 companion。

安装后，companion 会持续拥有 Motrix 共用的 Linux 浏览器 manifest。`.deb`、`.rpm` 或 Snap 版 Motrix 不会覆盖或删除 companion 所拥有的 manifest。若要有意把浏览器集成切换回非 Flatpak 安装，请先卸载 companion。
