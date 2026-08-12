# Docker Server deployment

Motrix Server packages the Web UI and aria2 in a non-root, multi-architecture
container image for NAS and home-server deployments. Tagged releases publish
the same image to both registries:

- Docker Hub: `docker.io/agalwood/motrix-server`
- GitHub Container Registry: `ghcr.io/agalwood/motrix-server`

Docker Hub is the default in the included Compose files because NAS interfaces
usually discover and pull it with the least configuration. GHCR is an
equivalent GitHub-native mirror and a useful fallback. A `manifest unknown` or
404 before the first image-bearing release means that no public image has been
published yet; it is not a reason to build an unverified image from a fork.

## Image, architecture, and tag selection

Every release image includes `linux/amd64` and `linux/arm64`. Docker selects the
matching manifest automatically. Intel and AMD NAS devices use `amd64`; ARMv8
NAS devices use `arm64`. The image does not support 32-bit ARM.

| Reference | Behavior | Recommended use |
| --- | --- | --- |
| `:2.3.4` | Immutable release | Production and rollback |
| `:2.3` | Newest stable patch in 2.3 | Automatic patch upgrades |
| `:2` | Newest stable release in major 2 | Automatic minor and patch upgrades |
| `:stable` | Newest stable release | Users who explicitly want the stable channel |
| `:latest` | Same digest as `stable` | NAS UI default |
| `:2.3.4-beta.2` | Immutable prerelease | Evaluation only |

Prereleases never update `2.3`, `2`, `stable`, or `latest`. There are no
`edge` or `nightly` images. Both registries receive the same immutable manifest
digest before any floating tag is advanced.

For maximum reproducibility, pin the digest shown by the release or registry:

```bash
export MOTRIX_IMAGE='agalwood/motrix-server@sha256:<manifest-digest>'
docker buildx imagetools inspect "$MOTRIX_IMAGE"
```

The manifest includes OCI source, revision, version, license, and documentation
labels, plus an SPDX SBOM and SLSA provenance. Tagged digests are signed through
GitHub Actions OIDC. For example:

```bash
VERSION=2.3.4
DIGEST='sha256:<manifest-digest>'
cosign verify \
  --certificate-identity "https://github.com/agalwood/Motrix/.github/workflows/release.yml@refs/tags/v${VERSION}" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "docker.io/agalwood/motrix-server@${DIGEST}"
```

## Persistent storage contract

A usable deployment has two independent writable mounts. The container root
filesystem can and should remain read-only.

| Container path | Purpose | Back up? |
| --- | --- | --- |
| `/data` | SQLite database, settings, aria2 session and DHT state, torrent metadata, operator token, plugin packages/state/logs, and plugin secret lockbox | Yes |
| `/downloads` | Completed and in-progress HTTP, BT, and magnet resources | According to your data policy |

Do not combine these paths with the container layer. Recreating a container
without both mounts loses state or downloaded data. Keeping them separate lets
you back up the small, consistency-sensitive `/data` tree independently of
large downloads.

## Generic Docker Compose: bind mounts

The included [`compose.yaml`](../compose.yaml) pulls the Docker Hub image. It is
suitable for Docker Compose and NAS "Project" import: it has no local build,
fixed container name, privileged mode, or host-specific Docker behavior.

Create the directories and make their numeric owner match the non-root user
that the container will run as:

```bash
mkdir -p motrix-data downloads

# Use a dedicated non-root account. These commands use the current user.
export MOTRIX_UID="$(id -u)"
export MOTRIX_GID="$(id -g)"
chown "$MOTRIX_UID:$MOTRIX_GID" motrix-data downloads

export MOTRIX_PUBLIC_URL='http://nas.example.lan:8080'
docker compose pull server
docker compose up -d --wait
docker compose ps
```

Use `sudo chown` if the current administrator does not own the directories.
Never set the runtime UID to `0` or enable privileged mode just to bypass a
mount permission error. Docker Desktop generally handles bind-mount ownership
without an explicit `chown`.

`MOTRIX_IMAGE` may select GHCR, a SemVer tag, or a digest without editing the
Compose file:

```bash
export MOTRIX_IMAGE='ghcr.io/agalwood/motrix-server:2.3.4'
docker compose up -d --wait
```

## Generic Docker Compose: named volumes

Use [`compose.named-volumes.yaml`](../compose.named-volumes.yaml) when the NAS
should manage storage locations and backups. Docker initializes both volumes
with the image's UID/GID 1000 ownership:

```bash
export MOTRIX_PUBLIC_URL='http://nas.example.lan:8080'
docker compose -f compose.named-volumes.yaml pull server
docker compose -f compose.named-volumes.yaml up -d --wait
```

Do not add `--volumes` to `docker compose down`: that option deletes the named
volumes. Bind mounts are usually easier when downloads must also appear in a
NAS shared folder.

## Synology DSM 7 Container Manager

DSM labels can vary slightly between Container Manager updates, but the
deployment model is the same:

