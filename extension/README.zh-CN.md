# Motrix Extension

[English](./README.md) | 简体中文

这是 [Motrix](https://motrix.app) 的官方浏览器扩展。把浏览器里的下载交给 Motrix，然后在同一个地方查看进度、调整任务，或者从当前网页挑出真正想保存的视频、音频和图片。

## 你可以用它做什么

- 在链接上点击右键，选择“用 Motrix 下载”。
- 粘贴 HTTP、HTTPS 或磁力链接，直接新建任务。
- 让 Motrix 接管符合条件的浏览器下载；可以设置最小文件大小和不接管的域名。
- 扫描当前页面已经加载的资源，按视频、音频或图片筛选，选中后批量提交。
- 在扩展窗口里查看速度和任务状态，暂停、继续或删除任务；支持时还能在 Motrix 中打开文件所在目录。
- 连接这台电脑上的 Motrix App，也可以保存并切换多个远程 Motrix Server。

这些功能放在一起很方便，但并非每个网页都能被“看懂”。登录状态、临时地址、防盗链、DRM 和站点自身的实现都会影响结果。扩展会尽量保留下载所需的信息，却不会绕过 DRM，也无法保证网页里出现的每个资源都能单独下载。

## 开始之前

你需要：

- Chrome 120 或更高版本、当前版本的 Microsoft Edge，Firefox 142 或更高版本，或 macOS 13 及以上系统中的 Safari；
- 支持当前 MDXP / MBP1 协议的 Motrix App 或 Motrix Server；
- 首次配对本机 Motrix App 时，请先启动 Motrix，并确保它的浏览器连接组件已经正确安装。

Firefox Android 通过 Motrix Server 连接。Android 不支持 Native Messaging，
因此本机 Motrix App 后端只会在桌面浏览器中显示。

## 安装

先安装 [Motrix 2](https://motrix.app/zh/download?channel=beta)，再安装对应浏览器的扩展：

- [Chrome Web Store](https://chromewebstore.google.com/detail/motrix-extension/lggbokfckofcgjndaboioakcmincinpo)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/motrix-extension/efcflljngohddnmfmebiamigoikmdfbf)
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/motrix-extension/)
- [Safari macOS 版](https://github.com/motrixapp/motrix-extension/releases?q=safari&expanded=true)

商店版无需开启开发者模式，也无需手动添加受信任的扩展 ID。按下方[第一次连接](#第一次连接)完成配对，或参阅[浏览器扩展指南](https://motrix.app/zh/manual/browser-extension/)。

Safari 用户请下载并解压 macOS ZIP，将 `Motrix Extension for Safari.app` 移入 Applications，打开后在 Safari“设置 → 扩展”中启用 **Motrix Extension**，按需授予网站访问权限并配对。该应用已完成签名和公证，与 Motrix 配套发布，已正式可用；无需启用开发者模式或允许未签名扩展。Safari 支持连接 App/Server、配对、重连和提交下载，但不支持自动拦截下载。

Motrix AppImage 安装包目前不支持本机浏览器集成。在 Linux 上需要本机配对时，请使用 DEB 或 RPM 安装包。

扩展暂不支持 YouTube 下载，面向商店的 Chrome/Edge 与 Firefox 构建均已移除占位用的 YouTube 适配器。

## 手动加载开发版

<details>
<summary>从源码安装测试版</summary>

需要 Node.js 22.13 或更高版本，以及 pnpm 11。

```bash
pnpm install
pnpm build:chromium
pnpm build:firefox
```

Chrome 或 Edge：打开 `chrome://extensions` 或 `edge://extensions`，启用“开发者模式”，点击“加载已解压的扩展程序”，选择 `dist/chromium/`。

本地加载的 Chrome 或 Edge 开发版可能获得不在 Motrix 内置信任名单中的 ID。如果该 ID 尚未受信任，请先添加再配对；否则 Motrix 会拒绝连接，配对码也不会出现。

1. 留在 `chrome://extensions` 或 `edge://extensions`，找到 Motrix Extension，复制卡片上的 ID。
2. 打开 Motrix 的“设置 → 集成 → 浏览器扩展”，确认“用浏览器扩展发送下载到 Motrix”已经开启。
3. 展开“受信任的扩展”，点击“添加扩展”，粘贴刚才复制的 ID，浏览器选择“Chrome / Edge”，然后点击“添加”。备注可以不填。
4. 回到扩展，重新连接 Motrix，再按提示完成配对。

只添加你刚刚从浏览器扩展管理页复制的 ID。如果换了电脑，或者从另一个目录重新加载开发版，Chrome 或 Edge 可能分配新的 ID；这时要在 Motrix 中移除旧记录，再添加新 ID。

Firefox：打开 `about:debugging#/runtime/this-firefox`，点击“临时载入附加组件”，选择 `dist/firefox/manifest.json`。临时扩展会在 Firefox 重启后被移除。

macOS 上的 Safari 18.4+：运行 `pnpm build:safari`，然后在 Safari“设置 → 开发者 → 添加临时扩展”中选择 `dist/safari/`。需要启用网页开发者功能，并按 Safari 提示允许未签名扩展。临时扩展会在退出 Safari 或 24 小时后移除。

直接加载 `dist/safari/` 仅适合测试网页界面，其中没有连接 Motrix 所需的原生消息组件。正常使用及连接 App/Server，请安装[打包的 Safari 应用](#安装)。

开发原生集成时，请安装完整 Xcode 并按 [Safari 构建与分发说明](./native/safari/README.md)操作。桌面集成需要兼容的同 Team Motrix bootstrap 服务；独立 GitHub Actions 工作流负责 Safari 发布包的 Developer ID 签名和公证。

</details>

## 第一次连接

### 连接这台电脑上的 Motrix

1. 启动 Motrix App。
2. 点击浏览器工具栏中的 Motrix 图标，再点击“配对”。
3. 如果发现多个 Motrix 实例，选择你正在使用的那一个。
4. 在扩展中输入 Motrix 显示的 8 位配对码。

配对成功后，即使退出 Motrix，连接凭据也会保留。App 关闭时仍可发送下载：扩展会按需启动 App，并使用已保存的配对恢复连接。只打开扩展不会启动 App；点击“查看任务”可以连接并查看进度。远程 Server 需要已经运行且可访问。

后端指示灯用蓝色表示已配对待命、绿色表示已连接、橙色表示连接中、灰色表示未配对，红色表示需要处理的异常。悬停在选择器上可查看状态。无法取得的实时统计显示为 `—`。

如果发送后没有收到回执，请先查看任务列表再决定是否重试。扩展会保留“发送结果待确认”状态，避免自动创建重复下载。连接失败不会清除配对；只有明确遗忘配对或在 Motrix 中撤销后，才需要重新配对。

### 连接远程 Motrix Server

打开“设置 → 集成”，添加 Server 名称和 `ws://` 或 `wss://` 地址，然后完成配对。

远程连接最好使用 `wss://`。`ws://` 上传输的任务内容仍有应用层加密，但它不能可靠验证服务器身份，还可能暴露连接信息；放到公网或 NAS 反向代理后，这个差别不是理论问题。

每个 Server 的配对凭据和数据权限彼此隔离。添加 Server 并完成配对，并不等于允许浏览数据离开这台电脑；你还需要单独开启“远程下载”。Cookie 和页面派生的请求标头默认关闭，也只能按 Server 分别授权。

## 三种常用下载方式

### 右键发送

在网页中的下载链接上点击右键，选择“用 Motrix 下载”。这是最直接的方式，也不要求先开启自动接管。

右键发送也支持已选择的远程 Server，需要先完成配对并开启“远程下载”。Cookie 和请求头仍受该 Server 单独的数据权限控制。

开启“设置 → 下载 → 下载前询问”后，右键下载与符合接管规则的下载会自动打开同一份确认表单；popup 快捷设置中也有同名开关。关闭后直接发送到 Motrix。“下载接管”仍独立控制是否自动拦截，大小和网站排除规则继续生效。询问前不额外探测下载链接；大小未知时遵循已设置的处理方式。此功能无需开启“添加下载后展开任务面板”。表单支持文件名、当前浏览器 User-Agent、Referer、Cookie、Authorization 和自定义请求头，保存位置默认使用 Motrix 的默认目录，也可在支持此能力的后端中选择其他可用目录。

关闭 popup 会保留草稿和已填写内容，直到原定的两分钟有效期结束。在同一个浏览器窗口点击扩展图标即可恢复。草稿使用会话存储，后台休眠重启后仍可恢复，包括尚未填完整的字段。明确取消、过期、关闭来源浏览器窗口或切换目标后端会清除草稿；重启浏览器、重新加载或更新扩展也会清空会话存储。临时下载链接可能比草稿更早过期。不支持自动展开 popup 的浏览器会禁止开启此选项并建议升级；已开启的选项仍可关闭。

确认后的连接或提交失败会保留表单和填写的信息，不自动回退到浏览器。发送结果未知时，包括后台在提交中途重启的情况，会禁止再次提交。确认表单绑定原浏览器窗口与目标后端。

右键下载会在确认后才请求源链接。自动接管发现下载时，浏览器已经发起请求，因此扩展会在弹出表单前释放短时拦截，让原下载继续。关闭 popup 或 Motrix 提交失败都不会取消原下载；选择“保留浏览器下载”只结束询问，不发起新请求。选择发送到 Motrix 会重新请求链接，一次性链接可能失效，也可能产生重复文件，表单会提前说明。扩展无法移交浏览器已有的响应流，也无法保证在所有网盘首次请求前拦截。

### 手动新建任务

连接 Motrix 后，打开扩展的“任务”页，点击右上角的加号，粘贴一个 HTTP、HTTPS 或 `magnet:?` 地址。当前一次只能添加一个地址。HTTP(S) 任务与确认表单共用文件名和请求选项，默认填入当前浏览器 User-Agent。参数不变时重试会沿用同一提交标识；修改地址或选项则开始一次新提交。

### 选择下载目录

下载前询问和快捷添加表单支持选择当前 Motrix 的可用默认目录、收藏目录和最近
目录，需要 Motrix 提供 MDXP 0.7.0 对应能力。目录由 Motrix 管理，扩展不提供
任意文件系统浏览或新建文件夹。旧版或未连接时仍可按原流程使用默认目录；草稿中
已明确选择的目录不会被静默替换，失效时需重新选择，或主动改回默认目录。
目录草稿绑定后端配置和已配对实例，切换后端后不可直接沿用。

### 从页面资源中选择

打开扩展的“嗅探”页。扩展会列出当前页面加载过的视频、音频和图片；图片可以按格式、尺寸与文件大小继续筛选。网页使用懒加载时，先滚动或播放媒体，再点“重新扫描”，结果通常会更完整。

这里有一点容易误解：发现资源不代表一定能下载。某些地址很快过期，某些视频需要分别下载音轨和画面并由 Motrix 调用 ffmpeg 合并，还有一些资源受 DRM 保护。扩展会明确标出当前后端不支持的选择，而不是假装提交成功。

## 下载接管

“接管”开启后，符合条件的浏览器下载会自动交给本机 Motrix App。远程 Server 开启远程下载权限后可接受手动任务、选中的页面资源和右键下载，自动接管仍仅支持本机 App。你可以在设置中填写：

- 最小文件大小，低于这个值的下载仍由浏览器处理；
- 黑名单域名，每行一个，这些站点始终交给浏览器。

接管默认关闭，第一次开启时会要求确认。原因很具体：为了让需要登录的下载继续有效，扩展可能读取目标域名的 Cookie 并随任务发送给 Motrix。内置敏感域名列表会把部分银行、政务和医疗站点排除在外；如果 Motrix 无法接收普通 HTTP(S) 下载，扩展会尽可能退回浏览器下载。磁力链接没有对应的浏览器下载可退回。

设置 → 下载中新增“接管成功后展开任务面板”，默认关闭，点击“应用”保存。Chrome / Edge 127+、Firefox 149+ 支持在 Motrix 确认收到自动接管的下载后展开扩展弹窗。相邻间隔小于 10 秒的连续下载只展开一次；面板已打开时只刷新数据，保留当前页面和筛选。切换窗口或手动关闭面板后，同批下载不会再次将它展开。

请求超时后，面板会检查连接，保留上次的任务数据并暂停操作和轮询。恢复过程先探测当前连接，必要时使用已有凭证重连一次；任务和状态查询最多重试一次。下载提交和任务操作不会自动重放，结果待确认的下载仍需先在 Motrix 中检查。

## 数据与权限

浏览器会提示这个扩展需要访问所有网站、下载记录和 Cookie。这个范围确实很大，我不想用一句“为了正常工作”含糊带过。

| 权限 | 用途 |
| --- | --- |
| 访问网页与网络请求 | 识别链接、媒体清单、图片和其他已加载资源 |
| 下载管理 | 接管下载；交接失败时恢复为浏览器下载 |
| Cookie | 在你主动提交页面资源或同意下载接管时，保留需要登录的下载状态；远程 Server 还要单独授权 |
| Native Messaging | 发现并连接这台电脑上的 Motrix App |
| 本地存储 | 保存设置、Server 列表、配对凭据和每个 Server 的授权 |
| 通知与右键菜单 | 报告交接结果，并提供“用 Motrix 下载”入口 |

页面资源的扫描在浏览器本地进行，不会因为你打开了某个网页就把整页内容发送给 Motrix。真正提交任务时，当前后端会收到完成下载所需的数据，例如目标地址、来源页面地址与标题、建议文件名；Cookie 和请求标头是否随任务发送，取决于下载方式、后端类型以及你授予的权限。

远程 Server 的权限默认从最小范围开始。除非你明确开启，否则扩展不会向它发送 Cookie 或认证标头。只给自己控制的 Server 开启这些权限。

## 常见问题

### 连接失败时如何自助诊断？

点击报错框中的“诊断”。扩展会启用 debug 日志，检查安装类型、权限、已有配对凭据、Native Host 和桥接端口；远程 Server 则检查所选地址的 discovery 接口。完成后，报错框显示各项结果、耗时和开发者排查建议，右上角的小复制按钮可复制完整报告。后台不可用或超时时，也会保留可复制的错误与环境信息。

`management.getSelf().installType` 可以识别未打包的开发安装，无需新增 `management` 权限；它不能判断 DevTools 是否打开。扩展无法直接读取本地白名单，报告会区分 Native Host 访问被拒、Host 未注册与 App 未运行。诊断不会启动 Motrix、重新配对或清除凭据；Native Host 的现有探测协议可能产生一个未使用的 nonce，扩展会丢弃它。报告不包含配对密钥、nonce、ticket 或完整后端配置。

诊断后可点击“连接”复现问题，在扩展后台控制台查看后续 debug 日志。排查完毕后，到扩展“设置 → 帮助”恢复日志级别。

### 为什么 Chrome 开发版无法连接 Motrix？

先检查扩展 ID 是否已经加入 Motrix 的“设置 → 集成 → 浏览器扩展 → 受信任的扩展”。ID 可以在 `chrome://extensions` 的“Motrix 扩展”卡片上找到。开发版换了加载目录后，ID 可能与之前不同，Motrix 里的记录也要跟着更新。

### 为什么一直找不到本机 Motrix？

先确认 Motrix 正在运行，然后重新扫描。仍然找不到时，检查浏览器是否允许扩展访问本机地址，以及 Motrix 的浏览器连接组件是否安装完整。旧版 Motrix 也可能不支持当前配对协议。

### 为什么页面里明明有视频，扩展却没有列出来？

先播放几秒，再重新扫描。扩展依据网页元素和实际网络请求识别资源；还没有加载的媒体，它自然看不到。`blob:` 地址、DRM 流、很快失效的临时链接和经过特殊封装的播放器，也可能无法处理。

### 为什么远程 Server 已配对，却不能提交下载？

配对只确认“它是谁”，不代表“可以发什么”。请在“设置 → 集成”中为这个 Server 开启“远程下载”；如果资源依赖 Referer、Cookie 或认证标头，再按需开启相应权限。

### YouTube 能下载吗？

现在不能。普通 Chromium 开发构建中的 YouTube 适配器仍是联调用的占位实现，只会提交一个注定失败的测试地址；面向 Chrome/Edge 商店和 Firefox 的构建则完全移除了这项能力。

## 给开发者

```bash
pnpm dev                 # Chromium 开发构建
pnpm dev:firefox         # Firefox 开发构建
pnpm test                # 测试
pnpm lint                # 代码检查
pnpm build:webstore      # Chrome Web Store 合规构建
```

### 发布 GitHub Release

Release 由 GitHub Actions 从已有的 `vX.Y.Z` 标签构建。先修改
`package.json` 中的版本并提交，再创建、推送同版本标签：

```bash
git tag -a v0.1.2 -m "Motrix Extension 0.1.2"
git push origin v0.1.2
```

工作流会依次执行代码检查与测试，构建 Chrome/Edge 商店版和 Firefox 版，
确认两个 manifest 的版本一致，然后把两个浏览器 ZIP、供 Firefox 审核的
可复现源码 ZIP 和 `SHA256SUMS.txt` 发布到 GitHub Release。也可以在 GitHub
Actions 的 **Release browser extension** 工作流中手动发布一个已有标签。

主要代码位于：

- `src/background/`：配对、连接、下载交接、任务控制和配置存储；
- `src/popup/`：扩展弹窗；
- `src/options/`：设置页；
- `src/content/`：页面资源识别；
- `src/adapters/`：站点适配器。

## 相关项目

- [Motrix](https://github.com/agalwood/Motrix)：桌面应用与服务端
- [motrix-extension](https://github.com/motrixapp/motrix-extension)：扩展公开仓库
- [MDXP](https://github.com/motrixapp/mdxp)：协议定义与连接工具

## 许可证

[MIT](./LICENSE) © 2026-present Dr_rOot
