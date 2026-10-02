# 通过链接打开 Motrix

Motrix v2 桌面应用支持 `motrix://` 链接。链接可以打开页面或预填新建任务草稿，不会自动创建下载、暂停或恢复任务、安装插件，也不会访问外部指定的本地路径。请在 Motrix 内检查并提交下载。

## 支持的链接

| 链接 | 行为 |
| --- | --- |
| `motrix://` | 显示主窗口，保留当前页面 |
| `motrix://downloads` | 全部下载 |
| `motrix://downloads/active` | 活动下载 |
| `motrix://downloads/completed` | 已完成下载 |
| `motrix://downloads/error` | 错误下载 |
| `motrix://task-list` | 活动下载（v1 别名） |
| `motrix://task-list?status=all` | 全部下载；也支持 `active`、`completed` 和 `error` |
| `motrix://settings` 或 `motrix://preferences` | 设置 |
| `motrix://about` | 设置中的关于 |
| `motrix://new-task` | 空白链接草稿 |
| `motrix://new-task?uri=…` | 预填一个通过校验的 HTTP、HTTPS、FTP 或 Magnet 地址 |
| `motrix://new-bt-task` | 种子草稿；在 Motrix 内选择文件 |
| `motrix://plugins/<id>` | 插件详情；安装仍需应用内授权 |
| `motrix://tasks/<id>` | 使用 Motrix 任务 ID 打开已有任务详情；任务不可用时回到全部下载 |

`task-list` 的旧参数 `status=waiting` 会打开活动下载并说明分类已调整；`status=stopped` 会打开全部下载，并说明已完成和错误现为两个分类。未知状态会打开全部下载并提示分类无效。打开下载列表时，会清除之前的关键词、类型筛选、选中项和任务详情。

## 对嵌套地址编码一次

```js
const link = `motrix://new-task?uri=${encodeURIComponent(downloadUrl)}`
```

对完整源地址编码，包括查询参数和片段。Motrix 仅解码外层一次，保留源地址自身的百分号编码。任务和插件 ID 也应使用 `encodeURIComponent` 编码。协议和命令名不区分大小写，ID 和下载地址保留原有大小写。允许一个末尾斜杠。

查询参数仅允许 `new-task` 的 `uri` 和 `task-list` 的 `status`。重复参数、错误编码、外层 URL 的认证信息、端口、片段及超过 64 KiB 的链接会被拒绝。源地址必须通过现有下载源校验，包括 16 KiB 长度限制。链接不接受多个源地址、cURL 命令或本地路径。

## 与 v1 的差异

`mo://` 已停用，新安装不再注册该协议。如果旧系统关联仍将此链接传给 Motrix，应用会显示停用提示，不执行链接命令。升级清理只会移除能够确认属于当前安装的旧关联，不改动其他应用的关联。

`pause-all-task`、`resume-all-task` 和 `reveal-in-folder` 已停用，请使用 Motrix 内的对应控件。

不再支持 `silent`、`dir`、`out`、`allProxy`、`split`、`cookie`、`authorization`、`userAgent`、`referer`、`torrent`、`selectFile`、`type`、`path` 和 `gid` 等旧参数。包含不支持参数的链接会整体拒绝，不会静默转成只执行一部分的请求。未知命令和错误链接会显示提示，不执行操作。

直接打开 `magnet:` 链接和 `.torrent` 文件关联保留现有行为。浏览器扩展及其他经过认证的集成继续使用已有 API。本规范适用于桌面应用链接，不是 Motrix 服务端的 HTTP 路由。