1. Install **Container Manager** from Package Center.
2. In File Station, create a project directory such as
   `/volume1/docker/motrix`, with `motrix-data` and `downloads` below it. You may
   instead make `downloads` a separate shared folder and replace the left side
   of that bind mount in `compose.yaml` with its absolute path.
3. Choose a dedicated, non-administrator DSM account. Determine its numeric
   UID/GID with `id <account>` over an administrator SSH session, then give that
   numeric owner write access to both directories. Set `MOTRIX_UID` and
   `MOTRIX_GID` to the same values. DSM ACL access alone does not repair a
   mismatched Unix owner inside every container setup.
4. In **Container Manager > Project**, create a project using that directory
   and import or paste `compose.yaml`. Set `MOTRIX_PUBLIC_URL` to the browser URL
   that other devices will use, for example `http://nas-name:8080`. Set any
   changed ports or UID/GID values in the Project environment or substitute
   literal values before import.
5. Build/start the Project. Container Manager should pull
   `agalwood/motrix-server:latest`; it must not display a local image build.
6. Wait for the service to become healthy, open the Web URL, and read
   `motrix-data/operator-token` from an administrator shell to unlock it.

Do not enable "high privilege", mount the Docker socket, or grant access to the
whole NAS filesystem. If DSM's reverse proxy is the only Web entry point, set
`MOTRIX_BIND_IP=127.0.0.1` only when that address is reachable from the proxy's
network context; otherwise bind the NAS address and restrict the port with the
DSM firewall.

## fnOS Docker/Compose

On fnOS, install Docker from the app store, then use its Compose/Project view:

1. Create an application directory with separate `motrix-data` and `downloads`
   directories in Files. Do not put either directory on temporary container
   storage.
2. Give both directories to a dedicated non-root numeric UID/GID. Use those
   numbers for `MOTRIX_UID` and `MOTRIX_GID`; do not work around a mismatch by
   running as root.
3. Create a Compose project from [`compose.yaml`](../compose.yaml). The relative
   mounts resolve below the selected project directory. If fnOS only accepts
   pasted YAML, replace `${...}` entries with the desired literal values or add
   the same values through its environment editor.
4. Use `agalwood/motrix-server:latest` for stable automatic upgrades, or an
   immutable SemVer tag for controlled upgrades. Docker chooses `amd64` or
   `arm64` from the manifest.
5. Set `MOTRIX_PUBLIC_URL`, verify ports 8080 and 16801 are not already used,
   start the project, and wait for the health status before opening the Web UI.

fnOS share permissions and the container's Unix UID/GID must both allow writes.
If downloads appear in the container but not in Files, inspect the left-hand
bind path and confirm it points to the intended fnOS storage pool.

## Docker run

This is equivalent to the bind-mount Compose deployment:

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
  agalwood/motrix-server:latest
```

The image already defines its health check, non-root user, data paths, and
graceful `SIGTERM` behavior.

## Web, MDXP, token, and HTTPS boundaries

The default addresses are different services:

| Address | Purpose |
| --- | --- |
| `http://NAS_HOST:8080` | Web UI, operator RPC/API, and `GET /healthz` |
| `http://NAS_HOST:16801` | MDXP client base; unary `POST /mdxp`, event stream `GET /mdxp/events`, and device-code pairing |

`MOTRIX_PUBLIC_URL` is the externally reachable **Web approval URL** returned to
device-code clients. Do not set it to the MDXP port. On first start, Motrix
generates `/data/operator-token` at mode `0600`. With bind mounts, read it with:

```bash
cat motrix-data/operator-token
```

The same token is reused across restart and image replacement. You may set
`MOTRIX_OPERATOR_TOKEN` instead, but environment variables are visible in
container metadata; the generated file is the safer single-host default.

Do not expose plaintext HTTP directly to the Internet. Terminate HTTPS at a
trusted reverse proxy and firewall the origin ports. Proxy port 8080 as the Web
origin and preserve cookies, authorization headers, and streaming responses.
MDXP is a separate HTTP/SSE service: clients that access it remotely need a
separate TLS-enabled proxy/upstream to port 16801. Forwarding only port 8080 does
not publish MDXP, and forwarding only 16801 does not serve the approval UI.

## Download paths and plugins

The image defaults are:

```text
MOTRIX_DATA_DIR=/data
MOTRIX_TEMP_DIR=/data/tmp
MOTRIX_PLUGIN_DIR=/data/plugins
MOTRIX_DEFAULT_SAVE_DIR=/downloads
MOTRIX_ALLOWED_SAVE_DIRS=/downloads
HOME=/data/home
TMPDIR=/data/tmp
```

Startup creates and write-tests the data, temporary, torrent, home, plugin, and
download directories. A missing, read-only, or wrongly owned mount fails with
the affected absolute path. Every task save directory is checked again when
the task is created. `MOTRIX_ALLOWED_SAVE_DIRS` is a colon-separated list of
absolute, mounted roots; canonical path checks reject traversal and symlink
escapes.

To add an archive root, mount and allow it together:

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

