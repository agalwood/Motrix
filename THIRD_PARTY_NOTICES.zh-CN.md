# 第三方资源声明（Third-Party Notices）

Motrix 采用 MIT 许可证发布（详见 `package.json` 与 `LICENSE`）。本项目
自行编写的源代码整体以 MIT 授权。

但是，**本仓库还包含一部分不在 MIT 许可范围内的第三方资源**。这些资源按各自
的许可条款使用，清单见下文。若你 fork、二次分发或重新打包本项目，你需自行
为以下每一项资源持有相应的合规授权，否则必须用你有权分发的素材进行替换。

---

## 设置页图标（Iconly Pro — UI8）

- **作者 / 设计师：** Iconly Pro
- **来源：** UI8 素材市场 — <https://ui8.net>
- **许可：** 专有授权，遵循 UI8 标准许可协议
  (<https://ui8.net/licensing>)。**非 MIT。** 不受本项目的 `LICENSE` /
  `package.json` 中的 license 字段覆盖。
- **在项目中的用途：** 作为设置页的分类图标使用，在
  `src/renderer/routes/settings/cards` 及相关组件中渲染。

### 涉及文件

```
src/renderer/routes/settings/icons/icon-about@1x.png
src/renderer/routes/settings/icons/icon-about@2x.png
src/renderer/routes/settings/icons/icon-advanced@1x.png
src/renderer/routes/settings/icons/icon-advanced@2x.png
src/renderer/routes/settings/icons/icon-appearance@1x.png
src/renderer/routes/settings/icons/icon-appearance@2x.png
src/renderer/routes/settings/icons/icon-bittorrent@1x.png
src/renderer/routes/settings/icons/icon-bittorrent@2x.png
src/renderer/routes/settings/icons/icon-download@1x.png
src/renderer/routes/settings/icons/icon-download@2x.png
src/renderer/routes/settings/icons/icon-general@1x.png
src/renderer/routes/settings/icons/icon-general@2x.png
src/renderer/routes/settings/icons/icon-integration@1x.png
src/renderer/routes/settings/icons/icon-integration@2x.png
src/renderer/routes/settings/icons/icon-network@1x.png
src/renderer/routes/settings/icons/icon-network@2x.png
```

### 对下游用户的影响

- Motrix 源代码上的 MIT 许可证**不授予**你分发上述 PNG 文件的权利。
- 如果你构建并发布衍生版本（fork、私有构建、二次打包等），你必须：
  1. 自行拥有有效的 UI8 / Iconly Pro 授权以覆盖该分发场景；**或**
  2. 将这些文件替换为你有权分发的图标素材（例如以 `CC-BY-4.0`、
     `Apache-2.0` 等 SPDX 兼容开源协议发布的资源）。
- 将它们打包进 Electron `asar` 内部同样属于"分发"，不豁免此限制。

---

## Apple San Francisco 托盘字体（macOS）

- **文件：** `extra/tray/SFNS-Regular.ttf`
- **权利人：** Apple Inc.
- **许可证：** Apple San Francisco Font License，属于专有许可，**并非 MIT**。
- **在项目中的用途：** 随 macOS 应用一同打包，由托盘速率显示组件加载，以保持
  紧凑文字布局的一致性。
- **官方条款：** <https://developer.apple.com/fonts/>

该文件是 macOS 托盘渲染链路的一部分，因此予以保留。但无论它出现在本仓库还是
应用安装包中，都不会使下游用户获得 Apple 许可条款以外的权利。任何分发 Motrix
或其衍生版本的人，都必须自行确认其 Apple 协议或 Apple 另行出具的书面授权涵盖
相应的分发方式；若不涵盖，则应在分发前取得授权或替换该字体。

---

## aria2 下载引擎

桌面版随应用打包 `aria2c` 可执行文件，版本由 `scripts/engine.lock.json` 固定：

- **版本：** 1.37.0-motrix.11
- **对应源码：** <https://github.com/motrixapp/aria2/tree/v1.37.0-motrix.11>
- **许可证：** GNU General Public License v2.0 or later（`GPL-2.0-or-later`）
- **完整许可证文本：** `THIRD_PARTY_LICENSES/aria2-COPYING`
- **OpenSSL 例外条款 / 声明：**
  `THIRD_PARTY_LICENSES/aria2-LICENSE.OpenSSL`

上述链接指向与内置二进制文件对应的源码版本。再次分发时，分发者仍须针对实际
发布的二进制文件履行 GPL 的源码提供和声明保留义务；如果自行构建，还应核对构建
产物所链接的其他库及其许可要求。

---

## GeoIP 数据库（用户自行启用、自行下载）

Motrix Turbo 提供一个可选的 IP→国家查找功能，依赖 **MaxMind GeoLite2-Country**
数据库。本仓库**不**再分发任何 GeoLite2 数据文件。当用户在 Settings → Advanced
中启用该功能时，应用从用户选择的源下载 `GeoLite2-Country.mmdb` 并保存在用户数据目录中。

数据库本身的许可由 MaxMind 控制，用户启用该功能时即视为接受以下条款：

- [GeoLite2 End User License Agreement](https://www.maxmind.com/en/geolite2/eula)
- [知识共享 署名-相同方式共享 4.0 国际许可（CC BY-SA 4.0）](https://creativecommons.org/licenses/by-sa/4.0/deed.zh)

本产品包含由 MaxMind 创建的 GeoLite2 数据，下载地址：<https://www.maxmind.com>。

用户可在以下默认社区镜像之间选择：

- **Loyalsoldier/geoip**（<https://github.com/Loyalsoldier/geoip>）—— 含 CN
  区域增强的社区版本；上游数据来自 MaxMind。
- **P3TERX/GeoLite.mmdb**（<https://github.com/P3TERX/GeoLite.mmdb>）—— 每周
  自动同步上游 MaxMind release 的镜像。

选择任一镜像即表示在 MaxMind 自身许可之外还接受该镜像的条款。Motrix 的 MIT
许可不覆盖数据库内容——后者由 MaxMind / CC BY-SA 4.0 约束。

---

## 随应用分发的 Motrix 扩展

应用会从 <https://github.com/motrixapp/builtin-plugins> 的固定 release 中获取并
分发以下经过签名的扩展包：

- `motrix.filename-template`
- `motrix.scraper-hook`
- `motrix.url-resolver`

这些扩展由 Motrix 项目自行维护和发布，并不是 npm 第三方依赖。但当前上游扩展包
没有携带独立的许可证声明，因此生成的 SBOM 将其许可证记为 `NOASSERTION`，而不会
擅自认定另一个仓库也受本仓库的 MIT 许可证覆盖。在上游项目发布适用条款之前，
下游分发者不应自行假定拥有再分发权。由产出扩展包的上游仓库补充许可证信息和
声明文件，仍是后续发布流程必须完成的事项。

---

## npm 运行时依赖与 SBOM

npm 依赖清单根据根目录声明的运行时依赖，以及 `pnpm-lock.yaml` 解析出的已安装
依赖图自动生成。生成器读取每个确定版本的 `package.json`，并且只自动查找 package
根目录下的 `LICENSE`、`LICENCE`、`COPYING`、`NOTICE` 或 `COPYRIGHT` 文件。如果
某个 package 未随包发布顶层许可证文件，就必须在
`scripts/third-party-notices.config.json` 中加入经过审阅的显式例外。

每次构建应用时，都会在 `legal/` 目录中生成并随包分发以下文件：

- `THIRD_PARTY_DEPENDENCIES.md`：package、版本、源码地址和 SPDX 许可证清单；
- `THIRD_PARTY_LICENSES.txt`：去重后的完整许可证与声明文本；
- `sbom.spdx.json`：SPDX 2.3 格式的软件物料清单（SBOM）。

运行 `pnpm run check:third-party-notices` 可校验依赖声明，运行
`pnpm run build:legal` 可重新生成待分发文件。生成内容与当前构建平台有关，属于构建
产物，不提交到仓库。

---

## Rust native messaging 可执行文件依赖

`motrix-native-host`、宿主机侧 `motrix-flatpak-native-host` 与沙箱内
`motrix-native-host-broker` 可执行文件使用以下 crate 构建，具体版本由
`packages/native-host/Cargo.lock` 锁定。Windows-only crate 也列在表中，因为
Windows native-host 构建会包含它们。

| Crate | 版本 | SPDX 许可证表达式 | 源码仓库 |
| --- | --- | --- | --- |
| base64 | 0.22.1 | `MIT OR Apache-2.0` | <https://github.com/marshallpierce/rust-base64> |
| block-buffer | 0.10.4 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/utils> |
| cfg-if | 1.0.4 | `MIT OR Apache-2.0` | <https://github.com/rust-lang/cfg-if> |
| cpufeatures | 0.2.17 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/utils> |
| crypto-common | 0.1.7 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/traits> |
| digest | 0.10.7 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/traits> |
| generic-array | 0.14.7 | `MIT` | <https://github.com/fizyk20/generic-array> |
| hkdf | 0.12.4 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/KDFs> |
| hmac | 0.12.1 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/MACs> |
| home | 0.5.12 | `MIT OR Apache-2.0` | <https://github.com/rust-lang/cargo> |
| humantime | 2.4.0 | `MIT OR Apache-2.0` | <https://github.com/chronotope/humantime> |
| itoa | 1.0.18 | `MIT OR Apache-2.0` | <https://github.com/dtolnay/itoa> |
| libc | 0.2.189 | `MIT OR Apache-2.0` | <https://github.com/rust-lang/libc> |
| memchr | 2.8.3 | `Unlicense OR MIT` | <https://github.com/BurntSushi/memchr> |
| proc-macro2 | 1.0.107 | `MIT OR Apache-2.0` | <https://github.com/dtolnay/proc-macro2> |
| quote | 1.0.47 | `MIT OR Apache-2.0` | <https://github.com/dtolnay/quote> |
| serde | 1.0.229 | `MIT OR Apache-2.0` | <https://github.com/serde-rs/serde> |
| serde_core | 1.0.229 | `MIT OR Apache-2.0` | <https://github.com/serde-rs/serde> |
| serde_derive | 1.0.229 | `MIT OR Apache-2.0` | <https://github.com/serde-rs/serde> |
| serde_json | 1.0.151 | `MIT OR Apache-2.0` | <https://github.com/serde-rs/json> |
| sha2 | 0.10.9 | `MIT OR Apache-2.0` | <https://github.com/RustCrypto/hashes> |
| subtle | 2.6.1 | `BSD-3-Clause` | <https://github.com/dalek-cryptography/subtle> |
| syn | 3.0.3 | `MIT OR Apache-2.0` | <https://github.com/dtolnay/syn> |
| typenum | 1.20.1 | `MIT OR Apache-2.0` | <https://github.com/paholg/typenum> |
| unicode-ident | 1.0.24 | `(MIT OR Apache-2.0) AND Unicode-3.0` | <https://github.com/dtolnay/unicode-ident> |
| version_check | 0.9.5 | `MIT/Apache-2.0` | <https://github.com/SergioBenitez/version_check> |
| windows-link | 0.2.1 | `MIT OR Apache-2.0` | <https://github.com/microsoft/windows-rs> |
| windows-sys | 0.61.2 | `MIT OR Apache-2.0` | <https://github.com/microsoft/windows-rs> |
| zmij | 1.0.23 | `MIT` | <https://github.com/dtolnay/zmij> |

下列许可证文件均从锁定版本的 crate 源码逐字节复制。仅当许可证条款一致时
复用通用文本；包含特定归属声明或附加条款的文件会单独保留：

- `THIRD_PARTY_LICENSES/rust-base64-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-base64-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-block-buffer-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-block-buffer-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-cfg-if-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-common-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-common-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-cpufeatures-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-crypto-common-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-digest-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-generic-array-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-hkdf-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-hkdf-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-humantime-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-libc-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-memchr-COPYING`
- `THIRD_PARTY_LICENSES/rust-memchr-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-memchr-UNLICENSE`
- `THIRD_PARTY_LICENSES/rust-sha2-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-subtle-LICENSE`
- `THIRD_PARTY_LICENSES/rust-typenum-LICENSE-APACHE`
- `THIRD_PARTY_LICENSES/rust-typenum-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-unicode-ident-LICENSE-UNICODE`
- `THIRD_PARTY_LICENSES/rust-version_check-LICENSE-MIT`
- `THIRD_PARTY_LICENSES/rust-windows-rs-LICENSE-MIT`

---

## 如何补充遗漏的声明

如果你发现仓库中存在未列入本文件的第三方资源，欢迎提交 issue 或 PR 更新
本文件。
