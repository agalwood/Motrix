# 下载接管的 MDXP 模拟验收

下载前询问保持在扩展端。CI 使用真实浏览器和本机 MDXP 模拟服务，不安装 Motrix，不启动 aria2，不依赖人工配对、私有下载地址或云端凭据。模拟服务验证扩展发出的协议请求并独立统计接收次数和模拟任务数量；不能据此宣称 Motrix 的数据库或下载引擎已经通过测试。

## 当前实现与覆盖边界

| 层级 | 当前覆盖 | 未覆盖 |
| --- | --- | --- |
| 协议契约 | 使用锁文件中的 MDXP schema 校验 initialize 和 submit；真实 WebSocket；同 key 重连去重、不同 key 独立、参数冲突和断线故障 | 模拟器不是生产服务端，账本是内存模型，没有实现新 prepare commit 协议 |
| Firefox 浏览器集成 | 真实 Firefox，生产拦截模块、确认服务和确认动作、WebSocketClient、MDXP 连接；本地 HTTP 请求记录；22 个场景 | 入口是 fixture 页面；按钮决定由驱动发出，没有加载完整 popup；ConnectionManager、MBP1、原生宿主不在该路径内 |
| 传输集成 | 现有 transport E2E 覆盖 ConnectionManager 与模拟桥接服务，随全量 Vitest 运行 | 不代替真实浏览器 UI 场景 |
| 完整扩展 UI E2E | 后续接入，后端仍使用 MDXP 模拟器 | 尚未落地，不应作为本轮通过项 |

Firefox 场景包括旧入口元数据、未知大小策略、默认启用、自动接管、附件缺少 MIME、确认接受／浏览器／取消、明确拒绝、提交接受后断线、创建前断线、无效回复、延迟回复、大小规则、站点排除、总开关、早期接管开关和内联 PDF。

这组测试锁定当前候选实现，不把旧行为当成未来设计：当前提前取消路径在选择浏览器和明确失败时会重新 GET。迁移至挂起方案时，必须将这两项预期改为继续原请求，并保留取消前／后的独立断言，不能仅为了使测试变绿修改请求计数。

## 执行与证据

```sh
node --test scripts/__tests__/mdxp-simulator.test.mjs scripts/__tests__/takeover-report.test.mjs
FIREFOX_BINARY=/path/to/firefox node scripts/verify-firefox-takeover.mjs
node scripts/verify-takeover-report.mjs .cache/firefox-takeover-report/report.json
```

在存在直接启动兼容问题的 macOS 27 上使用 `FIREFOX_APP=/Applications/Firefox.app`；脚本通过 LaunchServices 打开独立实例，仍使用新建的临时 profile。Linux CI 使用 `FIREFOX_BINARY`。`TAKEOVER_REPORT_DIR` 可指定每次运行的独立证据目录，`TAKEOVER_TEMP_ROOT` 可指定临时 profile 的父目录。

报告记录实际浏览器版本、CI 检出的 SHA、安装 fixture 的 SHA-256、逐场景状态、浏览器事件、HTTP 请求和 MDXP 模拟任务数。开始时先写 running 报告，每个场景更新；断言失败保留失败场景及日志。CI 对报告再校验一次，缺失、重复、跳过、失败、错误浏览器版本和旧 SHA 都不能通过。安装包摘要对应 fixture，不是商店发布包。

## 合并门槛

保留已有必需检查名 `Extension checks`，将其改为聚合检查：静态检查、全量测试和构建，以及 Firefox 143.0／latest 两个任务都必须成功。上游 failed、cancelled、skipped 都使聚合检查失败。矩阵不采用 fail fast，不用自动重跑掩盖首次失败。

浏览器报告与日志无论成功失败均上传，保存 14 天。测试只使用合成的 loopback URL 和数据，不保存用户 Cookie、账户或生产任务。新检查在本地编辑完成后仍需提交并运行 GitHub Actions；本地成功不代表远端 CI 已通过。现有仓库保护是否启用仍以 GitHub 实际设置为准，本次不修改远端规则或绕过权限。

## 完整扩展 E2E 的下一步

真实浏览器加载实际构建产物，打开真实下载确认界面，通过界面选择文件名、目录以及三个动作。模拟入口只替换连接到后端的边界，不绕过生产确认、任务选项、错误分类和提交去重。测试注入入口只能存在于独立 E2E 构建，产物校验必须拒绝其进入商店包。

