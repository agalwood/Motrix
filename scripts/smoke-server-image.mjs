import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { resolveSmokeContainerIdentity } from './smoke-server-identity.mjs'
import {
  resolveSmokeMode,
  resolveSmokePlatform,
} from './smoke-server-platform.mjs'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_LOG_BYTES = 256 * 1024
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const HTTP_FIXTURE_NAME = 'motrix-http-smoke.bin'
const PLUGIN_ID = 'test.demo-config'
const SEEDER_RPC_PORT = 16_801
const PLUGIN_FIXTURE = path.join(
  PROJECT_ROOT,
  'tests/fixtures/moext/test.demo-config-1.0.0.moext'
)
const TORRENT_FIXTURE = path.join(
  PROJECT_ROOT,
  'scripts/poc/fixtures/sample.torrent'
)
const TORRENT_DATA_ROOT = path.join(
  PROJECT_ROOT,
  'scripts/poc/fixtures/sample-data'
)
const TORRENT_DATA_FILE = path.join(TORRENT_DATA_ROOT, 'test.bin')
const HTTP_FIXTURE = Buffer.from(
  'Motrix Docker Server persistent HTTP fixture\n'.repeat(16_384)
)
const SEEDER_STATUS_PROBE = [
  "const response = await fetch('http://127.0.0.1:' + process.env.MOTRIX_SEEDER_RPC_PORT + '/jsonrpc', {",
  "method: 'POST',",
  "headers: {'content-type': 'application/json'},",
  "body: JSON.stringify({jsonrpc: '2.0', id: 'seed-status', method: 'aria2.tellActive', params: ['token:' + process.env.MOTRIX_SEEDER_RPC_SECRET, ['gid', 'status', 'totalLength', 'completedLength', 'bittorrent']]})",
  '})',
  "if (!response.ok) throw new Error('Seeder RPC returned ' + response.status)",
  'console.log(await response.text())',
].join('\n')
const TCP_PROBE = [
  "import { connect } from 'node:net'",
  'await new Promise((resolve, reject) => {',
  'const socket = connect({host: process.env.MOTRIX_SEEDER_HOST, port: Number(process.env.MOTRIX_SEEDER_PORT)})',
  "const timer = setTimeout(() => socket.destroy(new Error('Seeder TCP probe timed out')), 5000)",
  "socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve() })",
  "socket.once('error', (error) => { clearTimeout(timer); reject(error) })",
  '})',
].join(';')

function platformArgs(platform) {
  return platform ? ['--platform', platform] : []
}

async function docker(args, options = {}) {
  const result = await execFileAsync('docker', args, {
    encoding: 'utf8',
    maxBuffer: MAX_LOG_BYTES,
    ...options,
  })
  return result.stdout.trim()
}

async function dockerLogs(args) {
  const result = await execFileAsync('docker', args, {
    encoding: 'utf8',
    maxBuffer: MAX_LOG_BYTES,
  })
  return `${result.stdout}${result.stderr}`.trim()
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function containerPort(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const output = await docker(['port', name, '8080/tcp']).catch(() => '')
    const match = /^127\.0\.0\.1:(\d+)$/m.exec(output)
    if (match) return Number(match[1])
    await delay(100)
  }
  throw new Error('Docker did not publish the Server HTTP port')
}

async function containerExited(name) {
  const state = await docker([
    'inspect',
    '--format',
    '{{json .State}}',
    name,
  ]).catch(() => '')
  if (!state) return undefined
  const parsed = JSON.parse(state)
  return parsed.Running ? undefined : parsed
}

async function waitForHealth(name, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exited = await containerExited(name)
    if (exited) {
      throw new Error(
        `Server image exited before health check: code=${exited.ExitCode}`
      )
    }
    try {
      const response = await fetch(`${url}/healthz`)
      if (response.ok && (await response.json()).ok === true) return
    } catch {
      // Container startup is still in progress.
    }
    await delay(150)
  }
  throw new Error(`Server image did not become healthy within ${timeoutMs}ms`)
}

async function waitForDockerHealth(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await docker([
      'inspect',
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{end}}',
      name,
    ])
    if (value === 'healthy') return
    if (value === 'unhealthy') {
      throw new Error('Docker HEALTHCHECK marked the Server unhealthy')
    }
    await delay(250)
  }
  throw new Error('Docker HEALTHCHECK did not become healthy in time')
}

async function waitForExit(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await containerExited(name)
    if (state) return state
    await delay(100)
  }
  throw new Error(`Container ${name} did not exit within ${timeoutMs}ms`)
}

