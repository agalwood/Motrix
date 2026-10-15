# Firefox 157 + Motrix 本机验收记录

时间：2026-10-02T04:59:05.042Z

对象：本地 `fix/firefox-early-takeover` 候选实现，基于 `62cbb1a`，含未提交修改；不是 PR 作者当前 HEAD。

使用本机 Firefox 157.0 的临时扩展，真实 webRequest/downloads/storage API 和本地 HTTP 服务。Motrix 后端和确认按钮点击使用测试替身，确认服务与动作执行生产代码。

结果：19/19 通过。首轮 18/19；确认改用浏览器的异步完成事件晚于固定等待窗口，浏览器实际已下载完成。测试改为最多等待 5 秒确认结束和下载创建，并按 URL 隔离事件；产品实现未因此修改。

| 用例 | 提交次数 | 原生下载数 | 结果 |
| --- | ---: | ---: | --- |
| known | 1 | 1 | PASS |
| probe-only | 1 | 1 | PASS |
| confirm | 0 | 1 | PASS |
| small | 0 | 1 | PASS |
| unknown-chrome | 0 | 1 | PASS |
| unknown-motrix | 1 | 1 | PASS |
| early-default | 1 | 0 | PASS |
| early-direct | 1 | 0 | PASS |
| early-no-type | 1 | 0 | PASS |
| early-confirm-accept | 1 | 0 | PASS |
| early-confirm-browser | 0 | 1 | PASS |
| early-confirm-cancel | 0 | 0 | PASS |
| early-failed | 0 | 1 | PASS |
| early-unknown | 1 | 0 | PASS |
| early-small | 0 | 1 | PASS |
| early-excluded | 0 | 1 | PASS |
| early-off | 0 | 1 | PASS |
| early-kill | 1 | 1 | PASS |
| early-pdf | 0 | 0 | PASS |

以上为早期 API 测试，未接入真实 Motrix。后续真实联调结果见下节；Zen Twilight / Firefox 143 和一次性签名链接仍未验收。

原始数据：`.cache/ui-firefox/result.json`；首轮数据：`.cache/ui-firefox/result-first-run.json`。


## beta.46 真实联调

时间：2026-10-02 19:58–20:02（Asia/Shanghai）。

环境：macOS、本机 Firefox 157.0、已安装 Motrix 2.0.0-beta.46（内置 `@motrix/mdxp 0.8.1`）。临时安装完整生产构建，使用真实 Native Messaging 配对、加密 RPC、确认弹窗和 aria2 下载引擎，没有替换提交后端或确认动作。验收对象仍是本地 `fix/firefox-early-takeover` 候选实现，不是 PR #45 作者的当前 HEAD。

HTTP 测试服务器只监听 `127.0.0.1:19146`；除排除站点使用 `localtest.me` 访问同一服务外，其他场景直接使用 IP 地址。每个文件为 2,097,152 字节。

| 场景 | Motrix 新任务 | Firefox 新下载 | 结果 |
| --- | ---: | ---: | --- |
| IP 地址直接接管 | 1 | 0 | 已完成，校验通过 |
| 确认 → 添加到 Motrix | 1 | 0 | 自动弹窗，真实确认后完成 |
| 确认 → 用浏览器下载 | 0 | 1 | 仅浏览器完成 |
| 确认 → 取消 | 0 | 0 | 无任务、无落盘文件 |
| 排除站点 | 0 | 1 | 不接管，浏览器完成 |
| 同一 URL 分别点击两次 | 2 | 0 | 两次各生成一个任务并完成 |

4 个 Motrix 任务均显示 100% 已完成，日志包含各自独立的任务 ID 和 `finalize_http_completed`。Firefox 下载面板只增加两个 `b46` 文件。全部 6 个文件 SHA-256 均为 `6b63375c57986b454ce0218bb04186997587ff1929b43e3a7c372600b150a3cd`。

服务器记录的请求数依次为 3、3、2、1、1、6。请求数不等于任务数：提前拦截前浏览器已请求响应头，Motrix 自身也会探测下载地址；任务数量以真实应用、任务 ID 与文件结果交叉验证。

本地原始证据：`.cache/firefox-motrix-e2e/result-b46.json`、`requests-b46.jsonl`、`server-b46.mjs`。

### 联调发现与修正

- 最初 beta.44（mdxp 0.8.0）拒绝 IP 地址，返回 `-32602` / `Invalid hostname`。main 已通过 Motrix #2282 修复；升级 beta.46 后真实 IP 下载通过。此问题属于旧版 Motrix，不计为 PR #45 新缺陷。
- 真机弹窗暴露了候选实现的提示遗漏：原请求已取消，却仍显示“原下载将继续”。已按 `nativeDownloadCancelled` 区分提示，并将提前接管的按钮改为“用浏览器下载”，补齐 27 种语言。最终文案已在真实弹窗中复验。
- 修改后相关 87 项测试通过，TypeScript、Firefox 构建及产物校验通过。

本报告覆盖上述普通 HTTP 文件场景，不承诺 Firefox 143 / Zen Twilight、登录态 Cookie、重定向链、断网或后端中途崩溃、一次性签名链接等未在本轮真实联调中验证的行为。提前取消后交给 Motrix 必须重新请求 URL，无法保证一次性链接可重放。

### 验收后的环境

本机 HTTP 测试服务已停止，Firefox 临时扩展已移除（临时扩展数回到 0）。清理 Motrix 任务时，界面出现“移除 0 个任务”且未完成删除；只读核对数据库确认两轮共 7 个 `pr45-e2e-*` 测试任务仍保留，下载文件也保留，便于复核。未修改其他任务。
