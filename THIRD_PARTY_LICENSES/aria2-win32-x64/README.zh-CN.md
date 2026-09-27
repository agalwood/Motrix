# aria2 Windows x64 组件声明

本目录仅适用于 Motrix 随附的 Windows x64 aria2 引擎 `1.37.0-motrix.16`，源码对应 [`motrixapp/aria2` 提交 `e093973f113f0a880f9757a2ad0258cb2356295e`](https://github.com/motrixapp/aria2/tree/e093973f113f0a880f9757a2ad0258cb2356295e)。下表列出本次整理的组件，不代表其他平台构建使用相同依赖。

[官方发布页](https://github.com/motrixapp/aria2/releases/tag/v1.37.0-motrix.16)提供 Windows 压缩包 `aria2c-1.37.0-motrix.16-win32-x64.zip`。[components.json](components.json) 记录压缩包及可执行文件的 SHA-256、精确源码提交、许可文本摘要、源码压缩包地址及摘要，以及 libssh2 补丁。

| 组件 | 上游版本 | 声明的许可证或状态 | 随附文本 | 官方来源 |
| --- | --- | --- | --- | --- |
| c-ares | 1.34.8 | MIT | [c-ares-LICENSE.md](c-ares-LICENSE.md) | [精确来源](https://github.com/c-ares/c-ares/blob/c7a3138dcfe3bb0eaaf10c0c24c36dc66dc790ab/LICENSE.md) |
| Expat | 2.8.3 | MIT | [expat-COPYING](expat-COPYING) | [精确来源](https://github.com/libexpat/libexpat/blob/92810461043fce37e70079b37ab1f04490a8f039/expat/COPYING) |
| libssh2 | 1.11.1 | BSD-3-Clause | [libssh2-COPYING](libssh2-COPYING) | [精确来源](https://github.com/libssh2/libssh2/blob/a312b43325e3383c865a87bb1d26cb52e3292641/COPYING) |
| OpenSSL | 3.5.8 | Apache-2.0 | [openssl-LICENSE.txt](openssl-LICENSE.txt) | [精确来源](https://github.com/openssl/openssl/blob/f4dc4d58b48d346a8270183f89acf826d459b0ca/LICENSE.txt) |
| SQLite | 3.53.4 | NOASSERTION；上游公有领域声明 | [sqlite-LICENSE.md](sqlite-LICENSE.md), [sqlite-main.c-public-domain.txt](sqlite-main.c-public-domain.txt) | [精确来源](https://github.com/sqlite/sqlite/blob/b09c88c14082339b66c7b7158d609a771e64ca69/LICENSE.md) |
| wslay | 1.1.1 | MIT | [wslay-COPYING](wslay-COPYING) | [精确来源](https://github.com/motrixapp/aria2/blob/e093973f113f0a880f9757a2ad0258cb2356295e/deps/wslay/COPYING) |
| zlib | 1.3.2 | Zlib | [zlib-LICENSE](zlib-LICENSE) | [精确来源](https://github.com/madler/zlib/blob/da607da739fa6047df13e66a2af6b8bec7c2a498/LICENSE) |

上表许可文本均原样复制自标明的官方 Git 源文件。其中 `sqlite-main.c-public-domain.txt` 是 SQLite [`src/main.c`](https://github.com/sqlite/sqlite/blob/b09c88c14082339b66c7b7158d609a771e64ca69/src/main.c#L1) 第 1–16 行完整开头注释的逐字节摘录；`components.json` 记录了摘录范围及原始完整源文件的摘要。随附的 SQLite `LICENSE.md` 将包括 `sqlite3.c` 和 `sqlite3.h` 在内的核心实现声明为公有领域。此处以 `NOASSERTION` 表示未为该声明指定 SPDX 许可证表达式，不替代上游声明。

libssh2 保留上游版本号 1.11.1。本引擎应用了 aria2 固定提交中的三份补丁：[CVE-2026-55199](https://github.com/motrixapp/aria2/blob/e093973f113f0a880f9757a2ad0258cb2356295e/patches/libssh2-1.11.1-cve-2026-55199.patch)、[CVE-2026-55200](https://github.com/motrixapp/aria2/blob/e093973f113f0a880f9757a2ad0258cb2356295e/patches/libssh2-1.11.1-cve-2026-55200.patch) 和 [security rollup](https://github.com/motrixapp/aria2/blob/e093973f113f0a880f9757a2ad0258cb2356295e/patches/libssh2-1.11.1-security-rollup-2026.patch)。补丁路径及 SHA-256 在 `components.json` 中单独记录。wslay 版本取自[随源码保存的 configure.ac](https://github.com/motrixapp/aria2/blob/e093973f113f0a880f9757a2ad0258cb2356295e/deps/wslay/configure.ac#L24)，其精确内容由 aria2 提交标识。

[Windows 构建脚本](https://github.com/motrixapp/aria2/blob/e093973f113f0a880f9757a2ad0258cb2356295e/Dockerfile.mingw)、[构建配置](https://github.com/motrixapp/aria2/blob/e093973f113f0a880f9757a2ad0258cb2356295e/mingw-config)、[依赖版本与摘要](https://github.com/motrixapp/aria2/blob/e093973f113f0a880f9757a2ad0258cb2356295e/scripts/ci/deps.env)和[发布构建任务](https://github.com/motrixapp/aria2/actions/runs/35833737683/job/107092178635)提供本清单的构建来源依据。GMP 虽被下载和构建，但 aria2 的实际配置为 `LibGmp: no`，因此未列入本目录。源码压缩包摘要用于标识构建输入；本目录许可文本取自精确的官方 Git 源文件，尚未与这些压缩包内的文本逐字节比较。

本目录是限定范围的组件声明集合，不是完整运行库 SBOM。编译器运行库及其他内嵌源码组件仍需另行盘点，也不能据此认定对应源码提供工作或可重复构建验证已经完成。

aria2 声明采用 GPL-2.0-or-later。其历史 [`LICENSE.OpenSSL`](https://github.com/motrixapp/aria2/blob/e093973f113f0a880f9757a2ad0258cb2356295e/LICENSE.OpenSSL) 包含旧 OpenSSL/SSLeay 条款，不能替代 OpenSSL 3.5.8 对应的 Apache-2.0 文本。本目录不判断应采用的 GPL 版本、链接例外的适用范围或许可证兼容性。
