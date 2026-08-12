# Docker Server 部署

Motrix Server 镜像包含 Web 界面和 aria2，并以非 root 用户运行。容器根文件
系统可保持只读。可用的部署必须挂载两个相互独立的可写位置：

| 容器路径 | 用途 | 是否备份 |
| --- | --- | --- |
| `/data` | SQLite 数据库、设置、aria2 session 与 DHT 状态、种子元数据、operator token、插件包/状态/日志和插件 secret lockbox | 必须 |
| `/downloads` | HTTP、BT 和 magnet 任务正在下载及最终完成的用户资源 | 按数据策略决定 |

不要让这些数据只写入容器层。重新创建未挂载持久卷的容器会丢失数据库、
插件状态和下载文件。

## 使用 Docker Compose 启动

仓库提供的 [`compose.yaml`](../compose.yaml) 会构建生产 runtime，以非 root
用户运行，启用只读根文件系统，并发布 Web 与 MDXP 端口。

启动前先创建 bind mount 目录。在 Linux 上，可以把它们交给镜像默认的
UID/GID 1000，也可以让容器使用当前的非 root UID/GID：

```bash
mkdir -p motrix-data downloads

# 方案 A：保留镜像默认用户。
sudo chown 1000:1000 motrix-data downloads

# 方案 B：使用当前 Linux 非 root 用户。
export MOTRIX_UID="$(id -u)"
export MOTRIX_GID="$(id -g)"
```

Docker Desktop 通常会自动处理 bind mount 所有权，无需执行 Linux 的
`chown` 步骤。不要为了绕过权限问题把 runtime UID 设为 `0`。

如果要从其他设备访问，请在启动前配置 Web 公网/局域网地址：

```bash
export MOTRIX_PUBLIC_URL="http://motrix.example.lan:8080"
docker compose up --build -d
docker compose ps
```

在浏览器中打开 `MOTRIX_PUBLIC_URL`。首次启动时，Motrix 会生成随机的
operator token，以 `0600` 权限保存在 `motrix-data/operator-token`。在解锁
界面输入它：

```bash
cat motrix-data/operator-token
```

也可以设置 `MOTRIX_OPERATOR_TOKEN`，但环境变量可从容器元数据中看到。
对单机部署而言，自动生成并持久化的 token 文件是更安全的默认方案。

Compose 默认在所有网卡发布以下端口：

| 端口 | 服务 |
| --- | --- |
| `8080` | Web 界面、operator RPC/API 与健康检查 |
| `16801` | 已配对 CLI 和浏览器扩展使用的 MDXP endpoint |

如果只允许本机反向代理访问，设置 `MOTRIX_BIND_IP=127.0.0.1`。跨越不可信
网络时应在反向代理终止 TLS。operator 控制面虽然默认拒绝未认证请求，但仍
需用 TLS 保护传输中的凭据。

## 存储与下载路径契约

镜像默认值如下：

```text
MOTRIX_DATA_DIR=/data
MOTRIX_TEMP_DIR=/data/tmp
MOTRIX_PLUGIN_DIR=/data/plugins
MOTRIX_DEFAULT_SAVE_DIR=/downloads
MOTRIX_ALLOWED_SAVE_DIRS=/downloads
HOME=/data/home
TMPDIR=/data/tmp
```

Server 会在接受请求前创建并实际写入测试 data、临时文件、种子元数据、
home、插件和允许下载目录。挂载缺失、只读或 UID 所有权错误时，启动会失败
并指出具体绝对路径。创建每个任务时还会再次检查该任务的保存目录。

Linux 镜像中的 `MOTRIX_ALLOWED_SAVE_DIRS` 使用冒号分隔。每一项都必须是
已挂载、可写的绝对路径，且 `MOTRIX_DEFAULT_SAVE_DIR` 必须位于其中。Server
会拒绝允许根目录之外的请求，也会通过 canonical path 检查拒绝符号链接
越界。

增加另一个下载根目录时，必须同时挂载并更新变量：

```yaml
services:
  server:
    environment:
      MOTRIX_DEFAULT_SAVE_DIR: /downloads
      MOTRIX_ALLOWED_SAVE_DIRS: /downloads:/archive
    volumes:
      - ./motrix-data:/data
      - ./downloads:/downloads
      - /srv/archive:/archive
```

Web 路径选择器只提供允许根目录；Server 仍会独立执行同一套约束，不依赖
UI 保证安全。

## 插件

内置插件以只读方式存放在 `/app/builtin-plugins`。用户安装的插件、来源记录、
授权、日志、配置、加密 secret 和启用状态都通过 `/data` 持久化。安装流程在
`/data/plugins` 下使用临时目录；启动时会清除遗留的上传、下载和 staging
数据，但不会删除已安装插件。

Web 界面会先把本地 `.moext` 包上传到 Server，再显示授权界面，因此不依赖
Electron 的 `File.path`。只要保留 `/data`，替换容器后插件仍会恢复。卸载
插件会同时清除包、启用状态、配置和加密 secret 值。