async function querySeederDownloads(name, rpcSecret) {
  const output = await docker([
    'exec',
    '--env',
    `MOTRIX_SEEDER_RPC_PORT=${SEEDER_RPC_PORT}`,
    '--env',
    `MOTRIX_SEEDER_RPC_SECRET=${rpcSecret}`,
    name,
    'node',
    '--input-type=module',
    '--eval',
    SEEDER_STATUS_PROBE,
  ])
  const response = JSON.parse(output)
  if (response.error) {
    throw new Error(`Seeder RPC failed: ${JSON.stringify(response.error)}`)
  }
  if (!Array.isArray(response.result)) {
    throw new Error(`Seeder RPC returned invalid result: ${output}`)
  }
  return response.result
}

async function waitForSeeder(name, rpcSecret, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let lastStatus = 'RPC unavailable'
  while (Date.now() < deadline) {
    const exited = await containerExited(name)
    if (exited) {
      throw new Error(`Seeder exited before readiness: code=${exited.ExitCode}`)
    }
    try {
      const downloads = await querySeederDownloads(name, rpcSecret)
      if (downloads.length !== 1) {
        lastStatus = `active downloads=${downloads.length}`
      } else {
        const [download] = downloads
        lastStatus = JSON.stringify({
          completedLength: download.completedLength,
          gid: download.gid,
          status: download.status,
          totalLength: download.totalLength,
        })
        if (
          download.status === 'active' &&
          download.bittorrent &&
          /^[1-9][0-9]*$/.test(download.totalLength) &&
          download.completedLength === download.totalLength
        ) {
          return download
        }
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error)
    }
    await delay(200)
  }
  throw new Error(`Seeder did not become ready: ${lastStatus}`)
}

async function assertSeederReachable(name, seedIp, timeoutMs) {
  await docker(
    [
      'exec',
      '--env',
      `MOTRIX_SEEDER_HOST=${seedIp}`,
      '--env',
      'MOTRIX_SEEDER_PORT=6881',
      name,
      'node',
      '--input-type=module',
      '--eval',
      TCP_PROBE,
    ],
    { timeout: Math.min(timeoutMs, 10_000) }
  )
}

async function requestJson(url, options = {}, expectedStatus) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  const accepted = expectedStatus
    ? response.status === expectedStatus
    : response.ok
  if (!accepted) {
    throw new Error(
      `${options.method ?? 'GET'} ${url} returned ${response.status}: ${text}`
    )
  }
  return body
}

