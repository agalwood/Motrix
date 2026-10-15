# Issue #28：启动等待与任务 RPC 超时

## 已确认的代码问题

`service-worker.ts` 的 `endpointLifecycleReady` 同时用于 MessageBus、右键下载和自动接管入口。原来的调用链是：

```text
消息 → beforeDispatch → endpointLifecycleReady
     → 删除废弃 token → 恢复 endpoint 清理 → await manager.autostart()
                                             → discovery / MBP1 / initialize
```

因此网络连接慢会阻塞 `bg.getState`、设置读取和 `bg.mediaDetected` 等不需要连接的消息。原来的 catch 还会把 autostart 的意外异常误报为存储恢复失败，让该次 worker 生命周期中的后续消息全部返回 `background startup unavailable`。

本次改为：共享屏障只等待两个必要的持久化步骤；成功后单独启动、观察 autostart。存储清理失败仍禁止连接和消息处理，连接异常不再污染存储就绪状态。MV3 事件监听仍同步注册；没有缩短认证时限、绕过清理或增加自动配对。

## 复现和回归

使用当前项目的真实 service-worker 入口、MessageBus 和处理器，在浏览器 API 边界提供替身，以假时钟模拟连接延迟。这里的 30 秒是可控故障注入，不是对报告者电脑的实测。

- 修改前：令 autostart 在 30 秒后完成，状态/设置请求在前 30 秒无回复，完成后才回复；令它拒绝，状态请求永久报启动失败。两项回归断言在旧实现上失败。
- 修改后：连接仍在等待时，状态和设置立即回复；即使 autostart 永不完成，content 媒体上报可入库，扫描在自身 75ms 收集窗口后返回。
- 单独延迟 token 删除和 endpoint 清理：监听器已经注册，但消息与 autostart 都等待两步完成。任一步失败仍保持关闭。
- 使用真实 ConnectionManager 加模拟认证传输，让 initialize 等待 30 秒仍未完成：后台生命周期队列仍能读取，完成握手后正常进入 connected。
- RPC 回归覆盖 15 秒请求、2 秒探活、8 秒重连、5 秒重试，总预算 30 秒；没有无限重试。

相关测试：

```sh
node node_modules/vitest/vitest.mjs run \
  src/background/__tests__/service-worker-startup.test.ts \
  src/background/__tests__/storage-migrations.test.ts \
  src/background/__tests__/ConnectionManager.mbp1.test.ts \
  src/background/__tests__/RpcRecovery.test.ts \
  src/background/__tests__/MessageBus.test.ts \
  src/popup/__tests__/usePopupState.test.ts \
  src/popup/__tests__/useControlPanel.test.ts \
  src/content/__tests__/ContentRuntime.test.ts
```

验证结果（2026-09-26）：新增 8 项回归全部通过；全量测试及因 sandbox 禁止监听 loopback 而单独重跑的 E2E 合计 2273 项通过、1 项失败。剩余失败为 `src/options/__tests__/App.test.tsx:87` 对任务面板开关不存在的断言，在未修改的 HEAD `55ba4dd` 上同样失败。两套 TypeScript 检查、改动文件 Biome、导入约定、Chromium / Firefox / Web Store 构建及产物验证均通过。

工作区同期有未完成的国际化修改，曾因缺少新增 locale JSON 阻止套件加载。因此完整验证使用 HEAD 加本次六个源码/测试文件的隔离副本，没有回退或覆盖其他修改；启动入口、存储恢复和 MessageBus 的定向测试也已直接在工作区运行。

## 截图能说明什么