还可以使用以下 operator 管理方式：

- `MOTRIX_PLUGIN_IMPORT_DIRS`：以冒号分隔的容器内只读根目录，可从中按绝对
  路径安装包；必须显式挂载每个根目录。
- `MOTRIX_PLUGIN_INSTALL_URLS`：以逗号分隔或 JSON 数组形式提供启动安装源。
  每项可为 HTTPS URL、`github:owner/repository` 或 `registry:plugin.id`。设置
  此变量代表 operator 明确同意安装；任何来源失败都会携带原因终止启动。
- `MOTRIX_ALLOW_UNMANAGED_PLUGINS=true`：允许没有安装记录、由管理员手动复制
  的插件目录。默认值为 `false`；通过 Web、registry、URL 或启动安装时不需要
  开启。

插件 secret 默认使用 `/data/secrets.lockbox`，Motrix 会自动创建并持久化它。
编排环境也可以通过 `MOTRIX_SECRETS_SEED` 提供恰好 64 个十六进制字符；应把
该值保存在编排平台的 secret store 中。

## 健康检查与诊断

公开的 `GET /healthz` 只有在 Server 正在接受请求且 aria2 已就绪时才返回成功。
Docker 也使用此接口判断容器健康状态。

详细诊断接口受 operator 认证保护：

```bash
TOKEN="$(cat motrix-data/operator-token)"
curl --fail http://127.0.0.1:8080/healthz
curl --fail \
  --header "Authorization: Bearer ${TOKEN}" \
  http://127.0.0.1:8080/api/diagnostics
```

诊断信息包含引擎状态、生效的存储路径、允许下载根目录、runtime UID、插件
安装/secret store 可用性以及 FFmpeg 探测结果。官方镜像不安装 FFmpeg。若
插件需要它，可基于官方镜像安装 Alpine `ffmpeg` 包，并设置
`MOTRIX_FFMPEG_PATH=/usr/bin/ffmpeg`；诊断接口会确认最终使用的二进制。媒体
临时文件使用 `/data/tmp`，不会写入只读镜像层。

常用运维命令：

```bash
docker compose logs --follow server
docker compose stop                 # 发送 SIGTERM 并等待干净退出
docker compose up --build -d        # 重建/升级，同时保留两个挂载
```

对 `/data` 做文件系统级备份前应先停止服务，确保 SQLite 数据库和 aria2
session 一致。operator token、secret lockbox 与数据库应一并保留。

## 环境变量参考

| 变量 | 镜像默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器内 Web/API 监听端口 |
| `MOTRIX_DATA_DIR` | `/data` | 必须为可写绝对路径 |
| `MOTRIX_TEMP_DIR` | `/data/tmp` | 必须为可写绝对路径 |
| `MOTRIX_DEFAULT_SAVE_DIR` | `/downloads` | 默认用户资源目录 |
| `MOTRIX_ALLOWED_SAVE_DIRS` | `/downloads` | 以冒号分隔、由服务端强制执行的根目录 |
| `MOTRIX_PLUGIN_DIR` | `/data/plugins` | 可写且持久化的用户插件根目录 |
| `MOTRIX_BUILTIN_PLUGIN_DIR` | `/app/builtin-plugins` | 只读内置插件根目录 |
| `MOTRIX_PLUGIN_IMPORT_DIRS` | 空 | 以冒号分隔的已挂载插件包根目录 |
| `MOTRIX_PLUGIN_INSTALL_URLS` | 空 | 声明式启动插件来源 |
| `MOTRIX_ALLOW_UNMANAGED_PLUGINS` | `false` | 允许没有安装来源记录的插件目录 |
| `MOTRIX_OPERATOR_TOKEN` | 自动生成文件 | operator 控制面凭据 |
| `MOTRIX_SECRETS_SEED` | 自动生成 lockbox | 64 位十六进制插件 secret 密钥 |
| `MOTRIX_MDXP_HOST` | `127.0.0.1`（Compose 为 `0.0.0.0`） | MDXP 监听地址 |
| `MOTRIX_MDXP_PORT` | `16801` | MDXP 监听端口；`0` 表示不使用固定发布端口 |
| `MOTRIX_PUBLIC_URL` | 未设置 | device-code 配对时显示的浏览器地址 |
| `MOTRIX_FFMPEG_PATH` | 自动探测 | 可选的 FFmpeg 绝对路径 |
| `MOTRIX_HOST_LANGUAGE` | 系统设置 | Server/插件语言覆盖值 |
| `LOG_LEVEL` | `info` | 输出到容器 stdout 的 Pino 日志级别 |

`MOTRIX_ARIA2_BIN`、`MOTRIX_EXTRA_DIR` 和 `MOTRIX_RENDERER_DIR` 由官方镜像
固定。只有自定义镜像同时提供了对应 artifact 时才应覆盖它们。
