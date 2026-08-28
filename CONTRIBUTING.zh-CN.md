# 为 Motrix 做贡献

[English](CONTRIBUTING.md) | 简体中文

感谢你参与 Motrix 项目。代码、测试、文档、翻译、Issue 反馈和设计建议都能帮助项目持续改进。

参与项目即表示你同意遵守[行为准则](CODE_OF_CONDUCT.zh-CN.md)。如需报告疑似安全漏洞，请按照[安全策略](SECURITY.zh-CN.md)私密提交；切勿在公开 Issue、Discussion 或 Pull Request 中披露漏洞信息。

## 选择合适的沟通渠道

- 创建反馈前，请先搜索[现有及已关闭的 Issue](https://github.com/agalwood/Motrix/issues?q=is%3Aissue)。
- 使用项目的 [Issue 表单](https://github.com/agalwood/Motrix/issues/new/choose)反馈可复现的问题或明确的功能建议。
- 使用 [GitHub Discussions](https://github.com/agalwood/Motrix/discussions)咨询使用问题、获取帮助，或讨论尚未成熟到可以创建 Issue 的想法。
- 在投入实现之前，请先讨论重要功能、架构调整、新增依赖和破坏性变更。
- 每个 Issue 和 Pull Request 应只处理一个明确的问题或功能点。

## 准备开发环境

开发需要 Git、Node.js 22 或更高版本，以及 `package.json` 中 `packageManager` 字段指定的 pnpm 版本。

如果你没有仓库写入权限，请先 Fork 仓库，再克隆自己的 Fork 并安装依赖：

```bash
git clone https://github.com/<your-account>/Motrix.git
cd Motrix
pnpm install
pnpm start
```

默认情况下，`pnpm start` 会使用常规 Motrix 配置目录旁独立的用户数据目录（通常为 `Motrix-dev`），避免开发过程修改已安装应用的数据。如需使用其他目录，请在运行 `pnpm start` 前将 `MOTRIX_USER_DATA` 设为该目录的绝对路径。

请从最新的 `main` 创建开发分支，并将 Pull Request 提交到 `main`。`master` 仅保留旧版 v1 代码，已经冻结；请勿向该分支提交新改动。

分支名称使用 `<type>/<snake_case_topic>_<YYYYMMDD>` 格式。如果存在对应 Issue，可以在主题前加入 Issue 编号，例如 `fix/1970_conduct_links_20260826`。

## 了解项目架构

Motrix Turbo 采用宿主无关的产品核心，并在其外部提供两种应用宿主：Electron 桌面应用和 Node/Web 服务端。两种运行方式共用同一套渲染层。这样的分层可以复用产品行为，避免 Electron 相关逻辑渗透到服务端，并允许下载引擎在稳定的适配器之后独立替换。

### 各层职责

| 目录 | 职责 | 依赖边界 |
| --- | --- | --- |
| `src/renderer/` | Electron 与浏览器共用的渲染层 | 只导入 `@shared/` 和渲染层内部模块；通过 `@renderer/lib/transport` 访问产品能力。 |
| `src/preload/` | 受限的 Electron 上下文桥接层 | 使用 Electron，以及 `src/shared/` 中的纯协议值或类型；不承载产品行为。 |
| `src/main/` | Electron 宿主、IPC、窗口、菜单和操作系统集成 | 可以组合 `src/core/`、`src/shared/` 和 Electron 专用适配器。 |
| `src/server/` | Node/Docker 宿主、HTTP/WebSocket 端点和服务端平台集成 | 可以组合 `src/core/`、`src/shared/` 和服务端库；不得导入 Electron 或 `src/main/`。 |
| `src/core/` | 宿主无关的应用服务、领域行为、引擎编排和插件策略 | 可以使用 `src/shared/` 和宿主无关的库；不得导入任一应用宿主。 |
| `src/shared/` | 跨层 Schema、协议常量、类型、语言数据和纯工具函数 | 不得执行 I/O，不得使用定时器、网络、Electron API 或 Node.js 专用 API。 |
| `packages/native-host/` | 用于浏览器扩展配对的独立 Rust 原生消息宿主 | 通过已发布的桥接契约通信，不依赖系统 Node.js 或 Electron。 |
| `src/test-utils/` | 仅供测试使用的 Fixture 和辅助工具 | 生产代码不得导入此目录。 |

### 传输与协议流向

渲染层在两种宿主中使用同一套命令、查询和事件契约：

```text
Electron: renderer -> ElectronTransport -> preload -> main IPC -> core
Browser:  renderer -> HttpWsTransport -> server RPC/events -> core
```

渲染层中的功能代码必须使用 `@renderer/lib/transport`；只有 `ElectronTransport` 和范围严格受限的平台适配器可以直接访问 `window.motrix`。通道名称和载荷契约属于 `src/shared/protocol/`。请使用 `Commands`、`Queries`、`Events` 及其 `Bridge*` 对应项，不要使用原始通道字符串。

### 引擎、桥接与插件边界

- 产品层代码面向 `src/core/engine/engine-adapter.ts` 中的 `EngineAdapter`。aria2 RPC 类型和转换逻辑必须保留在具体的 aria2 适配器内部；引擎生命周期仅由 `EngineSupervisor` 负责。
- MDXP 通过 HTTP 和 WebSocket 使用 JSON-RPC 2.0。`@motrix/mdxp` 软件包是线协议 Schema、方法常量、错误码和连接行为的唯一事实来源；不要在本仓库中重复定义这些契约。
- 宿主无关的插件状态、策略、安装、能力和沙箱编排属于 `src/core/plugin/`。Electron 与 Node/Docker 的装配分别属于 `src/main/plugin/` 和 `src/server/plugin/`。
- 插件代码在独立的 QuickJS Worker 中运行，只能通过类型化的能力桥访问宿主能力。新增宿主专用能力时，必须在两种能力宿主中完成实现和测试。

修改导入关系或分层职责后，请运行 `pnpm run check:boundaries`。自动化检查只是基线，不能替代对上述依赖方向的人工审查。

## 遵循实现规范

### 代码与文件

- 代码、注释、标识符、文件名、提交信息和 Pull Request 标题使用英文。
- JavaScript、TypeScript、TSX 和样式文件使用 `kebab-case` 命名。
- 仅用于类型的导入使用 `import type`，Node.js 内置模块使用 `node:` 前缀。
- 优先使用已配置的路径别名，不要使用层级过深的相对导入；同时需要确认目标运行环境支持该别名。
- 行为发生变化时，请添加或更新测试。生产代码不得依赖测试辅助工具或生成的构建产物。

### 用户可见文本与文档

- 所有用户可见的应用及操作端文本都必须通过现有 i18next 资源进行本地化；不要硬编码界面字符串。
- 新增或修改翻译键时，需要更新所有已注册语言，并保持各语言中的占位符集合完全一致。
- 修改中英文文档对中的任一文件时，应在同一改动中更新另一份。标题、命令、路径和示例需要保持一致，正文则应使用符合各自语言习惯的表达。
- 不要提交凭证、私有地址、个人路径、私密计划、本地生成状态或无关改动。

### 提交信息

使用 Conventional Commits 格式：

```text
<type>(<optional-scope>): <imperative summary>
```

允许的类型包括 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`chore`、`ci` 和 `style`。摘要使用小写开头的英文祈使短语，不加句号，并控制在 72 个字符以内。如果改动理由不直观，请补充正文；如有破坏性变更，请添加 `BREAKING CHANGE:` 尾注。

## 验证改动

每次提交前都需要运行以下必要检查：

```bash
pnpm run check:boundaries
pnpm run lint
pnpm exec tsc --noEmit
```

还需要根据改动内容运行对应检查：

- 行为或逻辑：运行相关 Vitest 测试；涉及多个模块时运行 `pnpm test`；
- 已有浏览器或 Electron 用户流程：运行 `pnpm test:e2e`；
- 语言资源或国际化行为：运行 `pnpm run check:i18n`；
- 新增或重命名文件：运行 `pnpm run check:file-names`；
- 插件 Manifest 契约：运行 `pnpm run check:schema-parity`；
- 依赖、捆绑资源或许可证元数据：运行 `pnpm run check:third-party-notices`；
- 原生消息宿主的 Rust 代码：运行下方的格式检查、Lint 和测试命令。

修改原生消息宿主的 Rust 代码时，请运行：

```bash
cargo fmt --manifest-path packages/native-host/Cargo.toml --all -- --check
cargo clippy --manifest-path packages/native-host/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path packages/native-host/Cargo.toml --locked --all-targets
```

提交前请审查最终差异，运行 `git diff --check`，并在 Pull Request 中记录准确的命令和结果。不要隐藏失败，也不要丢弃命令的退出状态。

## 提交 Pull Request

- 目标分支使用 `main`，关联对应 Issue，并说明问题以及选择当前方案的原因。
- 完整填写 Pull Request 模板，包括准确的验证命令、环境和结果。
- 可见界面发生变化时，请提供截图或录屏。
- 生成文件和依赖改动应仅限于当前 Pull Request 所需范围。
- 使用后续 Commit 响应评审意见；维护者通常会在合并功能 Pull Request 时采用压缩合并（squash merge）。

贡献内容按照项目的 [MIT License](LICENSE) 接受。第三方资源可能适用其他条款，详情请参阅 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
