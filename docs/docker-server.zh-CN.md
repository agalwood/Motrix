# Docker Server 部署

Motrix Server 将 Web 界面和经过 checksum 校验的
[`motrixapp/aria2`](https://github.com/motrixapp/aria2) fork 打包为非 root、
多架构容器镜像，适合 NAS 与家庭服务器。该 fork 提供 Motrix 所需的 SQLite
持久化契约；镜像不安装发行版提供的通用 aria2 软件包。带 tag 的正式发布会把
同一镜像发布到两个 registry：

- Docker Hub：`docker.io/motrixapp/motrix-server`
- GitHub Container Registry：`ghcr.io/agalwood/motrix-server`

仓库 Compose 默认使用 Docker Hub，因为多数 NAS 界面无需额外配置即可搜索和
拉取；GHCR 是内容相同的 GitHub 原生镜像源，也可作为备用。首个包含容器镜像
的版本发布前若返回 404 或 `manifest unknown`，表示公开镜像尚未发布；不要因此
改用 fork 提供的未验证镜像。

## 镜像、架构与 tag 选择

每个发布镜像均包含 `linux/amd64` 和 `linux/arm64`，Docker 会自动选择匹配的
manifest。Intel/AMD NAS 使用 `amd64`，ARMv8 NAS 使用 `arm64`；不支持 32 位
ARM。

| 引用 | 行为 | 建议用途 |
| --- | --- | --- |
| `:2.3.4` | 不可变正式版本 | 生产与回滚 |
| `:2.3` | 2.3 系列最新稳定补丁 | 自动接收补丁升级 |
| `:2` | 主版本 2 的最新稳定版本 | 自动接收次版本和补丁升级 |
| `:stable` | 最新稳定版本 | 明确选择稳定通道的用户 |
| `:latest` | 与 `stable` 指向同一 digest | NAS 界面默认值 |
| `:2.3.4-beta.2` | 不可变预发布版本 | 仅用于评估 |

预发布版本不会更新 `2.3`、`2`、`stable` 或 `latest`。项目不发布 `edge` 或
`nightly` 镜像。只有两个 registry 的不可变 manifest digest 一致后，发布流程
才会推进 floating tag。

如需最高可复现性，请使用 release 或 registry 显示的 digest：

```bash
export MOTRIX_IMAGE='motrixapp/motrix-server@sha256:<manifest-digest>'
docker buildx imagetools inspect "$MOTRIX_IMAGE"
```

manifest 包含 OCI source、revision、version、license、documentation labels，
以及 SPDX SBOM 和 SLSA provenance。带 tag 的 digest 使用 GitHub Actions OIDC
签名，例如：

```bash
VERSION=2.3.4
DIGEST='sha256:<manifest-digest>'
cosign verify \
  --certificate-identity "https://github.com/agalwood/Motrix/.github/workflows/release.yml@refs/tags/v${VERSION}" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "docker.io/motrixapp/motrix-server@${DIGEST}"
```

### TLS 信任库生命周期

官方镜像在构建时安装 Alpine 的 `ca-certificates`，并通过 `SSL_CERT_FILE` 让
aria2 fork 使用 `/etc/ssl/certs/ca-certificates.crt`。因此 Motrix 不会在
`/data` 中生成长期保留的 CA 快照；用新镜像重建容器时会直接使用新镜像携带的
信任库。

已经运行的不可变容器不会自动更新镜像层中的 CA bundle。请把定期拉取维护版本
并重建容器纳入日常补丁流程。如果自定义部署要求 CA 生命周期独立于镜像，也可
只读挂载定期刷新的 PEM bundle，并把 `SSL_CERT_FILE` 指向该挂载路径。

## 持久化契约

可用的部署必须有两个相互独立的可写挂载；容器根文件系统可以且应当保持
只读。

| 容器路径 | 用途 | 是否备份 |
| --- | --- | --- |
| `/data` | SQLite 数据库、设置、aria2 session 与 DHT 状态、种子元数据、operator token、插件包/状态/日志和插件 secret lockbox | 必须 |
| `/downloads` | HTTP、BT 和 magnet 任务正在下载及最终完成的用户资源 | 按数据策略决定 |

不要让这些数据只写入容器层。重新创建没有这两个挂载的容器会丢失状态或下载
文件。分开挂载还能让体积小、要求一致性的 `/data` 独立于大量下载内容备份。

## 通用 Docker Compose：bind mount

仓库的 [`compose.yaml`](../compose.yaml) 直接拉取 Docker Hub 镜像，适用于标准
Docker Compose 和 NAS 的“项目”导入。它不包含本地 build、固定 container
name、privileged 模式或特定主机行为。

先创建目录，并让它们的数字 owner 与容器使用的非 root 用户一致：

```bash
mkdir -p motrix-data downloads

# 使用专用非 root 账户；以下命令使用当前账户。
export MOTRIX_UID="$(id -u)"
export MOTRIX_GID="$(id -g)"
chown "$MOTRIX_UID:$MOTRIX_GID" motrix-data downloads

export MOTRIX_PUBLIC_URL='http://nas.example.lan:8080'
docker compose pull server
docker compose up -d --wait
docker compose ps
```

若当前管理员不是目录 owner，可使用 `sudo chown`。不要为了绕过挂载权限错误而
把 runtime UID 设为 `0` 或开启 privileged 模式。Docker Desktop 通常会自动
处理 bind mount 所有权，不需要显式 `chown`。

无需修改 Compose 文件即可用 `MOTRIX_IMAGE` 选择 GHCR、SemVer tag 或 digest：

```bash
export MOTRIX_IMAGE='ghcr.io/agalwood/motrix-server:2.3.4'
docker compose up -d --wait
```

## 通用 Docker Compose：named volume

如果希望由 NAS 管理存储位置和备份，可使用
[`compose.named-volumes.yaml`](../compose.named-volumes.yaml)。Docker 会按镜像
UID/GID 1000 的所有权初始化两个 volume：

```bash
export MOTRIX_PUBLIC_URL='http://nas.example.lan:8080'
docker compose -f compose.named-volumes.yaml pull server
docker compose -f compose.named-volumes.yaml up -d --wait
```

执行 `docker compose down` 时不要添加 `--volumes`，该参数会删除 named
volumes。需要让下载文件同时出现在 NAS 共享文件夹时，bind mount 通常更合适。

## 网络发布模式

容器内的 listener 与 Docker 宿主上发布的端口是两层独立边界。Web/API 进程在
容器内监听 `0.0.0.0:8080`，Compose 文件则把容器内 MDXP listener 设为
`MOTRIX_MDXP_HOST=0.0.0.0`，端口为 16801。这些面向整个容器的 listener 使
Docker 能够转发流量，但不会单独把服务变成公网服务。最终哪些宿主接口可以访问
它们，由 Compose `ports` 中的宿主地址决定。

标准直连 LAN 配置保持现有默认值：两个宿主端口都绑定到 `0.0.0.0`，可信 LAN
设备可通过 8080 访问 Web 服务，通过 16801 访问 MDXP。两项发布可以独立控制：

| Compose 变量 | 控制对象 | 默认值与 fallback |
| --- | --- | --- |
| `MOTRIX_WEB_BIND_IP` | 把容器 8080 端口发布到的宿主地址 | `MOTRIX_BIND_IP`，然后是 `0.0.0.0` |
| `MOTRIX_MDXP_BIND_IP` | 把容器 16801 端口发布到的宿主地址 | `MOTRIX_BIND_IP`，然后是 `0.0.0.0` |
| `MOTRIX_BIND_IP` | 两项服务的兼容 fallback | `0.0.0.0` |

原有部署只设置 `MOTRIX_BIND_IP` 时，行为保持不变。新部署可以分别绑定两项服务，
例如把 Web 界面发布到 LAN 地址，但让 MDXP 仅绑定到宿主 loopback。不要把容器内的
`MOTRIX_MDXP_HOST` 改为 `127.0.0.1`：该 loopback 属于容器，Docker 端口转发和其他容器
都无法访问它。

### 显式开启原始 aria2 RPC

aria2 引擎 RPC endpoint 与 Motrix Web/API、MDXP 是相互独立的服务，默认只在
loopback（`127.0.0.1`）监听。只有外部 aria2 RPC 客户端确实需要直连引擎时，才设置
`MOTRIX_ARIA2_RPC_LISTEN_ALL=true`。RPC secret 为空时，Server 会拒绝开启该模式；
重启前请先在**设置 > 高级设置**中确认 RPC 端口和 secret。
浏览器集成应优先使用 Motrix 扩展和 MDXP。

仓库自带的 Compose 文件会把该 opt-in 传入容器，但有意不发布 16800 端口。启用后，
同一 Compose network 内的客户端可以连接 `http://server:16800/jsonrpc`。如果客户端
运行在 Docker 宿主上，请把以下显式 override 保存为 `compose.aria2-rpc.yaml`：

```yaml
services:
  server:
    ports:
      - "127.0.0.1:16800:16800"
```

然后同时启用 listener 和端口发布，并重建 service：

```bash
export MOTRIX_ARIA2_RPC_LISTEN_ALL=true
docker compose -f compose.yaml -f compose.aria2-rpc.yaml up -d --wait
```

如果需要从可信 LAN 访问，请把 override 宿主侧的 `127.0.0.1` 换成 NAS 的具体 LAN
地址，并在宿主 firewall 中只允许所需来源。若已在 Motrix 设置中修改 RPC 端口，
映射两侧也要同步修改。外部客户端必须配置相同的 RPC secret；aria2 会把它作为
`token:<secret>` 鉴权参数。原始 aria2 RPC 不受 Motrix operator 鉴权和下载路径
策略约束；持有该 RPC secret 基本等同于获得下载引擎控制权。它也没有 TLS 保护，
切勿直接发布到公网；优先使用私有 Docker network、宿主 loopback、VPN 或其他带
鉴权的加密 tunnel。

### 运行在 Docker 宿主上的反向代理

仓库提供的 [`compose.reverse-proxy.env`](../compose.reverse-proxy.env) 会把两个已发布的
origin 端口都绑定到 Docker 宿主 loopback，适用于运行在同一宿主上的反向代理：

```bash
export MOTRIX_PUBLIC_URL='https://motrix.example.com'
docker compose --env-file compose.reverse-proxy.env -f compose.yaml pull server
docker compose --env-file compose.reverse-proxy.env -f compose.yaml up -d --wait
```

如果使用 named volume，请把 `-f compose.yaml` 替换为
`-f compose.named-volumes.yaml`。宿主反向代理需要配置两个独立 upstream：
`127.0.0.1:8080`（Web 界面/API）和 `127.0.0.1:16801`（MDXP HTTP 与 SSE），并保留 cookie、
Authorization header 和流式响应。该 environment 文件只限制宿主发布范围；它不会启用
TLS、禁用任一服务或禁用配对。TLS 证书与代理路由仍需要 operator 自行配置。

### 运行在其他容器中的反向代理

如果反向代理容器与 Motrix 位于同一个用户定义 Docker network，更安全的设计是完全省略
Motrix service 的 `ports`。让代理通过该私有 network 访问 `server:8080` 和
`server:16801`，并且只发布代理的 TLS 入口。在这种拓扑中，把 Motrix 绑定到宿主
loopback 仍会发布 origin 端口，因此没有必要。

仓库没有提供可直接运行的容器反向代理 Compose 示例，因为证书挂载、代理镜像、域名以及 MDXP
是否使用独立 origin 都与具体部署有关。请以基础 service contract 为起点，在自己的部署
Compose 中删除两条 `ports`，并让两个容器内 listener 继续使用 `0.0.0.0`，确保代理容器
可以访问它们。

## 群晖 DSM 7 Container Manager

不同版本的 Container Manager 界面名称可能略有区别，但部署模型相同：

1. 从套件中心安装 **Container Manager**。
2. 在 File Station 中创建项目目录，例如 `/volume1/docker/motrix`，并在其下
   分别创建 `motrix-data` 和 `downloads`。也可把 `downloads` 建成独立共享
   文件夹，并在 `compose.yaml` 中把该挂载左侧改成绝对路径。
3. 选择专用的非管理员 DSM 账户。在管理员 SSH 会话中用 `id <账户>` 获取其
   数字 UID/GID，然后让这两个目录的数字 owner 拥有写权限，并把相同数字设置
   为 `MOTRIX_UID` 与 `MOTRIX_GID`。仅有 DSM ACL 并不保证所有容器环境都能
   绕过 Unix owner 不匹配。
4. 在 **Container Manager > 项目** 中，使用该目录新建项目并导入或粘贴
   `compose.yaml`。把 `MOTRIX_PUBLIC_URL` 设为其他设备实际访问的浏览器 URL，
   例如 `http://nas-name:8080`。端口或 UID/GID 有变化时，可在项目环境变量中
   设置，或在导入前把对应值替换为字面量。
5. 构建/启动项目。Container Manager 应直接拉取
   `motrixapp/motrix-server:latest`，不应显示本地镜像 build。
6. 等服务变为 healthy 后打开 Web URL，并在管理员 shell 中读取
   `motrix-data/operator-token` 解锁。

不要启用“高权限”、挂载 Docker socket 或授权访问整个 NAS 文件系统。若 DSM
反向代理运行在宿主网络环境时，可使用 `compose.reverse-proxy.env` 让两个 origin 都绑定到宿主
loopback。如果代理无法访问宿主 loopback，请用 `MOTRIX_WEB_BIND_IP` 和
`MOTRIX_MDXP_BIND_IP` 把各自需要的 origin 绑定到选定的 NAS 地址，再用 DSM 防火墙限制这两个端口。

## 飞牛 fnOS Docker/Compose

在 fnOS 应用商店安装 Docker，然后使用 Compose/项目视图：

1. 在文件管理中创建应用目录，并分别创建 `motrix-data` 与 `downloads`；不要
   把它们放在容器临时存储中。
2. 让两个目录属于专用非 root 数字 UID/GID，并把相同数字用于
   `MOTRIX_UID` 与 `MOTRIX_GID`；不要用 root 运行来掩盖 owner 不匹配。
3. 使用 [`compose.yaml`](../compose.yaml) 新建 Compose 项目。相对挂载会解析到
   选定的项目目录。如果 fnOS 只接受粘贴 YAML，可把 `${...}` 替换为实际字面
   值，或在环境变量编辑器中添加同名值。
4. 如需自动接收稳定升级，使用 `motrixapp/motrix-server:latest`；如需受控升级，
   使用不可变 SemVer tag。Docker 会从 manifest 中自动选择 `amd64` 或 `arm64`。
5. 设置 `MOTRIX_PUBLIC_URL`，确认 8080 和 16801 未被占用，启动项目，并等待
   health 状态正常后再打开 Web 界面。

fnOS 的共享目录权限和容器 Unix UID/GID 必须同时允许写入。如果容器中能看到
下载、文件管理中却没有，请检查 bind mount 左侧是否确实指向目标存储池。

## Docker run

以下命令与 bind-mount Compose 部署等价：

```bash
mkdir -p motrix-data downloads
MOTRIX_UID="$(id -u)"
MOTRIX_GID="$(id -g)"
chown "$MOTRIX_UID:$MOTRIX_GID" motrix-data downloads

docker run -d \
  --name motrix-server \
  --init \
  --restart unless-stopped \
  --stop-timeout 120 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777 \
  --security-opt no-new-privileges:true \
  --user "$MOTRIX_UID:$MOTRIX_GID" \
  -e MOTRIX_PUBLIC_URL='http://nas.example.lan:8080' \
  -e MOTRIX_MDXP_HOST=0.0.0.0 \
  -p 8080:8080 \
  -p 16801:16801 \
  -v "$PWD/motrix-data:/data" \
  -v "$PWD/downloads:/downloads" \
  motrixapp/motrix-server:latest
```

镜像已经定义 healthcheck、非 root 用户、数据路径和优雅 `SIGTERM` 行为。在这条命令中，
`MOTRIX_MDXP_HOST=0.0.0.0` 控制容器内 listener，两个 `-p` 选项则把容器端口发布到
Docker 宿主。

## Web、MDXP、token 与 HTTPS 边界

以下默认地址属于两个不同服务：

| 地址 | 用途 |
| --- | --- |
| `http://NAS_HOST:8080` | Web 界面、operator RPC/API 与 `GET /healthz` |
| `http://NAS_HOST:16801` | MDXP 客户端基址；单次调用 `POST /mdxp`、事件流 `GET /mdxp/events` 与 CLI/agent device-code 配对 |

`MOTRIX_PUBLIC_URL` 是 device-code 客户端收到的、外部可访问的 **Web 审批
URL**。它没有 localhost 默认值：远程客户端需要配对时必须显式设置，不要向另一台机器上的
客户端发布 `localhost`、`127.0.0.1` 或 `0.0.0.0`。应使用 Web 端口或它的反向代理 URL，
而不是 MDXP 端口。留空不会禁用配对，但客户端无法从服务器获得有效的审批 URL。
首次启动时，Motrix 会以 `0600` 权限生成 `/data/operator-token`。使用 bind mount 时可这样读取：

```bash
cat motrix-data/operator-token
```

重启或替换镜像时会继续使用同一 token。也可以设置 `MOTRIX_OPERATOR_TOKEN`，
但环境变量能从容器元数据中看到；单机部署默认使用生成文件更安全。

当 Web 审批 URL 暂时不可用时，通过 SSH 连接的 operator 可以在运行中的容器
里批准指定的 device code。该命令只通过容器 loopback 使用现有 operator
credential，不会输出该 credential 或客户端 token：

```bash
docker compose exec server motrix-admin pairing pending
docker compose exec server motrix-admin pairing approve ABCD-EFGH
```

如果需要拒绝请求：

```bash
docker compose exec server motrix-admin pairing deny ABCD-EFGH
```

先在客户端发起 pairing，再输入该客户端显示的验证码。该命令刻意不提供
approve-latest、approve-all、远程 endpoint 或 token 参数。Web 审批仍是正常
路径；这个入口只用于 headless 或恢复场景下的本机 operator 操作。

普通 Web 界面在可信 LAN 中可以使用明文 HTTP。远程浏览器扩展配对要求更严格，因为
operator 页面会传输长期 operator token 和配对码。可信局域网若要直接使用 HTTP，必须
同时显式设置：

```bash
export MOTRIX_REMOTE_EXTENSION_ENABLED=true
export MOTRIX_REMOTE_EXTENSION_PUBLIC_URL='ws://nas.example.lan:16801'
export MOTRIX_PUBLIC_URL='http://nas.example.lan:8080'
export MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP=true
```

Motrix 会继续启用 Origin/CSRF 和 Cookie 防护，打印高风险警告，并输出扩展应填写的准确
Server 地址。公网或不可信 LAN 绝不能开启这个 HTTP 例外：路径上的攻击者仍可能读取
operator token、配对码、session Cookie 和管理操作。此类网络必须同时使用可信反向代理
终止 TLS，并用防火墙保护 origin 端口。把 8080 作为 Web
origin，并保留 cookie、Authorization header 和流式响应。MDXP 是独立的 HTTP/SSE 服务：
远程客户端还需要一个启用 TLS、指向 16801 的代理/upstream。只转发 8080 不会发布
MDXP，只转发 16801 也不会提供审批界面。不应通过禁用配对来实现这些保护；远程
CLI/agent 与浏览器扩展配对都仍然需要 operator 审批。

## 下载路径与插件

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

启动过程会创建并实际写入测试 data、临时文件、种子、home、插件和下载目录。
挂载缺失、只读或 owner 错误时会携带受影响的绝对路径启动失败。创建每个任务
时还会再次检查保存目录。`MOTRIX_ALLOWED_SAVE_DIRS` 是以冒号分隔的已挂载绝对
根目录；canonical path 检查会拒绝路径穿越和符号链接越界。

增加 archive 根目录时，必须同时挂载并允许：

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

内置插件以只读方式存放在 `/app/builtin-plugins`。用户安装的包、来源记录、
授权、配置、日志、加密 secret 和启用状态都持久化在 `/data`；通过 Web 上传
`.moext`，以及正常的 registry/URL 安装都会在替换容器后保留。

operator 可用的管理选项包括：

- `MOTRIX_PLUGIN_IMPORT_DIRS`：以冒号分隔、显式挂载为只读的本地包根目录。
- `MOTRIX_PLUGIN_INSTALL_URLS`：以逗号分隔或 JSON 数组形式提供 HTTPS、
  `github:owner/repository` 或 `registry:plugin.id` 启动安装源；任一来源失败都会
  携带原因终止启动。
- `MOTRIX_ALLOW_UNMANAGED_PLUGINS=true`：允许手动复制的插件目录；默认关闭，
  正常 `.moext`、URL 或 registry 安装不需要开启。
- `MOTRIX_SECRETS_SEED`：可选的 64 位十六进制 secret，应来自编排器 secret
  store；否则会生成并持久化 `/data/secrets.lockbox`。

官方镜像不包含 FFmpeg。依赖 FFmpeg 的插件需要基于官方镜像安装 Alpine
`ffmpeg` 包，并设置 `MOTRIX_FFMPEG_PATH=/usr/bin/ffmpeg`。

## 升级、回滚、备份与恢复

升级前记录当前镜像 digest 并备份 `/data`。做文件系统级备份前先停止服务，
确保 SQLite 与 aria2 session 一致：

```bash
docker compose stop server
tar -C . -czf "motrix-data-$(date +%Y%m%d).tar.gz" motrix-data
docker compose start server
```

然后只拉取并替换容器：

```bash
docker compose pull server
docker compose up -d --wait
docker compose ps
```

两个挂载、生成的 operator token、下载、aria2 状态和已安装插件都会保留。如需
受控升级，拉取前把 `MOTRIX_IMAGE` 设置为不可变 SemVer tag 或 digest。新的
主版本属于兼容性边界，应先阅读 release notes。

回滚时选择之前的不可变 tag/digest 并重建服务。如果新版本迁移过持久状态，
应停止 Motrix，并在启动旧镜像前恢复与其匹配的 `/data` 备份；不要假定旧二进制
一定能读取新版本写入的状态。只有下载备份策略要求时才恢复 `/downloads`。
数据库、operator token 与 `secrets.lockbox` 应来自同一代备份。

## 健康检查、诊断与故障排查

公开的 `GET /healthz` 只有在 HTTP 服务和 aria2 均就绪时才成功。详细诊断需要
operator token：

```bash
TOKEN="$(cat motrix-data/operator-token)"
curl --fail http://127.0.0.1:8080/healthz
curl --fail \
  --header "Authorization: Bearer ${TOKEN}" \
  http://127.0.0.1:8080/api/diagnostics
docker compose logs --tail=200 server
```

诊断信息包含引擎状态、生效存储路径、允许下载根目录、runtime UID、插件安装/
secret-store 状态和 FFmpeg 探测结果。

| 现象 | 检查与修复 |
| --- | --- |
| 拉取返回 404 或 `manifest unknown` | 检查 repository/tag 拼写以及是否已经有包含镜像的 release。可在另一个 registry 尝试相同不可变 tag；不要改用名称相似的第三方镜像。 |
| `no matching manifest` | 用 `docker info` 确认 NAS 是 64 位 `amd64` 或 `arm64`；不支持 32 位 ARM。 |
| 启动报告 `EACCES`、只读或路径失败 | 对比 `docker inspect ... .Config.User` 与两个挂载的数字 owner。修正 owner/ACL；不要改用 privileged 或 root。 |
| 端口已分配 | 修改 `MOTRIX_HTTP_PORT` 或 `MOTRIX_MDXP_PUBLIC_PORT`；Web 端口变化时同步更新 `MOTRIX_PUBLIC_URL`。 |
| 外部 aria2 RPC 客户端无法连接 | 确认 `MOTRIX_ARIA2_RPC_LISTEN_ALL=true`、RPC secret 非空且匹配、16800（或自定义 RPC 端口）映射正确，并检查宿主 firewall。标准 Compose 文件不会发布该端口。 |
| Web 能打开但无法解锁 | 读取当前持久化 `/data/operator-token`，不要使用另一套部署的 token。确认它是普通文件、内容为 base64url 文本且权限为 `0600`。 |
| 下载目录被拒绝或 NAS 共享目录中没有文件 | 使用 `MOTRIX_ALLOWED_SAVE_DIRS` 下的绝对容器路径；确认目标宿主目录正好挂载到该路径，并允许 runtime UID/GID 写入。 |
| 插件安装失败 | 检查 `/api/diagnostics` 与日志，保留 `/data`，核实包/来源可信且网络/TLS 可达；显式挂载所有 `MOTRIX_PLUGIN_IMPORT_DIRS`。正常 `.moext`、URL 或 registry 安装不要开启 unmanaged plugins。 |
| 升级后容器 unhealthy | 检查日志、诊断和两个挂载，然后回滚到已记录的不可变镜像及其配套 `/data` 备份。 |

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
| `MOTRIX_ARIA2_RPC_LISTEN_ALL` | `false` | 显式开启带鉴权、面向所有接口的 aria2 RPC listener；Docker 端口发布仍需单独配置 |
| `MOTRIX_WEB_BIND_IP` | Compose：`0.0.0.0` | 发布 Web 8080 端口的宿主地址；通过 `MOTRIX_BIND_IP` fallback |
| `MOTRIX_MDXP_BIND_IP` | Compose：`0.0.0.0` | 发布 MDXP 16801 端口的宿主地址；通过 `MOTRIX_BIND_IP` fallback |
| `MOTRIX_BIND_IP` | Compose：`0.0.0.0` | 向后兼容的共享宿主发布 fallback |
| `MOTRIX_MDXP_HOST` | runtime：`127.0.0.1`；Compose：`0.0.0.0` | 容器内 MDXP listener，不是宿主发布地址 |
| `MOTRIX_MDXP_PORT` | `16801` | MDXP 监听端口；`0` 表示不使用固定发布端口 |
| `MOTRIX_PUBLIC_URL` | 未设置 | 显式设置的外部可访问 Web 审批 URL，不是 MDXP URL；不会默认为 localhost |
| `MOTRIX_REMOTE_EXTENSION_ENABLED` | `false` | 显式开启浏览器扩展使用的四条远程 MBP1 路由 |
| `MOTRIX_REMOTE_EXTENSION_PUBLIC_URL` | 未设置 | Motrix Extension 中应填写的准确 WS/WSS Server 地址 |
| `MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP` | `false` | 在可信局域网显式接受 operator 凭据和管理流量暴露风险；不可信网络绝不能开启 |
| `MOTRIX_FFMPEG_PATH` | 自动探测 | 可选的 FFmpeg 绝对路径 |
| `MOTRIX_HOST_LANGUAGE` | 系统设置 | Server/插件语言覆盖值 |
| `LOG_LEVEL` | `info` | 输出到容器 stdout 的 Pino 日志级别 |

`MOTRIX_ARIA2_BIN`（`/app/bin/aria2c`）、`MOTRIX_EXTRA_DIR` 和
`MOTRIX_RENDERER_DIR` 由官方镜像固定。只有自定义镜像同时提供对应 artifact
时才应覆盖它们。
