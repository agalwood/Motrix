import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  access,
  chmod,
  chown,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer, request } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { 'project-dir': { type: 'string' } },
})
const project = path.resolve(values['project-dir'])
const { Methods, TaskGetResultSchema } = await import(
  pathToFileURL(
    path.join(project, 'app/server/node_modules/@motrix/mdxp/dist/index.js')
  ).href
)
if (process.platform !== 'linux')
  throw new Error('fnOS lifecycle smoke requires Linux /proc and flock')
// Root preparation is tested only inside a disposable container: never change
// local users or /run service state on a developer machine or a live NAS.
if (process.geteuid() !== 0)
  throw new Error(
    'fnOS lifecycle smoke requires root in a disposable Linux container'
  )
await access('/.dockerenv')
const authorityRuntime = '/run/motrix-account-authority'
if (await stat(authorityRuntime).catch(() => null))
  throw new Error('Account authority already exists')
execFileSync('groupadd', ['--gid', '1600', 'motrix'])
execFileSync('groupadd', ['--gid', '1601', 'TrimApiUsers'])
execFileSync('useradd', [
  '--uid',
  '1600',
  '--gid',
  '1600',
  '--groups',
  'TrimApiUsers',
  'motrix',
])
execFileSync('groupadd', ['--gid', '1700', 'Administrators'])
execFileSync('useradd', [
  '--uid',
  '1700',
  '--gid',
  '1600',
  '--groups',
  'Administrators',
  'alice',
])
const changePassword = () =>
  execFileSync('chpasswd', [], {
    input: `alice:${randomBytes(32).toString('hex')}\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
  })
changePassword()
const root = await mkdtemp('/tmp/mtx-fpk-')
await chmod(root, 0o755)
const target = path.join(root, 'target')
const data = path.join(root, 'var')
const downloads = path.join(root, 'downloads')
const apiSocket = path.join(root, 'api.sock')
const env = {
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
  TRIM_APPDEST: target,
  TRIM_PKGVAR: data,
  TRIM_DATA_SHARE_PATHS: downloads,
  TRIM_API_TOKEN: 'smoke-token',
  TRIM_TEMP_LOGFILE: path.join(root, 'error.log'),
  MOTRIX_FNOS_API_SOCKET: apiSocket,
  wizard_client_port: '16812',
}
const aclUsers = []
let allowWrites = true
let allowDeletes = true
const payload = randomBytes(256 * 1024)
const fixtureServer = createServer((_req, res) => {
  res.writeHead(200, {
    'content-length': payload.length,
    'accept-ranges': 'bytes',
  })
  res.end(payload)
})
const api = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  if (body.req === 'trim.file.checkUserACL') aclUsers.push(body.data.uid)
  const value =
    body.req === 'trim.file.getSharedAccessibleFolders'
      ? { paths: [downloads] }
      : body.data.path.map((entry) => ({
          path: entry,
          readable: true,
          writable: allowWrites,
          deletable: allowDeletes,
        }))
  res.setHeader('content-type', 'application/json')
  res.end(
    JSON.stringify({
      code: req.headers.authorization === 'Bearer smoke-token' ? 0 : 1,
      data: value,
    })
  )
})
const lifecycle = (action) =>
  new Promise((resolve, reject) => {
    // Only this disposable fixture uses shell tracing. Its environment contains
    // synthetic credentials; output is retained solely for failure diagnostics.
    const child = spawn('bash', ['-x', path.join(root, 'cmd/main'), action], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), 75_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
async function requireLifecycle(action) {
  const result = await lifecycle(action)
  if (result.code !== 0) {
    const helperLog = await readFile(
      path.join(authorityRuntime, 'authority.log'),
      'utf8'
    ).catch(() => '')
    const serverLog = await readFile(
      path.join(data, 'server.log'),
      'utf8'
    ).catch(() => '')
    throw new Error(
      `Lifecycle ${action} failed: ${result.output}\n${helperLog.slice(-2000)}\n${serverLog.slice(-8000)}`
    )
  }
  if (action === 'start') {
    // Gateway readiness precedes the optional client listener. Wait for it
    // before testing CLI/Extension behavior, including on emulated runners.
    const deadline = Date.now() + 15_000
    for (;;) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${env.wizard_client_port}/discovery`,
          {
            signal: AbortSignal.timeout(1000),
          }
        )
        await response.arrayBuffer()
        break
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
}
const get = (route, headers = {}, method = 'GET', body) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: path.join(target, 'app.sock'),
        path: route,
        headers,
        method,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      }
    )
    req
      .on('error', reject)
      .end(body === undefined ? undefined : JSON.stringify(body))
  })