首批矩阵为 Firefox 143 与 stable、Chromium 的固定验证版本；Windows Chrome 的原生保存框另设 headed 验收任务。用独立的预期清单校验每个矩阵单元，某浏览器不支持的能力明确标记，不能静默跳过后让总检查通过。PR 跑确定性的主要场景；更广的浏览器版本和故障排列可放入后续 nightly 工作流，需实施后才能视为已有门槛。

每个场景至少独立观察四类证据：扩展 UI 状态、浏览器下载记录、模拟器提交与任务账本、HTTP 源站记录。浏览器实际完成的文件校验字节数和 SHA-256；由模拟器接受的任务只断言协议状态，绝不伪造“文件下载完成”。同 URL 多次点击必须创建不同操作；同一操作重试必须保留原 key。

## 新交接协议的故障门槛

以下为待实现协议的验收要求，不预先做成永远通过的占位测试。接口与服务端 schema 落地后，再扩展模拟器和浏览器路径。

| 注入位置 | 必须满足的结果 |
| --- | --- |
| prepare 前拒绝、超时、弹窗打不开 | 无模拟任务启动；原浏览器请求继续 |
| prepare 后选择浏览器或取消 | 撤销准备记录，迟到 commit 被拒绝；两种按钮分别对应继续和停止浏览器下载 |
| 原下载取消失败 | 不得 commit；不启动第二份下载 |
| commit 已接受但回复丢失 | UI 显示待核对；同操作查询／重试归并为一个任务；不得自动重发浏览器 GET |
| commit 与 abort 乱序 | 仅一个终态生效，不允许先撤销后被迟到消息激活 |
| 浏览器停止状态未知 | 不自动提交或重发；恢复 UI 有明确状态 |
| 扩展页面或后台重启 | 草稿和操作不会被恢复成新提交；不能恢复 Promise 控制权时必须走不确定状态 |
| 配置关闭、模式改变、后端切换 | 旧操作不得向新实例提交，也不能绕过新确认模式 |
| 同 URL 并发、重定向、POST、一次性 URL | 验证操作隔离与不可重放时的浏览器保留策略 |

故障控制器应提供命名屏障，例如 `prepared`、`browser-stopped`、`committed-before-reply`。测试等待事件后再断线或重启，使用有界等待；不通过碰运气的 sleep 制造时序。模拟器重启后保留或丢弃账本须分成不同模式，不能把模拟持久化等同于真实 Motrix 恢复能力。

协议模拟器和生产服务端还应共同运行同一套契约用例，防止模拟器自行定义出比真实服务端更强的保证。真实服务端内部持久化和 aria2 执行边界由 Motrix 仓库的测试负责，扩展 CI 不再承担桌面应用部署。

## 本机验证记录

2026 年 10 月 2 日在 macOS 27 上使用 LaunchServices 和临时 profile 验证：Firefox 157.0 与 143.0 均为 22 项通过，后端均为 MDXP 模拟器。报告分别保存在 `.cache/firefox-takeover-report/report.json` 与 `.cache/firefox-takeover-143-report/report.json`，包含实际 fixture 安装包摘要。

新增模拟器与报告校验测试 11 项通过；相关接管、MDXP 传输与 full-flow 测试 34 项通过；生产代码、浏览器 API 和 fixture 的 TypeScript 检查通过，修改文件的 Biome 检查与 CI 工作流 actionlint 检查通过。GitHub Actions 尚未在远端执行，本机结果不等同于 Linux runner 通过。

### 合并后的优化分支复验

PR #45 已于 2026-10-02 合并为 `0c119e6`。本次优化从该提交单独建立
`fix/takeover-mdxp-acceptance`，保留响应文件名解析，并补齐普通与 UTF-8
附件名的确认草稿回归用例。原候选目录及其他工作目录的修改保持不变。

在该新基线上重新验证：Firefox 157.0、143.0 各 22 项通过；全量 Vitest
185 个文件、2,744 项测试通过；Node 脚本测试 45 项、Safari 发布脚本测试
28 项通过；三组 TypeScript、Biome、导入检查、actionlint、四种构建和产物校验通过。
此记录为本机验证，远端检查以本次优化 PR 的 Actions 为准。

本次交付是故障处理和验收基础。浏览器保留原请求、prepare/commit/status/abort
协议及服务端持久账本、完整 UI 和 Chromium E2E 仍在后续范围，不能将本次通过
理解为整个事务交接方案已经完成。确认继续由扩展负责。
