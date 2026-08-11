# Docker Server deployment

The Motrix Server image contains the Web UI and aria2 and runs as a non-root
user. Its root filesystem can remain read-only. A useful deployment must mount
two independent writable locations:

| Container path | Purpose | Back up? |
| --- | --- | --- |
| `/data` | SQLite database, settings, aria2 session and DHT state, torrent metadata, operator token, plugin packages/state/logs, and the plugin secret lockbox | Yes |
| `/downloads` | Completed and in-progress HTTP, BT, and magnet resources | According to your data policy |

Do not combine these paths with the container layer. Recreating an unmounted
container discards its database, plugin state, and downloaded files.

## Start with Docker Compose

The included [`compose.yaml`](../compose.yaml) builds the production runtime,
runs it without root privileges, enables a read-only root filesystem, and
publishes the Web and MDXP ports.

Create the bind-mount directories before starting. On Linux, either make them
writable by UID/GID 1000 (the image default), or run with your own non-root
UID/GID:

```bash
mkdir -p motrix-data downloads

# Option A: keep the image default user.
sudo chown 1000:1000 motrix-data downloads

# Option B: use the current non-root Linux user instead.
export MOTRIX_UID="$(id -u)"
export MOTRIX_GID="$(id -g)"
```

Docker Desktop normally handles bind-mount ownership without the Linux
`chown` step. Never set the runtime UID to `0` merely to bypass a mount
permission problem.

For access from another device, set the public Web URL before starting:

```bash
export MOTRIX_PUBLIC_URL="http://motrix.example.lan:8080"
docker compose up --build -d
docker compose ps
```

Open `MOTRIX_PUBLIC_URL` in a browser. On the first start, Motrix creates a
random operator token at `motrix-data/operator-token` with mode `0600`. Use it
on the unlock screen:

```bash
cat motrix-data/operator-token
```

You may instead set `MOTRIX_OPERATOR_TOKEN`, but environment variables are
visible in container metadata. The generated file is the safer default for a
single-host deployment.

The compose defaults publish these ports on all interfaces:

| Port | Service |
| --- | --- |
| `8080` | Web UI, operator RPC/API, and health endpoint |
| `16801` | MDXP endpoint for paired CLI and extension clients |

Set `MOTRIX_BIND_IP=127.0.0.1` when a local reverse proxy is the only intended
entry point. Terminate TLS at that proxy when crossing an untrusted network.
The operator control plane is deny-by-default, but TLS is still required to
protect credentials in transit.

## Storage and download-path contract

The image defaults to:

```text
MOTRIX_DATA_DIR=/data
MOTRIX_TEMP_DIR=/data/tmp
MOTRIX_PLUGIN_DIR=/data/plugins
MOTRIX_DEFAULT_SAVE_DIR=/downloads
MOTRIX_ALLOWED_SAVE_DIRS=/downloads
HOME=/data/home
TMPDIR=/data/tmp
```

The Server creates and write-tests its data, temporary, torrent metadata,
home, plugin, and allowed download directories before it begins accepting
requests. Startup fails with the affected absolute path when a mount is
missing, read-only, or owned by the wrong UID. Every task save directory is
validated again when the task is created.

`MOTRIX_ALLOWED_SAVE_DIRS` is a colon-separated list in the Linux image. Every
entry must be an absolute, mounted, writable directory, and
`MOTRIX_DEFAULT_SAVE_DIR` must be inside one of them. Requests outside the
configured roots are rejected. Canonical path checks also reject symlink
escapes.

To add another download root, mount it and update both variables:

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

The Web path picker only offers allowed roots, and the Server enforces the same
policy independently of the UI.

## Plugins

Built-in plugins are read-only under `/app/builtin-plugins`. User-installed
plugins, install provenance, grants, logs, configuration, encrypted secrets,
and enablement state persist through `/data`. The install pipeline uses
transient directories below `/data/plugins`; stale upload, download, and
staging data is cleared on startup without deleting installed plugins.

The Web UI uploads a local `.moext` package to the Server before showing the
consent screen, so it does not depend on Electron's `File.path`. Installed
plugins remain available after a container replacement as long as `/data` is
preserved. Uninstall removes the package, enablement state, configuration, and
encrypted secret values.

For operator-managed sources, these options are also available:

