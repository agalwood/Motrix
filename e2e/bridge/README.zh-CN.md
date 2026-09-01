# Bridge E2E — `motrix-cli` ↔ Electron / Server

本目录提供 **MDXP bridge** 的端到端验收测试，由真实的
[`motrix` CLI](https://github.com/motrixapp/cli)（已发布的 `@motrix/cli` npm 包，
此处作为 devDependency 消费）驱动，覆盖
产品承诺的两段核心能力：**device-code pairing** 与 **download invocation**，并同时验证两种 runtime shell：

| 链路 | 文件 | Runner | 被测 shell |
|------|------|--------|-----------|
| Electron | [`cli-pair-and-download.spec.ts`](./cli-pair-and-download.spec.ts) | Playwright | 打包后的 Electron app（`dist/main/index.cjs`） |
| Server | [`server-leg.mjs`](./server-leg.mjs) | standalone `node` | headless Node shell（`dist/server/index.mjs`） |

两条链路都会驱动**真实 CLI binary** 和**真实 `aria2`** 下载（使用本地、限速、确定性的 HTTP fixture，不访问公网），并断言完整流程：
pair → approve → token → `download/add` → `completed` → 落盘字节 →
`watch` SSE。测试还包含对抗性探针：错误 token → exit 4、token 仅交付一次、deny，以及
Server 链路上的 Spec 9 self-approval-bypass。

> **为什么要拆成两种形式？** Electron app 与 Node server 需要
> **相反的 `better-sqlite3` native ABI**，不能共用同一份 `node_modules`。
> Electron 链路放在标准 Playwright suite 中；Server 链路则是一个独立的
> `.mjs` driver，运行在单独的 **node-ABI build**（一个 git worktree）上。

---

## 前置条件

- 主 checkout 中至少运行过一次 `pnpm install`。
- **`aria2`**：默认会自动使用 `extra/<platform>/<arch>/aria2c` 中的 bundled binary
  （macOS/arm64 不需要额外配置）。如需使用系统 `aria2c`，可通过
  `MOTRIX_ARIA2_BIN` 覆盖。
- `@motrix/cli` CLI：由 `pnpm install` 自动安装（它是 devDependency）。E2E 从
  `node_modules` 解析其打包后的 bin —— 不再有 in-tree 构建 CLI 的步骤。

---

## Electron 链路（Playwright）

主 checkout 必须携带 **Electron** 版本的 `better-sqlite3` ABI（这是
`pnpm install` / `pnpm start` 后的默认状态）。如果你之前在这个 checkout 中运行过
`pnpm start:server`，请先恢复：

```bash
pnpm run rebuild:for-electron
```

构建并运行：

```bash
pnpm build:electron                       # dist/{main,preload,renderer,worker}
pnpm exec playwright test e2e/bridge/cli-pair-and-download.spec.ts
```

说明：

- 这个 spec 会在每个 test 中启动**真实** Electron app，并通过
  `window.motrix.invoke('bridge:resolvePair', …)` approve pairing；这正是
  PendingApprovalsSection 中 "Approve" 按钮调用的 IPC。
- 运行期间 Electron 会打开 **headed** window。在桌面 macOS session 中可以直接运行；
  Linux CI 中请使用 `xvfb-run`。
- `pnpm test:e2e`（完整 suite）也会通过 `*.spec.ts` glob 自动包含这个 spec。

---

## Server 链路（standalone driver）

### 一次性准备：在相邻 worktree 中构建 node-ABI server

这样可以让主 checkout 保持 Electron ABI，而 worktree 持有 Node ABI。

```bash
git worktree add --detach ../motrix-turbo-srv HEAD
cd ../motrix-turbo-srv
MOTRIX_SKIP_ELECTRON_REBUILD=1 pnpm --config.dangerouslyAllowAllBuilds=true install
pnpm build:server                         # dist/server + dist/renderer-web
cd -
```

`--config.dangerouslyAllowAllBuilds=true` 会允许 install 运行 `better-sqlite3`
自己的 Node build script（→ Node ABI），同时满足 pnpm 11 的 deps-check，避免
`build:server` 静默重新 install 并把 ABI 切回去。`MOTRIX_SKIP_ELECTRON_REBUILD=1`
会跳过 `postinstall` 中的 Electron rebuild。

### 运行（可反复执行）

```bash
node e2e/bridge/server-leg.mjs
```

退出码：`0` = 全部检查通过，`1` = 某项检查失败，`2` = server build 缺失
（需要重新构建 worktree）。

---

## 远程浏览器 Extension 链路（Chromium + Firefox）

该门禁会把真实 Server MBP1 runtime 放在本地 HTTPS/WSS 反向代理之后，并在两个
浏览器中驱动生产 Extension 构建。测试分别经过 `/bridge` 代理前缀和代理根路径，
覆盖 fresh pair、按 authority 隔离的 consent、敏感 header/Cookie 剥离、浏览器重启
重连、Server 重启重连、durable revoke 和 re-pair。独立 Chromium 场景还会在同一
持久 profile 中保留两个 Server 的配对，证明 consent 不会跨 Server 泄漏，且提交始终
跟随当前选中的 authority。Firefox 还必须断言无 NM ticket 的远程身份保持为
`unverified`。

先在 Extension checkout 构建两个产物，再从 Motrix 运行：

```bash
pnpm --filter @motrix/extension build:chromium
pnpm --filter @motrix/extension build:firefox

MOTRIX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/chromium \
MOTRIX_FIREFOX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/firefox \
pnpm test:e2e:remote-extension
```

Playwright 启动前，该命令会先验证 `remote-extension-threat-evidence.json`：
T01–T29 每项威胁都必须继续绑定至少一个双仓测试文件和测试标题。Extension checkout
默认从 `MOTRIX_EXTENSION_BUILD` 推导；只有构建产物不在 checkout 内时才需要显式设置
`MOTRIX_EXTENSION_REPO`。删除或重命名测试、缺少威胁 ID、不安全路径或符号链接证据都会
使门禁失败。

可用 `MOTRIX_CHROMIUM_EXECUTABLE` 与 `MOTRIX_FIREFOX_EXECUTABLE` 覆盖浏览器路径。
Firefox runner 使用 WebDriver BiDi 标准临时扩展安装命令。证书绕过仅存在于本地
测试 profile；独立 WSS integration suite 会在不绕过验证的情况下证明受信 CA
成功，以及 unknown CA、过期证书和 hostname mismatch 必须失败。
Chromium 应使用与 Playwright 匹配的 Chrome-for-Testing/Chromium 构建。部分正式版
Google Chrome 会忽略自动加载 unpacked Extension 的参数，最终超时等待 service worker；
即便显式设置可执行文件，也必须指向支持该测试模式的浏览器构建。

### 固定双仓兼容版本

浏览器 harness 是跨仓协议契约。两端实现改动提交之前，不得把当前 working tree 的
旧 `HEAD` 写成兼容证据。先分别创建 Extension 与 Motrix 实现提交，再把
`remote-extension-compatibility.example.json` 复制为
`remote-extension-compatibility.json`，并将两个占位符替换为对应实现提交的完整
40 位小写 SHA。然后在 Motrix 仓库执行：

```bash
pnpm check:remote-extension-compatibility \
  --manifest e2e/bridge/remote-extension-compatibility.json \
  --motrix-repo . \
  --extension-repo /absolute/path/to/motrix-extension
```

验证器会拒绝占位符、短 SHA、大写 SHA、协议漂移、少于五个浏览器场景、来自错误仓库
的提交，以及不是对应 checkout 当前 `HEAD` 祖先的提交。验证通过后，用一个更晚的
Motrix 提交记录该清单；这样既避免 Motrix SHA 自引用，也能让审阅者精确复现兼容组合。

### Beta soak

Soak runner 会重复执行同一套带威胁前置门禁的五场景测试；任意一次失败都会令命令失败。
默认执行 20 轮、共 100 个浏览器场景，并限制最多 100 轮，避免环境配置错误产生无界任务：

```bash
MOTRIX_CHROMIUM_EXECUTABLE=/path/to/chrome-for-testing \
MOTRIX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/chromium \
MOTRIX_FIREFOX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/firefox \
MOTRIX_REMOTE_EXTENSION_SOAK_REPEATS=20 \
pnpm test:e2e:remote-extension:soak
```

必须归档完整输出，以及 OS、浏览器版本、两端实现 SHA、轮数、起止时间和所有代理/网络
故障注入记录。一次普通 E2E 全绿只是回归证据，不能代替 beta soak 门禁。

固定兼容 SHA 清单提交后，发布门禁必须改用自动生成证据的包装命令：

```bash
MOTRIX_CHROMIUM_EXECUTABLE=/path/to/chrome-for-testing \
MOTRIX_FIREFOX_EXECUTABLE=/path/to/firefox \
MOTRIX_EXTENSION_REPO=/absolute/path/to/motrix-extension \
MOTRIX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/chromium \
MOTRIX_FIREFOX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/firefox \
MOTRIX_REMOTE_EXTENSION_SOAK_EVIDENCE_DIR=/absolute/archive/remote-extension-soak \
MOTRIX_REMOTE_EXTENSION_SOAK_FAULTS=none \
pnpm test:e2e:remote-extension:release-soak
```

发布模式强制恰好 20 轮、两个仓库均干净、Extension `HEAD` 与固定 SHA 完全一致，且
Motrix 实现 SHA 之后只能新增兼容清单。源码预检通过后，它会从固定 Extension checkout
重新构建两个浏览器版本，拒绝仓库外或符号链接构建目录，并计算新产物哈希。它会记录显式
浏览器版本与 OS 信息，生成 `evidence.json` 和完整的 Playwright
`playwright-report.json`；报告必须能解析出恰好 100 个通过场景，且不得包含顶层或场景
错误。浏览器失败会归档为 failed；即使进程返回 0，只要 JSON 报告缺失或无效也会归档为
incomplete 并使门禁失败。证据目录必须是新目录，后续运行不能覆盖先前记录。

## Server 链路维护

### 环境变量覆盖（全部可选）

| 变量 | 默认值 | 含义 |
|------|--------|------|
| `MOTRIX_SERVER_DIR` | `../motrix-turbo-srv` | node-ABI build 目录 |
| `MOTRIX_E2E_WEB_PORT` | `8090` | web / operator control-plane 端口 |
| `MOTRIX_E2E_MDXP_PORT` | `16801` | MDXP bridge 端口 |
| `MOTRIX_ARIA2_BIN` | bundled | `aria2c` binary |

### 拉取新代码后刷新 worktree

```bash
cd ../motrix-turbo-srv
git fetch && git checkout --detach origin/main      # 或被测 branch
pnpm build:server                                   # 如果 deps 变化，重新运行上面的 install
cd -
```

### 清理

```bash
git worktree remove --force ../motrix-turbo-srv
```

---

## 注意事项

- **CLI auto-discovery 在 darwin 上是 hardcoded**：
  `~/Library/Application Support/Motrix/bridge/endpoint.json`。它只能找到
  **Electron** bridge，永远不会找到 server。因此 Server 链路始终显式传入
  `--endpoint http://127.0.0.1:<mdxp-port> --token <localToken>`。
- **Pairing approval 是刻意保留的人工步骤**（没有 headless auto-approve）。
  测试驱动的是*真实* approval surface：Electron 上的 `bridge:resolvePair` IPC，
  以及 Server 上由 operator gate 保护的 `POST /rpc/command/bridge:resolvePair`。
- `remote-extension-wss.spec.ts` 与
  `remote-extension-firefox-wss.spec.ts` 是当前启用的 browser-extension WSS
  生命周期门禁。旧的 `pair-and-submit`、`receiver-direct`、`revoke` 仍是窄范围
  placeholder，不能作为覆盖证据。