Built-in plugins are read-only under `/app/builtin-plugins`. User-installed
packages, provenance, grants, configuration, logs, encrypted secrets, and
enablement state persist under `/data`. Web uploads of `.moext` packages and
normal registry/URL installs therefore survive a container replacement.

Operator-managed options are:

- `MOTRIX_PLUGIN_IMPORT_DIRS`: colon-separated, explicitly mounted read-only
  roots containing local packages.
- `MOTRIX_PLUGIN_INSTALL_URLS`: comma-separated or JSON-array HTTPS,
  `github:owner/repository`, or `registry:plugin.id` startup sources. Any failed
  source stops startup with its reason.
- `MOTRIX_ALLOW_UNMANAGED_PLUGINS=true`: allows manually copied plugin folders;
  it is off by default and unnecessary for normal installation.
- `MOTRIX_SECRETS_SEED`: optional 64-hex secret from an orchestrator secret
  store. Otherwise `/data/secrets.lockbox` is generated and persisted.

The official image does not include FFmpeg. A plugin that requires it needs a
derived image with Alpine's `ffmpeg` package and
`MOTRIX_FFMPEG_PATH=/usr/bin/ffmpeg`.

## Upgrade, rollback, backup, and restore

Before an upgrade, record the current image digest and back up `/data`. Stop the
service for a filesystem-level backup so SQLite and the aria2 session are
consistent:

```bash
docker compose stop server
tar -C . -czf "motrix-data-$(date +%Y%m%d).tar.gz" motrix-data
docker compose start server
```

Then pull and replace only the container:

```bash
docker compose pull server
docker compose up -d --wait
docker compose ps
```

The two mounts, generated operator token, downloads, aria2 state, and installed
plugins remain. For controlled upgrades, set `MOTRIX_IMAGE` to an immutable
SemVer tag or digest before pulling. Treat a new major version as a compatibility
boundary and read its release notes.

To roll back, select the previous immutable tag/digest and recreate the service.
If the newer version migrated persistent state, stop Motrix and restore the
matching `/data` backup before starting the older image; do not assume an older
binary can read state written by a newer release. Restore `/downloads` only when
your download backup policy requires it. Keep the database, operator token, and
`secrets.lockbox` from the same backup generation.

## Health, diagnostics, and troubleshooting

`GET /healthz` is public and succeeds only after the HTTP service and aria2 are
ready. Detailed diagnostics require the operator token:

```bash
TOKEN="$(cat motrix-data/operator-token)"
curl --fail http://127.0.0.1:8080/healthz
curl --fail \
  --header "Authorization: Bearer ${TOKEN}" \
  http://127.0.0.1:8080/api/diagnostics
docker compose logs --tail=200 server
```

Diagnostics report engine status, effective storage paths, allowed download
roots, runtime UID, plugin installation/secret-store status, and FFmpeg
detection.

| Symptom | Check and correction |
| --- | --- |
| Pull returns 404 or `manifest unknown` | Confirm the repository/tag spelling and that an image-bearing release exists. Try the same immutable tag on the other registry; do not substitute a similarly named third-party image. |
| `no matching manifest` | Confirm the NAS is 64-bit `amd64` or `arm64` with `docker info`; 32-bit ARM is unsupported. |
| Startup reports `EACCES`, read-only, or a path failure | Compare `docker inspect ... .Config.User` with numeric ownership of both mounts. Correct ownership/ACLs; do not run privileged or as root. |
| Port is already allocated | Change `MOTRIX_HTTP_PORT` or `MOTRIX_MDXP_PUBLIC_PORT`, and update `MOTRIX_PUBLIC_URL` if the Web port changes. |
| Web UI opens but unlock fails | Read the current persistent `/data/operator-token`; do not use a token copied from another deployment. Verify the file is regular, base64url text, and mode `0600`. |
| Download directory is rejected or files are missing from the NAS share | Use an absolute container path below `MOTRIX_ALLOWED_SAVE_DIRS`; verify the intended host directory is mounted at that exact path and writable by the runtime UID/GID. |
| Plugin install fails | Inspect `/api/diagnostics` and logs, retain `/data`, confirm package/source trust and network/TLS access, and mount any `MOTRIX_PLUGIN_IMPORT_DIRS` explicitly. Do not enable unmanaged plugins for a normal `.moext`, URL, or registry install. |
| Container is unhealthy after an upgrade | Inspect logs and diagnostics, verify both mounts, then roll back to the recorded immutable image and matching `/data` backup. |

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
| `MOTRIX_PUBLIC_URL` | unset | Externally reachable Web approval URL, not the MDXP URL |
| `MOTRIX_FFMPEG_PATH` | auto-detect | Optional absolute FFmpeg path |
| `MOTRIX_HOST_LANGUAGE` | system setting | Server/plugin locale override |
| `LOG_LEVEL` | `info` | Pino log level written to container stdout |

`MOTRIX_ARIA2_BIN`, `MOTRIX_EXTRA_DIR`, and `MOTRIX_RENDERER_DIR` are fixed by
the official image. Override them only in a custom image that provides the
corresponding artifacts.