- `MOTRIX_PLUGIN_IMPORT_DIRS`: colon-separated, read-only container roots from
  which an absolute package path may be installed. Mount every root explicitly.
- `MOTRIX_PLUGIN_INSTALL_URLS`: comma-separated or JSON-array startup sources.
  Each entry may be an HTTPS URL, `github:owner/repository`, or
  `registry:plugin.id`. Setting it is explicit operator consent; any failed
  source stops startup with its reason.
- `MOTRIX_ALLOW_UNMANAGED_PLUGINS=true`: permits manually copied plugin
  directories that have no install record. It is `false` by default and is not
  needed for normal Web, registry, URL, or bootstrap installation.

Plugin secrets use `/data/secrets.lockbox`, which Motrix creates and persists.
For orchestrated deployments, `MOTRIX_SECRETS_SEED` can supply exactly 64 hex
characters instead; keep that value in the orchestrator's secret store.

## Health and diagnostics

`GET /healthz` is public and returns success only after the Server is accepting
requests and aria2 is ready. Docker uses it for the container health check.

The detailed diagnostic endpoint is operator-protected:

```bash
TOKEN="$(cat motrix-data/operator-token)"
curl --fail http://127.0.0.1:8080/healthz
curl --fail \
  --header "Authorization: Bearer ${TOKEN}" \
  http://127.0.0.1:8080/api/diagnostics
```

It reports engine status, effective storage paths, allowed download roots,
runtime UID, plugin install/secret-store availability, and FFmpeg discovery.
The official image does not install FFmpeg. If a plugin requires it, derive a
small custom image that installs Alpine's `ffmpeg` package and set
`MOTRIX_FFMPEG_PATH=/usr/bin/ffmpeg`; diagnostics will confirm the selected
binary. Media temporary files use `/data/tmp`, not the read-only image layer.

Useful operational commands:

```bash
docker compose logs --follow server
docker compose stop                 # sends SIGTERM and waits for clean shutdown
docker compose up --build -d        # rebuild/upgrade while retaining both mounts
```

Stop the service before taking a filesystem-level backup of `/data`, so the
SQLite database and aria2 session are consistent. Preserve the operator token
and secret lockbox together with the database.

## Environment reference

| Variable | Image default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | Web/API listen port inside the container |
| `MOTRIX_DATA_DIR` | `/data` | Must be absolute and writable |
| `MOTRIX_TEMP_DIR` | `/data/tmp` | Must be absolute and writable |
| `MOTRIX_DEFAULT_SAVE_DIR` | `/downloads` | Default resource destination |
| `MOTRIX_ALLOWED_SAVE_DIRS` | `/downloads` | Colon-separated server-enforced roots |
| `MOTRIX_PLUGIN_DIR` | `/data/plugins` | Writable persistent user-plugin root |
| `MOTRIX_BUILTIN_PLUGIN_DIR` | `/app/builtin-plugins` | Read-only built-in plugin root |
| `MOTRIX_PLUGIN_IMPORT_DIRS` | empty | Colon-separated mounted package roots |
| `MOTRIX_PLUGIN_INSTALL_URLS` | empty | Declarative startup plugin sources |
| `MOTRIX_ALLOW_UNMANAGED_PLUGINS` | `false` | Allow plugin directories without install provenance |
| `MOTRIX_OPERATOR_TOKEN` | generated file | Operator control-plane credential |
| `MOTRIX_SECRETS_SEED` | generated lockbox | 64-hex-character plugin secret key |
| `MOTRIX_MDXP_HOST` | `127.0.0.1` (Compose: `0.0.0.0`) | MDXP bind address |
| `MOTRIX_MDXP_PORT` | `16801` | MDXP listen port; `0` disables a stable published port |
| `MOTRIX_PUBLIC_URL` | unset | Browser URL shown during device-code pairing |
| `MOTRIX_FFMPEG_PATH` | auto-detect | Optional absolute FFmpeg path |
| `MOTRIX_HOST_LANGUAGE` | system setting | Server/plugin locale override |
| `LOG_LEVEL` | `info` | Pino log level written to container stdout |

`MOTRIX_ARIA2_BIN`, `MOTRIX_EXTRA_DIR`, and `MOTRIX_RENDERER_DIR` are fixed by
the official image. Override them only in a custom image that provides the
corresponding artifacts.