[Issue #28](https://github.com/motrixapp/motrix-extension/issues/28) 没有日志或版本信息，只有扩展 ID 和两张截图。第一张已经显示绿色连接状态及“正在加载任务”；第二张明确显示“Motrix 响应超时，正在检查连接”。这说明至少有一次已经通过连接初始化，等待发生在任务 RPC 阶段，不能把这两张图全部归因于启动屏障。

`usePopupState` 的首次后台快照决定 loading；之后每秒刷新。`useControlPanel` 在 connected 后并行读取任务、统计和引擎状态，任务结果可独立显示。引擎的 30 秒轮询间隔不是首次读取延迟。`RpcRecovery` 的默认上限才是另一条约 30 秒路径：15s + 2s + 8s + 5s。自动连接的 initialize 另有 90 秒上限，本次保持不变。

content 入口立即 attach 监听器，没有等待 `bootstrap()` 的 announce 回复；sniffer 上报经过 MessageBus，会受旧屏障影响。扫描在已有连接时还会刷新后端 capabilities，这一步仍需要 Motrix 响应；不应把后端真实不可用显示成可下载。

新建标签页本身不会固定等待 30 秒。Chrome 的 30 秒是 worker 的空闲回收阈值，事件可以唤醒它；若已有 worker 活着，也不会重新执行模块启动。[Chrome 官方生命周期文档](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

## 环境因素的优先排查

该报告者在 [Issue #23](https://github.com/motrixapp/motrix-extension/issues/23) 提到 Microsoft Edge、Motrix 2.0.0、手改扩展 v0.1.10，以及 v0.1.11 再次打开连接失败。这些是历史信息，不能视为 #28 的当前版本。多次报错本身也不能证明系统配置有问题。

| 假设 | 区分证据与对照方式 |
| --- | --- |
| Motrix bridge / 下载引擎 RPC 卡住，或睡眠唤醒后留下失效连接 | 优先检查：截图已连上但 RPC 超时。记录超时方法、请求时长、连接 generation；比较 Motrix 自身任务列表是否同时卡住，以及重新连接/重启 Motrix 后是否消失。 |
| 旧版或手改扩展、重复安装导致实际运行代码/身份不同 | 记录当前扩展版本、ID、安装渠道、Motrix 与 Edge 版本。在新建的独立 Edge 配置中只装官方同版本扩展并正常配对，对照原配置；不要先清空原配置和配对记录。 |
| 代理/PAC/VPN、本机安全软件影响 loopback HTTP 或 WebSocket | 运行现有连接诊断，区分 discovery 是否可达与认证后 RPC 是否响应。仅在允许的范围做单变量对照，检查 127.0.0.1 的代理排除和阻断日志；普通网页可访问不能证明 loopback 通道正常。 |
| 扩展站点访问权限或企业策略 | 查看 loopback 权限、受限站点、`edge://policy`。页面嗅探受限与已连接后的 task/list 超时不是同一层问题。 |
| Native Messaging 注册或扩展 allowlist 不一致 | 现有诊断区分 host 不存在、权限拒绝、4 秒超时。普通 autostart 使用已存凭据并且 `allowLaunch:false`，本地重连路径不依赖启动 Motrix 的 native host；其默认 20 秒超时不能直接解释截图中已连接后的 RPC 等待。 |
| 节能、休眠、内存压力改变复现频率 | 比较浏览器冷启动、系统睡眠恢复、空闲后打开与连续打开标签页。Edge sleeping tabs 针对闲置后台标签页，不能据此推断它会强制扩展等待 30 秒；DevTools 也可能影响 worker 存活，计时对照应先关闭后台检查窗口。 |
| 浏览器存储异常 | 如果后台直接返回 startup unavailable，查存储删除/清理失败，而不是调整网络超时。持久化恢复未完成时必须继续阻止凭据相关操作。 |

Edge 标签休眠行为的依据：[Microsoft SleepingTabsEnabled](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/SleepingTabsEnabled)。表中的其他环境因素是待验证假设，不是已确认根因。

建议下一次现场复现保存：从打开 popup 到第一次 `bg.getState`、`motrix/initialize`、`task/list` / `stats/get` 回复的时间，以及设置 → 帮助中的连接诊断结果。诊断会开启 debug 日志；复现后恢复日志级别。分享前删去配对码、凭据、任务 URL 和文件路径。本次没有读取或更改用户的代理、安全软件、系统设置和真实配对资料。