try {
  await cp(path.join(project, 'app'), target, { recursive: true })
  await mkdir(data)
  await mkdir(downloads)
  await cp(path.join(project, 'cmd'), path.join(root, 'cmd'), {
    recursive: true,
  })
  // Async fs.cp preserves the builder's file owner. Model fnOS installing its
  // lifecycle metadata as root, even when the package was built by uid 1001.
  const installedCmd = path.join(root, 'cmd')
  await chown(installedCmd, 0, 0)
  for (const entry of await readdir(installedCmd, { withFileTypes: true })) {
    assert.ok(entry.isFile(), 'Installed callbacks must be regular files')
    await chown(path.join(installedCmd, entry.name), 0, 0)
  }
  execFileSync('chown', ['1600:1600', downloads])
  // fnOS grants package access through its ACL while leaving root ownership.
  // A group-writable parent models that access on the container's POSIX FS.
  execFileSync('chown', ['0:1600', data])
  await chmod(data, 0o770)
  await mkdir(path.join(data, 'motrix'), { mode: 0o700 })
  const ownershipProbe = path.join(data, 'motrix/ownership-probe')
  const outsideProbe = path.join(root, 'outside-ownership-probe')
  await writeFile(ownershipProbe, 'retained state', { mode: 0o600 })
  await writeFile(outsideProbe, 'must remain root-owned', { mode: 0o600 })
  await symlink(outsideProbe, path.join(data, 'motrix/ownership-link'))
  await new Promise((resolve, reject) => {
    api.once('error', reject)
    api.listen(apiSocket, resolve)
  })
  await chown(apiSocket, 0, 1601)
  await chmod(apiSocket, 0o660)
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))
  await requireLifecycle('start')
  assert.equal((await stat(ownershipProbe)).uid, 1600)
  assert.equal((await stat(outsideProbe)).uid, 0)
  const first = await readFile(path.join(data, 'server-process.json'), 'utf8')
  const serverPid = JSON.parse(first).pid
  assert.match(
    await readFile(`/proc/${serverPid}/status`, 'utf8'),
    /^Uid:\s+1600\s+1600\s+1600\s+1600$/m
  )
  const authority = JSON.parse(
    await readFile(path.join(authorityRuntime, 'process.json'), 'utf8')
  )
  assert.match(
    await readFile(`/proc/${authority.pid}/status`, 'utf8'),
    /^Uid:\s+0\s+0\s+0\s+0$/m
  )
  const key = await readFile(
    path.join(data, '.nas-account-authority/authority.key')
  )
  await requireLifecycle('start')
  assert.equal(
    await readFile(path.join(data, 'server-process.json'), 'utf8'),
    first
  )
  assert.equal((await lifecycle('status')).code, 0)
  assert.equal((await get('/app/motrix/rpc/auth/status')).status, 401)
  const admin = {
    host: 'nas.local',
    origin: 'http://nas.local:5666',
    'x-motrix-web-origin': 'http://nas.local:5666',
    'x-trim-userid': '1700',
    'x-trim-isadmin': 'true',
    'x-trim-username': 'alice',
  }
  const auth = await get('/app/motrix/rpc/auth/status', admin)
  assert.equal(auth.status, 200)
  assert.equal(JSON.parse(auth.body).mode, 'fnosGateway')
  assert.equal(JSON.parse(auth.body).clientPairing.cli, true)
  assert.equal(JSON.parse(auth.body).clientPairing.extension, false)
  const endpointPath = path.join(data, 'motrix/bridge/endpoint.json')
  let endpoint
  for (let retry = 0; retry < 100; retry++) {
    endpoint = await readFile(endpointPath, 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    if (endpoint) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(endpoint, 'NAS CLI listener must publish its endpoint')
  assert.equal(endpoint.port, 16812)
  const post = (route, payload, token) =>
    fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(7000),
    })
  const pair = async () => {
    const pending = await (
      await post('/mdxp/pair/request', { clientName: 'Native smoke CLI' })
    ).json()
    assert.ok(pending.requestId)
    const route = '/app/motrix/rpc/command/bridge%3AresolvePair'
    const body = {
      args: [{ kind: 'cli', requestId: pending.requestId, decision: 'allow' }],
    }
    assert.equal(
      (await get(route, { 'content-type': 'application/json' }, 'POST', body))
        .status,
      401
    )
    const decision = await get(
      route,
      { ...admin, 'content-type': 'application/json' },
      'POST',
      body
    )
    assert.equal(decision.status, 200, decision.body)
    assert.equal(JSON.parse(decision.body).ok, true)
    const result = await (
      await post('/mdxp/pair/poll', { requestId: pending.requestId })
    ).json()
    assert.equal(result.status, 'approved')
    return result.token
  }
  const listTasks = (token) =>
    post(
      '/mdxp',
      { jsonrpc: '2.0', id: 1, method: Methods.TaskList, params: {} },
      token
    )
  let token = await pair()
  assert.equal((await listTasks(token)).status, 200)
  assert.equal((await listTasks(endpoint.localToken)).status, 403)
  execFileSync('usermod', ['--lock', 'alice'])
  assert.equal((await listTasks(token)).status, 403)
  execFileSync('usermod', ['--unlock', 'alice'])
  assert.equal((await listTasks(token)).status, 200)
  execFileSync('gpasswd', ['--delete', 'alice', 'Administrators'])
  assert.equal((await listTasks(token)).status, 403)
  execFileSync('usermod', ['--append', '--groups', 'Administrators', 'alice'])
  changePassword()
  assert.equal((await listTasks(token)).status, 403)
  token = await pair()
  assert.equal((await listTasks(token)).status, 200)
  const add = (saveDir) =>
    post(
      '/mdxp',
      {
        jsonrpc: '2.0',
        id: 2,
        method: Methods.DownloadAdd,
        params: {
          kind: 'url',
          saveDir,
          filename: 'cli-fixture.bin',
          uris: [
            `http://127.0.0.1:${fixtureServer.address().port}/fixture.bin`,
          ],
        },
      },
      token
    )
  allowWrites = false
  const deniedDirectory = path.join(downloads, 'denied')
  assert.ok((await (await add(deniedDirectory)).json()).error)
  assert.equal(await stat(deniedDirectory).catch(() => null), null)
  allowWrites = true
  const added = await (await add(downloads)).json()
  assert.ok(added.result?.id, JSON.stringify(added))
  let task
  for (let retry = 0; retry < 200; retry++) {
    const response = (
      await (
        await post(
          '/mdxp',
          {
            jsonrpc: '2.0',
            id: 3,
            method: Methods.TaskGet,
            params: { taskId: added.result.id },
          },
          token
        )
      ).json()
    ).result
    task = TaskGetResultSchema.parse(response).task
    if (task?.status === 'completed' || task?.status === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(task?.status, 'completed')
  const downloadedFile = path.join(downloads, 'cli-fixture.bin')
  assert.deepEqual(await readFile(downloadedFile), payload)
  assert.equal((await stat(downloadedFile)).uid, 1600)
  assert.ok(aclUsers.length > 0 && aclUsers.every((uid) => uid === 1700))
  allowDeletes = false
  const deniedRemoval = await (
    await post(
      '/mdxp',
      {
        jsonrpc: '2.0',
        id: 4,
        method: Methods.TaskRemove,
        params: { taskId: task.id, deleteFiles: true },
      },
      token
    )
  ).json()
  assert.ok(deniedRemoval.error)
  assert.deepEqual(await readFile(downloadedFile), payload)
  allowDeletes = true

  assert.equal(
    (
      await get('/app/motrix/rpc/auth/status', {
        ...admin,
        'x-trim-isadmin': 'false',
      })
    ).status,
    401
  )
  assert.equal((await get('/rpc/auth/status', admin)).status, 404)
  assert.equal((await get('/app/motrix/', admin)).status, 200)
  assert.equal((await get('/app/motrix/mo-logo.svg', admin)).status, 200)
  const ticket = await get('/app/motrix/rpc/auth/event-ticket', admin, 'POST')
  assert.equal(ticket.status, 200)
  assert.match(JSON.parse(ticket.body).ticket, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(
    (
      await get(
        '/app/motrix/rpc/auth/event-ticket',
        { ...admin, origin: 'http://nas.local:8080' },
        'POST'
      )
    ).status,
    403
  )
  // A live listener without a matching protected process record is not adopted.
  const authorityRecord = path.join(authorityRuntime, 'process.json')
  const recordedAuthority = await readFile(authorityRecord)
  await rm(authorityRecord)
  assert.equal((await lifecycle('start')).code, 1)
  assert.equal(
    await readFile(path.join(data, 'server-process.json'), 'utf8'),
    first
  )
  await writeFile(authorityRecord, recordedAuthority, { mode: 0o600 })
  assert.equal((await lifecycle('status')).code, 0)
  // A helper crash does not kill downloads. A subsequent start repairs it and
  // retains both the application process and the credential generation key.
  process.kill(authority.pid, 'SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await lifecycle('status')).code, 3)
  await requireLifecycle('start')
  assert.equal(
    await readFile(path.join(data, 'server-process.json'), 'utf8'),
    first
  )
  assert.deepEqual(
    await readFile(path.join(data, '.nas-account-authority/authority.key')),
    key
  )
  assert.equal((await listTasks(token)).status, 200)
  await writeFile(path.join(data, 'motrix/persistence-probe'), 'preserved')
  assert.equal((await lifecycle('stop')).code, 0)
  assert.equal((await lifecycle('status')).code, 3)
  await requireLifecycle('start')
  assert.equal(
    await readFile(path.join(data, 'motrix/persistence-probe'), 'utf8'),
    'preserved'
  )
  assert.equal((await listTasks(token)).status, 200)
  assert.deepEqual(await readFile(downloadedFile), payload)
  assert.equal((await lifecycle('stop')).code, 0)
  // A stale/reused PID must never signal an unrelated process.
  await writeFile(
    path.join(data, 'server-process.json'),
    JSON.stringify({ pid: process.pid, started: '1', boot: 'stale' })
  )
  assert.equal((await lifecycle('stop')).code, 0)
  await writeFile(
    authorityRecord,
    JSON.stringify({
      pid: process.pid,
      executable: authority.executable,
      started: '1',
      boot: 'stale',
    }),
    { mode: 0o600 }
  )
  assert.equal((await lifecycle('stop')).code, 0)
  const applicationEntry = path.join(target, 'lifecycle.mjs')
  const applicationCode = await readFile(applicationEntry)
  await writeFile(applicationEntry, 'process.exit(1)\n')
  assert.equal((await lifecycle('start')).code, 1)
  assert.equal(await stat(authorityRecord).catch(() => null), null)
  assert.equal((await lifecycle('status')).code, 3)
  await writeFile(applicationEntry, applicationCode)
  // Check the trust boundary before executing a package-writable runtime.
  const executableDirectory = path.join(root, 'cmd/.authority-runtime')
  for (const file of await readdir(executableDirectory))
    if (/^node-[a-f0-9]{64}$/.test(file))
      await rm(path.join(executableDirectory, file))
  const nodePath = path.join(target, 'runtime/bin/node')
  const originalNode = await readFile(nodePath)
  const forgedNode = Buffer.alloc(originalNode.length, 32)
  Buffer.from('#!/bin/sh\nexit 0\n').copy(forgedNode)
  await writeFile(nodePath, forgedNode)
  assert.equal((await lifecycle('start')).code, 1)
  await writeFile(nodePath, originalNode)
  const authorityEntry = path.join(root, 'cmd/account-authority.mjs')
  await chmod(authorityEntry, 0o666)
  assert.equal((await lifecycle('start')).code, 1)
  await chmod(authorityEntry, 0o644)
  await requireLifecycle('start')
  assert.equal((await listTasks(token)).status, 200)
  // Exercise the actual packaged wizard -> privileged launcher -> unprivileged
  // Server path. Invalid optional Extension settings must leave Web/CLI usable.
  const extensionReady = async () =>
    JSON.parse((await get('/app/motrix/rpc/auth/status', admin)).body)
      .clientPairing.extension
  const discovery = () => fetch(`http://127.0.0.1:${endpoint.port}/discovery`)
  await requireLifecycle('stop')
  env.wizard_extension_enabled = 'true'
  env.wizard_extension_url = `ws://127.0.0.1:${endpoint.port}`
  env.wizard_operator_url = 'http://nas.local:5666/app/motrix/'
  env.wizard_allow_operator_http = 'true'
  await requireLifecycle('start')
  assert.equal(await extensionReady(), true)
  assert.equal((await discovery()).status, 200)
  const nonce = await fetch(`http://127.0.0.1:${endpoint.port}/nonce`, {
    method: 'POST',
    headers: { 'x-motrix-bridge': '1' },
  })
  assert.equal(nonce.status, 200)
  assert.equal(typeof (await nonce.json()).nonce, 'string')
  assert.equal((await listTasks(token)).status, 200)
  await requireLifecycle('stop')
  env.wizard_allow_operator_http = 'false'
  await requireLifecycle('start')
  assert.equal(await extensionReady(), false)
  assert.equal((await discovery()).status, 404)
  assert.equal((await listTasks(token)).status, 200)
  console.log(
    `fnOS lifecycle smoke passed: ${process.arch}, uid=${process.getuid()}, start/status/stop/restart, gateway auth, native CLI pairing/account revocation, authorized download/denied delete, data retention, stale PID, helper crash recovery, runtime tamper rejection, Extension wizard opt-in and invalid configuration isolation`
  )
} finally {
  await lifecycle('stop')
  await new Promise((resolve) => api.close(resolve))
  await new Promise((resolve) => fixtureServer.close(resolve))
  await rm(root, { recursive: true, force: true })
  await rm(authorityRuntime, { recursive: true, force: true })
}