async function rpc(url, token, kind, channel, ...args) {
  return requestJson(`${url}/rpc/${kind}/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ args }),
  })
}

async function assertOperatorAuth(url, token) {
  await requestJson(
    `${url}/rpc/query/image-smoke`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    },
    401
  )
  const status = await requestJson(`${url}/rpc/auth/status`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (status.authed !== true) {
    throw new Error('Docker image operator authentication failed')
  }
  await requestJson(
    `${url}/rpc/query/image-smoke`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ args: [] }),
    },
    404
  )
}

function compactPeer(ip, port) {
  const octets = ip.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    throw new Error(`invalid Docker peer IPv4 address: ${ip}`)
  }
  const peer = Buffer.alloc(6)
  for (let index = 0; index < 4; index += 1) peer[index] = octets[index]
  peer.writeUInt16BE(port, 4)
  return peer
}

function trackerResponse(peer) {
  if (!peer) return Buffer.from('d8:intervali1e5:peers0:e')
  return Buffer.concat([
    Buffer.from('d8:intervali1e5:peers6:'),
    compactPeer(peer.ip, peer.port),
    Buffer.from('e'),
  ])
}

function rewriteTorrentAnnounce(torrent, trackerUrl) {
  const marker = Buffer.from('d8:announce')
  if (!torrent.subarray(0, marker.byteLength).equals(marker)) {
    throw new Error('BT fixture does not begin with a top-level announce key')
  }
  const colon = torrent.indexOf(0x3a, marker.byteLength)
  const previousLength = Number(
    torrent.subarray(marker.byteLength, colon).toString('ascii')
  )
  if (
    colon < 0 ||
    !Number.isSafeInteger(previousLength) ||
    previousLength < 1
  ) {
    throw new Error('BT fixture has an invalid announce value')
  }
  const nextValue = Buffer.from(trackerUrl)
  return Buffer.concat([
    marker,
    Buffer.from(`${nextValue.byteLength}:`),
    nextValue,
    torrent.subarray(colon + 1 + previousLength),
  ])
}

function parseRange(value, size) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(value ?? '')
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isSafeInteger(start) || start < 0 || start > end) return null
  return { start, end }
}

async function startFixtureServer() {
  let trackerPeer = null
  let trackerAnnounces = 0
  const trackerPeerIds = new Set()
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://fixture.invalid')
    if (requestUrl.pathname === '/announce') {
      trackerAnnounces += 1
      const peerId = /(?:^|[?&])peer_id=([^&]+)/.exec(request.url ?? '')?.[1]
      if (peerId) trackerPeerIds.add(peerId)
      const body = trackerResponse(trackerPeer)
      response.writeHead(200, {
        'content-length': body.byteLength,
        'content-type': 'text/plain',
      })
      response.end(body)
      return
    }
    if (requestUrl.pathname !== `/${HTTP_FIXTURE_NAME}`) {
      response.writeHead(404).end()
      return
    }

    const range = parseRange(request.headers.range, HTTP_FIXTURE.byteLength)
    const body = range
      ? HTTP_FIXTURE.subarray(range.start, range.end + 1)
      : HTTP_FIXTURE
    response.writeHead(range ? 206 : 200, {
      'accept-ranges': 'bytes',
      'content-disposition': `attachment; filename="${HTTP_FIXTURE_NAME}"`,
      'content-length': body.byteLength,
      'content-type': 'application/octet-stream',
      ...(range
        ? {
            'content-range': `bytes ${range.start}-${range.end}/${HTTP_FIXTURE.byteLength}`,
          }
        : {}),
    })
    if (request.method === 'HEAD') response.end()
    else response.end(body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('HTTP fixture server did not bind a TCP port')
  }
  return {
    port: address.port,
    setTrackerPeer(peer) {
      trackerPeer = peer
    },
    trackerAnnounces() {
      return trackerAnnounces
    },
    trackerPeerIds() {
      return trackerPeerIds
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  }
}

const RUNTIME_PROBE = [
  "import { createRequire } from 'node:module'",
  "const require = createRequire('/app/package.json')",
  "const manifest = require('/app/package.json')",
  'for (const name of Object.keys(manifest.dependencies).sort()) import.meta.resolve(name)',
  "const Database = require('better-sqlite3')",
  "const memory = new Database(':memory:')",
  "memory.exec('CREATE TABLE smoke(value TEXT)')",
  "memory.prepare('INSERT INTO smoke(value) VALUES (?)').run('memory-ok')",
  "if (memory.prepare('SELECT value FROM smoke').get().value !== 'memory-ok') process.exit(2)",
  'memory.close()',
  "const file = '/data/image-smoke.db'",
  'const disk = new Database(file)',
  "disk.exec('CREATE TABLE smoke(value TEXT)')",
  "disk.prepare('INSERT INTO smoke(value) VALUES (?)').run('disk-ok')",
  'disk.close()',
  'const reopened = new Database(file)',
  "if (reopened.prepare('SELECT value FROM smoke').get().value !== 'disk-ok') process.exit(3)",
  'reopened.close()',
].join(';')

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (index === 0 && argument === '--') continue
    if (!argument.startsWith('--'))
      throw new Error(`unknown argument: ${argument}`)
    const key = argument.slice(2)
    if (!['image', 'mode', 'platform', 'timeout-ms'].includes(key)) {
      throw new Error(`unknown option: --${key}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`)
    }
    options[key] = value
    index += 1
  }
  if (!options.image) throw new Error('--image is required')
  resolveSmokeMode(options.mode)
  resolveSmokePlatform(options.platform)
  return options
}

async function prepareHostVolumes(root) {
  const dataDir = path.join(root, 'data')
  const downloadsDir = path.join(root, 'downloads')
  const deniedDataDir = path.join(root, 'denied-data')
  await Promise.all([mkdir(dataDir), mkdir(downloadsDir), mkdir(deniedDataDir)])
  await Promise.all([
    chmod(dataDir, 0o777),
    chmod(downloadsDir, 0o777),
    chmod(deniedDataDir, 0o777),
  ])
  return { dataDir, downloadsDir, deniedDataDir }
}

async function startServerContainer(options) {
  const {
    name,
    network,
    image,
    dataDir,
    downloadsDir,
    operatorToken,
    identity,
    platform,
  } = options
  await docker([
    'run',
    ...platformArgs(platform),
    '--detach',
    '--name',
    name,
    '--network',
    network,
    '--add-host',
    'host.docker.internal:host-gateway',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    identity.user,
    '--env',
    `MOTRIX_OPERATOR_TOKEN=${operatorToken}`,
    '--env',
    'MOTRIX_MDXP_PORT=0',
    '--mount',
    `type=bind,source=${dataDir},target=/data`,
    '--mount',
    `type=bind,source=${downloadsDir},target=/downloads`,
    '--publish',
    '127.0.0.1::8080',
    image,
  ])
  const port = await containerPort(name, options.timeoutMs)
  const url = `http://127.0.0.1:${port}`
  await waitForHealth(name, url, options.timeoutMs)
  return url
}

async function assertRuntimeContract(name, url, token, identity, timeoutMs) {
  await assertOperatorAuth(url, token)
  const operatorCliOutput = await docker([
    'exec',
    name,
    'motrix-admin',
    'pairing',
    'pending',
    '--json',
  ])
  const operatorCli = JSON.parse(operatorCliOutput)
  if (operatorCli.ok !== true || !Array.isArray(operatorCli.requests)) {
    throw new Error(`unexpected motrix-admin response: ${operatorCliOutput}`)
  }
  const diagnostics = await requestJson(`${url}/api/diagnostics`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (
    diagnostics.health?.ok !== true ||
    diagnostics.engine?.state !== 'ready' ||
    !/-motrix\.\d+$/.test(diagnostics.engine?.featureReport?.version ?? '') ||
    diagnostics.engine?.featureReport?.hasSqlitePersistence !== true ||
    !diagnostics.engine?.featureReport?.features?.includes(
      'SQLite3-Persistence'
    ) ||
    diagnostics.process?.uid !== identity.uid ||
    diagnostics.storage?.dataDir !== '/data' ||
    diagnostics.storage?.tempDir !== '/data/tmp' ||
    diagnostics.storage?.homeDir !== '/data/home' ||
    diagnostics.storage?.defaultSaveDir !== '/downloads' ||
    !diagnostics.storage?.allowedSaveDirs?.includes('/downloads') ||
    diagnostics.plugins?.directory !== '/data/plugins' ||
    diagnostics.plugins?.installAvailable !== true ||
    diagnostics.plugins?.secretStoreAvailable !== true ||
    diagnostics.media?.tempDir !== '/data/tmp' ||
    !Array.isArray(diagnostics.media?.ffmpeg?.candidates)
  ) {
    throw new Error(
      `unexpected Server diagnostics: ${JSON.stringify(diagnostics)}`
    )
  }
  await docker([
    'exec',
    name,
    'sh',
    '-ec',
    [
      `[ "$(id -u)" = "${identity.uid}" ]`,
      `[ "$(id -g)" = "${identity.gid}" ]`,
      'test -w /data',
      'test -w /downloads',
      'test -w /data/tmp',
      'test ! -w /app',
      'test -s /app/LICENSE',
      'test -s /app/THIRD_PARTY_NOTICES.md',
      'test -s /data/motrix.db',
      'test "$MOTRIX_ARIA2_BIN" = "/app/bin/aria2c"',
      'test "$SSL_CERT_FILE" = "/etc/ssl/certs/ca-certificates.crt"',
      'test -s "$SSL_CERT_FILE"',
      'test ! -e /usr/bin/aria2c',
      "aria2c --version | grep -F -- 'SQLite3-Persistence'",
      'pidof aria2c',
      "aria2_pid=$(for pid in $(pidof aria2c); do tr '\\0' '\\n' </proc/$pid/cmdline | grep -Fxq -- '--conf-path=/data/aria2.conf' && { echo $pid; break; }; done)",
      'test -n "$aria2_pid"',
      'test "$(readlink /proc/$aria2_pid/exe)" = "/app/bin/aria2c"',
      "tr '\\0' '\\n' </proc/$aria2_pid/cmdline | grep -Fx -- '--rpc-listen-all=false'",
      "tr '\\0' '\\n' </proc/$aria2_pid/cmdline | grep -Fx -- '--dht-file-path=/data/dht.dat'",
      "tr '\\0' '\\n' </proc/$aria2_pid/cmdline | grep -Fx -- '--dht-file-path6=/data/dht6.dat'",
    ].join('; '),
  ])
  const hostConfig = JSON.parse(
    await docker(['inspect', '--format', '{{json .HostConfig}}', name])
  )
  if (hostConfig.ReadonlyRootfs !== true) {
    throw new Error('Server container did not use a read-only root filesystem')
  }
  await docker([
    'exec',
    name,
    'node',
    '--input-type=module',
    '--eval',
    RUNTIME_PROBE,
  ])
  await waitForDockerHealth(name, timeoutMs)
  return diagnostics
}

async function waitForTask(url, token, taskId, accepted, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastTask
  while (Date.now() < deadline) {
    const tasks = await rpc(url, token, 'query', 'query:listTasks')
    const task = tasks.find((candidate) => candidate.id === taskId)
    lastTask = task
    if (task?.status === 'error') {
      throw new Error(
        `task ${taskId} failed: ${task.errorMessage ?? task.errorCode ?? 'unknown'}`
      )
    }
    if (task && accepted.has(task.status)) return task
    await delay(250)
  }
  const progress = lastTask
    ? {
        downloadedBytes: lastTask.downloadedBytes,
        downloadSpeed: lastTask.downloadSpeed,
        engineTaskId: lastTask.engineTaskId,
        progress: lastTask.progress,
        status: lastTask.status,
        totalBytes: lastTask.totalBytes,
        uploadSpeed: lastTask.uploadSpeed,
      }
    : { status: 'missing' }
  throw new Error(
    `task ${taskId} did not reach ${[...accepted].join('/')}; last=${JSON.stringify(progress)}`
  )
}

async function assertHostFile(target, expected) {
  const actual = await readFile(target)
  if (!actual.equals(expected)) {
    throw new Error(`downloaded file content mismatch: ${target}`)
  }
}

async function assertDirectoryEmpty(target) {
  let entries
  try {
    entries = await readdir(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (entries.length > 0) {
    throw new Error(`temporary plugin directory is not empty: ${target}`)
  }
}

async function installPlugin(url, token) {
  const initialPlugins = await rpc(url, token, 'query', 'query:listPlugins')
  if (!initialPlugins.some((plugin) => plugin.source?.type === 'builtin')) {
    throw new Error(
      'Server image did not discover its read-only builtin plugins'
    )
  }
  const bytes = await readFile(PLUGIN_FIXTURE)
  const fileHash = sha256(bytes)
  const reference = await requestJson(
    `${url}/api/plugins/uploads`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/vnd.motrix.moext',
        'x-motrix-file-name': encodeURIComponent(path.basename(PLUGIN_FIXTURE)),
        'x-motrix-file-sha256': fileHash,
      },
      body: bytes,
    },
    201
  )
  const staged = await rpc(url, token, 'command', 'command:installPlugin', {
    sourceType: 'upload',
    uploadId: reference.uploadId,
    fileHash,
  })
  if (staged.committed !== false || !staged.stagingId) {
    throw new Error(
      `plugin did not enter consent staging: ${JSON.stringify(staged)}`
    )
  }
  const committed = await rpc(
    url,
    token,
    'command',
    'command:confirmPluginInstall',
    { stagingId: staged.stagingId, grants: { notify: 'denied' } }
  )
  if (committed.pluginId !== PLUGIN_ID) {
    throw new Error(`unexpected committed plugin: ${JSON.stringify(committed)}`)
  }
  await rpc(url, token, 'command', 'command:disablePlugin', PLUGIN_ID)
  await rpc(url, token, 'command', 'command:enablePlugin', PLUGIN_ID)
  const secret = 'docker-smoke-secret-value'
  await rpc(url, token, 'command', 'command:updatePluginConfig', {
    pluginId: PLUGIN_ID,
    patch: { apiKey: secret, quality: '720p' },
  })
  const plugins = await rpc(url, token, 'query', 'query:listPlugins')
  const plugin = plugins.find((candidate) => candidate.id === PLUGIN_ID)
  if (!plugin?.enabled) {
    throw new Error(
      `installed plugin is not enabled: ${JSON.stringify(plugin)}`
    )
  }
  const config = await rpc(
    url,
    token,
    'query',
    'query:getPluginConfig',
    PLUGIN_ID
  )
  if (config.quality !== '720p' || !config.apiKey?.startsWith('box:')) {
    throw new Error(
      `plugin configuration was not encrypted: ${JSON.stringify(config)}`
    )
  }
  return { fileHash, secret }
}

async function stopServer(name, timeoutMs) {
  await docker(['stop', '--time', String(Math.ceil(timeoutMs / 1000)), name])
  const state = JSON.parse(
    await docker(['inspect', '--format', '{{json .State}}', name])
  )
  if (state.Running || state.ExitCode !== 0 || state.OOMKilled) {
    throw new Error(
      `Server image shutdown failed: running=${state.Running} code=${state.ExitCode} oom=${state.OOMKilled}`
    )
  }
}

async function assertPermissionFailure(options) {
  const name = `${options.name}-permission`
  let created = false
  try {
    await docker([
      'run',
      ...platformArgs(options.platform),
      '--detach',
      '--name',
      name,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--user',
      options.identity.user,
      '--env',
      'MOTRIX_OPERATOR_TOKEN=permission-smoke-token',
      '--env',
      'MOTRIX_MDXP_PORT=0',
      '--mount',
      `type=bind,source=${options.dataDir},target=/data`,
      '--mount',
      `type=bind,source=${options.downloadsDir},target=/downloads,readonly`,
      options.image,
    ])
    created = true
    const state = await waitForExit(name, Math.min(options.timeoutMs, 20_000))
    const logs = await dockerLogs(['logs', name])
    if (
      state.ExitCode === 0 ||
      !logs.includes('Save directory is not writable: /downloads')
    ) {
      throw new Error(
        `read-only downloads mount did not fail clearly: code=${state.ExitCode}\n${logs}`
      )
    }
  } finally {
    if (created) await docker(['rm', '--force', name]).catch(() => undefined)
  }
}

function imageSmokeSummary(metadata, diagnostics, identity, startedAt) {
  return {
    imageId: metadata.Id,
    imageBytes: metadata.Size,
    architecture: metadata.Architecture,
    node: metadata.Config.Env.find((entry) =>
      entry.startsWith('NODE_VERSION=')
    )?.slice('NODE_VERSION='.length),
    nonRootUid: diagnostics.process.uid,
    nonRootGid: identity.gid,
    readOnlyRootfs: true,
    health: true,
    operatorAuth: true,
    diagnostics: true,
    sqlite: true,
    motrixAria2Fork: true,
    defaultSaveDir: '/downloads',
    shutdown: 'SIGTERM',
    durationMs: Date.now() - startedAt,
  }
}

export async function smokeServerImage(options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000) {
    throw new Error('Server image smoke timeout must be at least 30000ms')
  }
  const image = options.image
  const mode = resolveSmokeMode(options.mode)
  const platform = resolveSmokePlatform(options.platform)
  const identity = resolveSmokeContainerIdentity()
  const prefix = `motrix-server-smoke-${process.pid}-${Date.now()}`
  const appName = `${prefix}-app`
  const seedName = `${prefix}-seed`
  const network = `${prefix}-net`
  const operatorToken = 'motrix-image-smoke-operator-token'
  const startedAt = Date.now()
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'motrix-image-smoke-'))
  const fixtureServer = await startFixtureServer()
  const volumes = await prepareHostVolumes(tempRoot)
  let appCreated = false
  let seedCreated = false
  let networkCreated = false
  try {
    if (platform) await docker(['pull', '--platform', platform, image])
    const metadata = JSON.parse(
      // `docker image inspect --platform` requires a newer Docker CLI than the
      // GitHub-hosted Ubuntu runners consistently provide. The preceding
      // platform-pinned pull selects the local image; the architecture check
      // below remains the fail-closed platform assertion.
      await docker(['image', 'inspect', image])
    )[0]
    if (metadata.Config.User !== 'node') {
      throw new Error(
        `Server image default user is ${metadata.Config.User || 'root'}`
      )
    }
    if (!metadata.Config.Healthcheck) {
      throw new Error('Server image has no Docker HEALTHCHECK')
    }
    if (platform && metadata.Architecture !== platform.split('/')[1]) {
      throw new Error(
        `Server image architecture is ${metadata.Architecture}, expected ${platform}`
      )
    }

    await docker(['network', 'create', network])
    networkCreated = true
    const trackerUrl = `http://host.docker.internal:${fixtureServer.port}/announce`
    const torrentBytes = rewriteTorrentAnnounce(
      await readFile(TORRENT_FIXTURE),
      trackerUrl
    )
    const seedRoot = path.join(tempRoot, 'seed')
    const seederRpcSecret = randomBytes(24).toString('hex')
    await mkdir(seedRoot)
    await cp(TORRENT_DATA_ROOT, path.join(seedRoot, 'sample-data'), {
      recursive: true,
    })
    const localTorrentPath = path.join(seedRoot, 'sample.torrent')
    await writeFile(localTorrentPath, torrentBytes)
    await docker([
      'run',
      ...platformArgs(platform),
      '--detach',
      '--name',
      seedName,
      '--network',
      network,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--mount',
      `type=bind,source=${seedRoot},target=/seed,readonly`,
      image,
      'aria2c',
      '--no-conf=true',
      '--enable-dht=false',
      '--enable-dht6=false',
      '--bt-enable-lpd=false',
      '--enable-peer-exchange=false',
      '--enable-rpc=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${SEEDER_RPC_PORT}`,
      `--rpc-secret=${seederRpcSecret}`,
      '--allow-overwrite=true',
      '--check-integrity=true',
      '--file-allocation=none',
      `--bt-tracker=${trackerUrl}`,
      '--listen-port=6881',
      '--seed-time=120',
      '--seed-ratio=0.0',
      '--dir=/seed',
      '/seed/sample.torrent',
    ])
    seedCreated = true
    await waitForSeeder(seedName, seederRpcSecret, timeoutMs)
    const seedIp = await docker([
      'inspect',
      '--format',
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      seedName,
    ])
    fixtureServer.setTrackerPeer({ ip: seedIp, port: 6881 })

    let url = await startServerContainer({
      name: appName,
      network,
      image,
      ...volumes,
      operatorToken,
      identity,
      platform,
      timeoutMs,
    })
    appCreated = true
    const diagnostics = await assertRuntimeContract(
      appName,
      url,
      operatorToken,
      identity,
      timeoutMs
    )
    await assertSeederReachable(appName, seedIp, timeoutMs)

    if (mode === 'health') {
      await stopServer(appName, timeoutMs)
      await docker(['rm', appName])
      appCreated = false
      return {
        ...imageSmokeSummary(metadata, diagnostics, identity, startedAt),
        mode,
      }
    }

    const settings = await rpc(url, operatorToken, 'query', 'query:getSettings')
    const allowed = await rpc(
      url,
      operatorToken,
      'query',
      'query:listAllowedSaveDirs'
    )
    if (
      settings.app?.defaultSaveDir !== '/downloads' ||
      allowed.defaultPath !== '/downloads' ||
      allowed.paths?.[0]?.path !== '/downloads' ||
      allowed.allowCustom !== false
    ) {
      throw new Error(
        `Docker default save contract is wrong: ${JSON.stringify(allowed)}`
      )
    }

    const httpTask = await rpc(
      url,
      operatorToken,
      'command',
      'command:createTask',
      {
        type: 'http',
        uris: [
          `http://host.docker.internal:${fixtureServer.port}/${HTTP_FIXTURE_NAME}`,
        ],
        saveDir: settings.app.defaultSaveDir,
        filename: HTTP_FIXTURE_NAME,
        headers: [],
      }
    )
    await waitForTask(
      url,
      operatorToken,
      httpTask.taskId,
      new Set(['completed']),
      timeoutMs
    )
    await assertHostFile(
      path.join(volumes.downloadsDir, HTTP_FIXTURE_NAME),
      HTTP_FIXTURE
    )

    const btTask = await rpc(
      url,
      operatorToken,
      'command',
      'command:createTask',
      {
        type: 'bt',
        payload: {
          kind: 'torrent-base64',
          base64: torrentBytes.toString('base64'),
        },
        selectedFiles: [0],
        saveDir: '/downloads',
        displayName: 'sample-data',
      }
    )
    const finalBtTask = await waitForTask(
      url,
      operatorToken,
      btTask.taskId,
      new Set(['seeding', 'completed']),
      timeoutMs
    )
    await assertHostFile(
      path.join(volumes.downloadsDir, 'sample-data', 'test.bin'),
      await readFile(TORRENT_DATA_FILE)
    )
    if (
      await pathExists(
        path.join(volumes.downloadsDir, 'sample-data', 'sample-data')
      )
    ) {
      throw new Error('BT output retained the duplicated torrent root')
    }
    await rpc(url, operatorToken, 'command', 'command:setTaskBtTracker', {
      engineGid: finalBtTask.engineTaskId,
      trackers: [trackerUrl],
    })
    if (
      fixtureServer.trackerAnnounces() < 2 ||
      fixtureServer.trackerPeerIds().size < 2
    ) {
      throw new Error('Motrix BT task never announced to the fixture tracker')
    }

    const pluginInstall = await installPlugin(url, operatorToken)
    const installRecord = JSON.parse(
      await readFile(
        path.join(volumes.dataDir, 'plugins', PLUGIN_ID, '_install.json'),
        'utf8'
      )
    )
    if (
      installRecord.pluginId !== PLUGIN_ID ||
      installRecord.source?.type !== 'local' ||
      installRecord.source?.url !== `local:${pluginInstall.fileHash}`
    ) {
      throw new Error(
        `plugin install provenance was not persisted: ${JSON.stringify(installRecord)}`
      )
    }
    await Promise.all(
      ['_uploads', '_downloads', '_staging'].map((directory) =>
        assertDirectoryEmpty(path.join(volumes.dataDir, 'plugins', directory))
      )
    )
    const settingsRaw = await readFile(
      path.join(volumes.dataDir, 'settings.json'),
      'utf8'
    )
    if (
      settingsRaw.includes(pluginInstall.secret) ||
      !settingsRaw.includes('box:')
    ) {
      throw new Error('plugin secret was not encrypted at rest')
    }
    const lockbox = await readFile(
      path.join(volumes.dataDir, 'secrets.lockbox')
    )
    if (lockbox.byteLength !== 32) {
      throw new Error('plugin lockbox is invalid')
    }

    await stopServer(appName, timeoutMs)
    await docker(['rm', appName])
    appCreated = false
    for (const durable of [
      'motrix.db',
      'settings.json',
      'secrets.lockbox',
      'aria2.session',
      'aria2.conf',
    ]) {
      if (!(await pathExists(path.join(volumes.dataDir, durable)))) {
        throw new Error(
          `missing durable Server state after shutdown: ${durable}`
        )
      }
    }

    url = await startServerContainer({
      name: appName,
      network,
      image,
      ...volumes,
      operatorToken,
      identity,
      platform,
      timeoutMs,
    })
    appCreated = true
    const restoredTasks = await rpc(
      url,
      operatorToken,
      'query',
      'query:listTasks'
    )
    for (const taskId of [httpTask.taskId, btTask.taskId]) {
      if (!restoredTasks.some((task) => task.id === taskId)) {
        throw new Error(`task ${taskId} did not survive container restart`)
      }
    }
    const restoredPlugins = await rpc(
      url,
      operatorToken,
      'query',
      'query:listPlugins'
    )
    const restoredPlugin = restoredPlugins.find(
      (plugin) => plugin.id === PLUGIN_ID
    )
    if (!restoredPlugin?.enabled) {
      throw new Error(
        `plugin did not survive restart: ${JSON.stringify(restoredPlugin)}`
      )
    }
    const restoredConfig = await rpc(
      url,
      operatorToken,
      'query',
      'query:getPluginConfig',
      PLUGIN_ID
    )
    if (
      !restoredConfig.apiKey?.startsWith('box:') ||
      restoredConfig.quality !== '720p'
    ) {
      throw new Error('plugin configuration did not survive restart')
    }
    await rpc(url, operatorToken, 'command', 'command:uninstallPlugin', {
      pluginId: PLUGIN_ID,
    })
    const afterUninstall = await rpc(
      url,
      operatorToken,
      'query',
      'query:listPlugins'
    )
    if (afterUninstall.some((plugin) => plugin.id === PLUGIN_ID)) {
      throw new Error('plugin remained discoverable after uninstall')
    }
    if (await pathExists(path.join(volumes.dataDir, 'plugins', PLUGIN_ID))) {
      throw new Error('plugin directory remained after uninstall')
    }
    const afterUninstallSettings = JSON.parse(
      await readFile(path.join(volumes.dataDir, 'settings.json'), 'utf8')
    )
    if (Object.hasOwn(afterUninstallSettings.plugins ?? {}, PLUGIN_ID)) {
      throw new Error('plugin configuration remained after uninstall')
    }

    await stopServer(appName, timeoutMs)
    await docker(['rm', appName])
    appCreated = false
    await assertPermissionFailure({
      name: prefix,
      image,
      dataDir: volumes.deniedDataDir,
      downloadsDir: volumes.downloadsDir,
      identity,
      platform,
      timeoutMs,
    })

    return {
      ...imageSmokeSummary(metadata, diagnostics, identity, startedAt),
      mode,
      httpDownload: sha256(HTTP_FIXTURE),
      btDownload: sha256(await readFile(TORRENT_DATA_FILE)),
      restartPersistence: true,
      pluginLifecycle: 'install-enable-restart-uninstall',
      pluginSecretLockbox: true,
      permissionFailure: true,
    }
  } catch (error) {
    const appLogs = appCreated
      ? await dockerLogs(['logs', '--tail', '200', appName]).catch(() => '')
      : ''
    const seedLogs = seedCreated
      ? await dockerLogs(['logs', '--tail', '100', seedName]).catch(() => '')
      : ''
    const message = error instanceof Error ? error.message : String(error)
    const logs = [
      seedCreated &&
        `Fixture tracker: announces=${fixtureServer.trackerAnnounces()} peerIds=${fixtureServer.trackerPeerIds().size}`,
      appLogs && `Server logs:\n${appLogs}`,
      seedLogs && `Seeder logs:\n${seedLogs}`,
    ]
      .filter(Boolean)
      .join('\n')
    throw new Error(
      logs ? `${message}\n${logs.slice(-MAX_LOG_BYTES)}` : message,
      { cause: error }
    )
  } finally {
    if (appCreated) {
      await docker(['rm', '--force', appName]).catch(() => undefined)
    }
    if (seedCreated) {
      await docker(['rm', '--force', seedName]).catch(() => undefined)
    }
    if (networkCreated) {
      await docker(['network', 'rm', network]).catch(() => undefined)
    }
    await fixtureServer.close().catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const raw = parseArguments(process.argv.slice(2))
  smokeServerImage({
    image: raw.image,
    mode: raw.mode,
    platform: raw.platform,
    timeoutMs: raw['timeout-ms']
      ? Number.parseInt(raw['timeout-ms'], 10)
      : undefined,
  })
    .then((result) => {
      console.log(`Server image smoke passed: ${JSON.stringify(result)}`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
