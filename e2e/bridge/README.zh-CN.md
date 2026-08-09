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
- 这里的其他 specs，包括 `pair-and-submit`、`receiver-direct`、`revoke`，都是
  **browser-extension WebSocket** pairing path 的 `test.skip` stub（暂缓实现），
  与当前 CLI **HTTP** path 是两条不同路径。
