import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { on, once } from 'node:events'
import {
  access,
  chmod,
  chown,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createSocketServer } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'project-dir': { type: 'string' } } })
const project = path.resolve(values['project-dir'])
if (process.platform !== 'linux' || process.getuid() !== 0)
  throw new Error('Run only in a disposable root Linux container')
await access('/.dockerenv')
const root = '/var/packages/Motrix'
if (await stat(root).catch(() => null))
  throw new Error('Existing package: refusing smoke')
const target = path.join(root, 'target')
const variable = path.join(root, 'var')
const downloads = '/volume1/motrix'
const replacement = '/volume1/motrix-storage-recovery'
execFileSync('groupadd', ['--gid', '1650', 'http'])
execFileSync('useradd', [
  '--uid',
  '1600',
  '--groups',
  'http',
  '--no-create-home',
  'motrix',
])
execFileSync('useradd', [
  '--uid',
  '1601',
  '--gid',
  'http',
  '--no-create-home',
  'gateway',
])
execFileSync('useradd', ['--uid', '1602', '--no-create-home', 'unrelated'])
for (const folder of [target, variable, downloads, `${root}/shares`])
  await mkdir(folder, { recursive: true })
await cp(path.join(project, 'app'), target, { recursive: true })
await symlink(downloads, `${root}/shares/motrix`)
execFileSync('chown', ['-R', '1600:1600', root, downloads])
// Simulate only the fixed DSM read APIs with real unprivileged socket access.
// No helper capabilities, root package processes, real cookies or passwords.
execFileSync('groupadd', ['--non-unique', '--gid', '101', 'administrators'])
execFileSync('useradd', [
  '--uid',
  '1700',
  '--groups',
  'administrators',
  '--no-create-home',
  'alice',
])
await writeFile('/tmp/dsm-session-state', 'active')
await writeFile('/tmp/dsm-account-state', 'active')
await writeFile('/tmp/dsm-acl-state', 'allow')
const authority = createSocketServer((socket) => {
  let input = Buffer.alloc(0),
    handled = false
  socket.on('data', async (chunk) => {
    if (handled) return
    input = Buffer.concat([input, chunk])
    const colon = input.indexOf(':')
    if (colon < 0) return
    const length = Number(input.subarray(0, colon).toString())
    assert.ok(length > 0 && length < 32768)
    if (input.length < colon + length + 2) return
    const parts = input
      .subarray(colon + 1, colon + 1 + length)
      .toString()
      .split('\0')
    parts.pop()
    const env = Object.fromEntries(
      Array.from({ length: parts.length / 2 }, (_, i) =>
        parts.slice(i * 2, i * 2 + 2)
      )
    )
    if (input.length < colon + length + 2 + Number(env.CONTENT_LENGTH)) return
    handled = true
    assert.equal(env.SCGI, '1')
    assert.equal(env.REMOTE_ADDR, '127.0.0.1')
    assert.equal(env.SERVER_PORT, '5000')
    assert.equal(env.REQUEST_SCHEME, 'http')
    assert.equal(env.LD_PRELOAD, undefined)
    const reply = (data) =>
      socket.end(
        `Content-Type: application/json\r\n\r\n${JSON.stringify(data)}`
      )
    if (
      env.HTTP_COOKIE !== 'id=synthetic-session' ||
      (await readFile('/tmp/dsm-session-state', 'utf8')) !== 'active'
    )
      return reply({ success: false, error: { code: 119 } })
    if (env.SCRIPT_FILENAME === '/usr/syno/synoman/webman/login.cgi')
      return reply({ success: true, SynoToken: 'synthetic-token' })
    assert.equal(env.SCRIPT_FILENAME, '/usr/syno/synoman/webapi/entry.cgi')
    assert.equal(env.HTTP_X_SYNO_TOKEN, 'synthetic-token')
    const params = new URLSearchParams(
      input.subarray(colon + length + 2).toString()
    )
    if (params.get('api') === 'SYNO.Core.NormalUser')
      return reply({ success: true, data: { username: 'alice' } })
    if (params.get('api') === 'SYNO.Core.User') {
      assert.equal(params.get('name'), 'alice')
      assert.equal(params.get('additional'), '["expired"]')
      const state = await readFile('/tmp/dsm-account-state', 'utf8')
      return reply(
        state === 'unavailable'
          ? { success: false, error: { code: 105 } }
          : {
              success: true,
              data: {
                users: [
                  {
                    name: 'alice',
                    uid: 1700,
                    expired: state === 'disabled' ? 'now' : 'normal',
                  },
                ],
              },
            }
      )
    }
    assert.equal(params.get('api'), 'SYNO.FileStation.List')
    assert.equal(params.get('method'), 'getinfo')
    const names = JSON.parse(params.get('path'))
    assert.equal(names.length, 1)
    const file = `/volume1${names[0]}`
    assert.ok(
      [downloads, replacement].some(
        (root) => file === root || file.startsWith(`${root}/`)
      )
    )
    const info = await stat(file).catch(() => null)
    if (!info) return reply({ success: false, error: { code: 408 } })
    const writable = (await readFile('/tmp/dsm-acl-state', 'utf8')) === 'allow'
    reply({
      success: true,
      data: {
        files: [
          {
            path: names[0],
            isdir: info.isDirectory(),
            additional: {
              real_path: file,
              perm: {
                acl: {
                  read: true,
                  exec: true,
                  write: writable,
                  append: writable,
                  del: writable,
                },
              },
            },
          },
        ],
      },
    })
  })
})
await new Promise((resolve) => authority.listen('/run/synoscgi.sock', resolve))
await chown('/run/synoscgi.sock', 1023, 1650)
await chmod('/run/synoscgi.sock', 0o770)
const env = {
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  SYNOPKG_PKGDEST: target,
  SYNOPKG_PKGVAR: variable,
  SYNOPKG_PKG_STATUS: 'INSTALL',
  wizard_client_port: '16812',
}
const execute = (script, action, extra = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'runuser',
      [
        '-u',
        'motrix',
        '--',
        path.join(project, 'scripts', script),
        ...(action ? [action] : []),
      ],
      { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
    })
    child.stderr.on('data', (data) => {
      output += data
    })
    const timer = setTimeout(() => child.kill(), 75000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
const life = async (action, expectBridge = true) => {
  const result = await execute('start-stop-status', action)
  if (result.code !== 0)
    throw new Error(
      `${action}: ${result.output}\n${await readFile(path.join(variable, 'server.log'), 'utf8').catch(() => '')}`
    )
  if (action === 'start' && expectBridge)
    for (let i = 0; i < 150; i++) {
      try {
        await fetch('http://127.0.0.1:16812/discovery')
        break
      } catch {
        await delay(100)
      }
    }
}
const admin = {
  cookie: 'id=synthetic-session',
  'x-motrix-dsm-remote-addr': '127.0.0.1',
  'x-motrix-dsm-server-addr': '127.0.0.1',
  'x-motrix-dsm-server-port': '5000',
  'x-motrix-dsm-scheme': 'http',
  'x-motrix-web-origin': 'http://nas.test',
  origin: 'http://nas.test',
  'content-type': 'application/json',
}
const web = (route, headers = admin, body, client = false) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: `${variable}/${client ? 'client' : 'web'}.sock`,
        path: `/motrix${route}`,
        headers,
        method: body ? 'POST' : 'GET',
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body: text }))
      }
    )
    req.on('error', reject).end(body ? JSON.stringify(body) : undefined)
  })

async function verifyEventSessionRenewal() {
  const WebSocket = createRequire(path.join(target, 'server/package.json'))(
    'ws'
  )
  const issued = await web('/rpc/auth/event-ticket', admin, {})
  assert.equal(issued.status, 200)
  const ws = new WebSocket(
    `ws+unix://${variable}/web.sock:/motrix/rpc/events`,
    [
      'motrix.fnos.events',
      `motrix.fnos.ticket.${JSON.parse(issued.body).ticket}`,
    ],
    { headers: admin }
  )
  const signal = AbortSignal.timeout(110_000)
  const closed = once(ws, 'close', { signal })
  // Socket errors can reject this promise before the iterator reaches it.
  void closed.catch(() => {})
  let renewed = false
  try {
    for await (const [raw] of on(ws, 'message', { signal, close: ['close'] })) {
      const frame = JSON.parse(raw.toString())
      if (frame.type !== 'session-renewal') continue
      if (renewed) await writeFile('/tmp/dsm-session-state', 'expired')
      const response = await web('/rpc/auth/event-renew', admin, frame)
      if (!renewed) {
        assert.equal(response.status, 204)
        renewed = true
        continue
      }
      assert.equal(response.status, 401)
      assert.equal((await closed)[0], 4401)
      console.log(
        'DSM event stream renewed on one socket beyond its initial authorization and closed on revoked session'
      )
      return
    }
    throw Error('DSM event stream closed before reauthentication')
  } finally {
    ws.terminate()
    await writeFile('/tmp/dsm-session-state', 'active')
  }
}
const post = (route, body, token) =>
  fetch(`http://127.0.0.1:16812${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
const { Methods } = await import(
  pathToFileURL(
    path.join(target, 'server/node_modules/@motrix/mdxp/dist/index.js')
  ).href
)
const rpc = (method, params, token) =>
  post('/mdxp', { jsonrpc: '2.0', id: 1, method, params }, token)
const payload = randomBytes(256 * 1024)
let announces = 0
const fixture = createServer((req, res) => {
  if (req.url.startsWith('/announce')) {
    announces++
    const peer = Buffer.from([127, 0, 0, 1, 0, 0])
    peer.writeUInt16BE(16813, 4)
    res.end(
      Buffer.concat([
        Buffer.from('d8:intervali1e5:peers6:'),
        peer,
        Buffer.from('e'),
      ])
    )
    return
  }
  if (req.url === '/tiny.txt') {
    res.end('tiny native download')
    return
  }
  res.writeHead(200, { 'content-length': payload.length })
  res.end(payload)
})
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
function bencode(value) {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.from(value)
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
  }
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [bencode(key), bencode(value[key])]),
    Buffer.from('e'),
  ])
}
const pieces = []
for (let offset = 0; offset < payload.length; offset += 16384)
  pieces.push(
    createHash('sha1')
      .update(payload.subarray(offset, offset + 16384))
      .digest()
  )
const torrent = bencode({
  announce: `http://127.0.0.1:${fixture.address().port}/announce`,
  info: {
    length: payload.length,
    name: 'bt-fixture.bin',
    'piece length': 16384,
    pieces: Buffer.concat(pieces),
  },
})
await mkdir('/tmp/dsm-seed')
await writeFile('/tmp/dsm-seed/bt-fixture.bin', payload)
await writeFile('/tmp/dsm-seed/fixture.torrent', torrent)
execFileSync('chown', ['-R', '1600:1600', '/tmp/dsm-seed'])
const seeder = spawn(
  'runuser',
  [
    '-u',
    'motrix',
    '--',
    `${target}/server/bin/aria2c`,
    '--no-conf=true',
    '--enable-dht=false',
    '--enable-dht6=false',
    '--bt-enable-lpd=false',
    '--enable-peer-exchange=false',
    '--check-integrity=true',
    '--file-allocation=none',
    '--listen-port=16813',
    '--seed-time=10',
    '--seed-ratio=0.0',
    '--dir=/tmp/dsm-seed',
    '/tmp/dsm-seed/fixture.torrent',
  ],
  { stdio: 'ignore' }
)
const pair = async () => {
  const pending = await (
    await post('/mdxp/pair/request', { clientName: 'DSM smoke CLI' })
  ).json()
  const decision = await web('/rpc/command/bridge%3AresolvePair', admin, {
    args: [{ kind: 'cli', requestId: pending.requestId, decision: 'allow' }],
  })
  assert.equal(decision.status, 200, decision.body)
  assert.equal(JSON.parse(decision.body).ok, true)
  const result = await (
    await post('/mdxp/pair/poll', { requestId: pending.requestId })
  ).json()
  assert.equal(result.status, 'approved')
  return result.token
}
const replacePayload = async () => {
  await rm(target, { recursive: true, force: true })
  await cp(path.join(project, 'app'), target, { recursive: true })
  execFileSync('chown', ['-R', '1600:1600', target])
}

const reinstall = async (wizardPort) => {
  assert.equal(
    (
      await execute('postuninst', undefined, {
        SYNOPKG_PKG_STATUS: 'UNINSTALL',
      })
    ).code,
    0
  )
  assert.equal((await execute('preinst')).code, 0)
  await replacePayload()
  assert.equal(
    (await execute('postinst', undefined, { wizard_client_port: wizardPort }))
      .code,
    0
  )
}
try {
  assert.equal((await execute('postinst')).code, 0)
  await life('start')
  await life('status')
  // Exercise a separate unprivileged gateway account, not the root test driver.
  // Root bypasses Unix permissions and would miss the DSM 502 regression.
  const gatewayProbe = `const http=require('node:http');const fs=require('node:fs');const req=http.get({socketPath:process.argv[1],path:'/motrix/healthz'},res=>{res.resume();res.on('end',()=>{if(res.statusCode!==200)process.exit(2);for(const p of process.argv.slice(2)){try{fs.accessSync(p,fs.constants.R_OK);process.exit(3)}catch(e){if(e.code!=='EACCES')process.exit(4)}}})});req.on('error',e=>{console.error(e.code);process.exit(5)})`
  execFileSync(
    'runuser',
    [
      '-u',
      'gateway',
      '--',
      `${target}/runtime/bin/node`,
      '-e',
      gatewayProbe,
      `${variable}/web.sock`,
      `${variable}/data`,
      `${variable}/package-settings.json`,
    ],
    { stdio: 'pipe' }
  )
  const unrelatedProbe = `require('node:http').get({socketPath:process.argv[1],path:'/motrix/healthz'},()=>process.exit(2)).on('error',e=>process.exit(e.code==='EACCES'?0:3))`
  execFileSync(
    'runuser',
    [
      '-u',
      'unrelated',
      '--',
      `${target}/runtime/bin/node`,
      '-e',
      unrelatedProbe,
      `${variable}/web.sock`,
    ],
    { stdio: 'pipe' }
  )
  const status = JSON.parse((await web('/rpc/auth/status')).body)
  await writeFile('/tmp/dsm-session-state', 'unavailable')
  const rejectedSession = JSON.parse((await web('/rpc/auth/status')).body)
  assert.equal(rejectedSession.authed, false)
  assert.deepEqual(rejectedSession.nasAuthDiagnostic, {
    stage: 'account',
    code: 'rejected',
  })
  assert.equal(JSON.stringify(rejectedSession).includes('alice'), false)
  assert.equal(
    JSON.stringify(rejectedSession).includes('synthetic-session'),
    false
  )
  await writeFile('/tmp/dsm-session-state', 'active')
  assert.equal(status.username, 'alice')
  assert.deepEqual(status.clientPairing, { cli: true, extension: false })
  await verifyEventSessionRenewal()
  assert.equal(
    (
      await web(
        '/rpc/query/app%3AgetSettings',
        {
          'x-trim-userid': '1700',
          'x-trim-isadmin': 'true',
          'x-trim-username': 'alice',
        },
        { args: [] }
      )
    ).status,
    401
  )
  let token = await pair()
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 200)
  const client = (route, body, bearer) =>
    web(
      route,
      {
        host: 'nas.test',
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body,
      true
    )
  assert.equal(
    (
      await client(
        '/client/mdxp',
        { jsonrpc: '2.0', id: 1, method: Methods.TaskList, params: {} },
        token
      )
    ).status,
    200
  )
  assert.equal((await client('/bridge/discovery')).status, 404)
  assert.equal(
    (
      await client('/client/mdxp', {
        jsonrpc: '2.0',
        id: 1,
        method: Methods.TaskList,
        params: {},
      })
    ).status,
    401
  )
  const nativeSettings = JSON.parse(
    (await web('/rpc/query/query%3AgetNasSettings', admin, { args: [] })).body
  )
  assert.equal(nativeSettings.ok, true)
  assert.equal(nativeSettings.value.active.extensionUrl, '')
  for (const state of ['disabled', 'unavailable']) {
    await writeFile('/tmp/dsm-account-state', state)
    assert.equal((await rpc(Methods.TaskList, {}, token)).status, 403)
    assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, false)
  }
  await writeFile('/tmp/dsm-account-state', 'active')
  assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, true)
  // Real group removal must reject the same account, including paired clients.
  execFileSync('gpasswd', ['-d', 'alice', 'administrators'])
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 403)
  assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, false)
  execFileSync('usermod', ['-a', '-G', 'administrators', 'alice'])
  token = await pair()
  const add = (saveDir) =>
    rpc(
      Methods.DownloadAdd,
      {
        kind: 'url',
        saveDir,
        filename: 'fixture.bin',
        uris: [`http://127.0.0.1:${fixture.address().port}/fixture.bin`],
      },
      token
    )
  await writeFile('/tmp/dsm-acl-state', 'readonly')
  assert.ok((await (await add(`${downloads}/denied`)).json()).error)
  assert.equal(await stat(`${downloads}/denied`).catch(() => null), null)
  await writeFile('/tmp/dsm-acl-state', 'allow')
  assert.ok((await (await add('/tmp')).json()).error)
  // Only the parent share is explicitly granted. A task must keep ownership
  // of its own directory and published file across restart and name reuse.
  const child = path.join(downloads, 'nested-task')
  const childFile = path.join(child, 'nested.txt')
  const created = JSON.parse(
    (
      await web('/rpc/command/command%3AcreateTask', admin, {
        args: [
          {
            type: 'http',
            uris: [`http://127.0.0.1:${fixture.address().port}/nested-proof`],
            saveDir: child,
            filename: 'nested.txt',
            connections: 1,
          },
        ],
      })
    ).body
  )
  assert.ok(created.taskId)
  for (let attempt = 0; attempt < 120; attempt++) {
    const query = await (
      await rpc(Methods.TaskGet, { taskId: created.taskId }, token)
    ).json()
    if (query.result?.task?.status === 'completed') break
    await delay(100)
  }
  const childRoute = `/api/nas/tasks/${created.taskId}/file`
  assert.equal((await web(childRoute)).status, 200)
  assert.deepEqual(await readFile(childFile), payload)
  const assertSubstituteProtected = async () => {
    assert.equal((await web(childRoute)).status, 403)
    const result = await (
      await rpc(
        Methods.TaskRemove,
        { taskId: created.taskId, deleteFiles: true },
        token
      )
    ).json()
    assert.ok(result.error)
    assert.equal(await readFile(childFile, 'utf8'), 'substitute')
  }
  await rename(childFile, `${childFile}.original`)
  await writeFile(childFile, 'substitute')
  await chown(childFile, 1600, 1600)
  await assertSubstituteProtected()
  await rm(childFile)
  await rename(`${childFile}.original`, childFile)
  await rename(child, `${child}.original`)
  await mkdir(child)
  await chown(child, 1600, 1600)
  await writeFile(childFile, 'substitute')
  await chown(childFile, 1600, 1600)
  await assertSubstituteProtected()
  await life('stop')
  await life('start')
  assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, true)
  await assertSubstituteProtected()
  await rename(child, `${child}.substitute`)
  await rename(`${child}.original`, child)
  assert.equal((await web(childRoute)).status, 200)
  assert.deepEqual(await readFile(childFile), payload)
  const removed = await (
    await rpc(
      Methods.TaskRemove,
      { taskId: created.taskId, deleteFiles: true },
      token
    )
  ).json()
  assert.equal(removed.error, undefined)
  await assert.rejects(stat(childFile), { code: 'ENOENT' })
  assert.equal(
    await readFile(path.join(`${child}.substitute`, 'nested.txt'), 'utf8'),
    'substitute'
  )
  console.log(
    'Replacement file and nested task directory denied before and after restart; original restored and removed'
  )
  const tiny = JSON.parse(
    (
      await web('/rpc/command/command%3AcreateTask', admin, {
        args: [
          {
            type: 'http',
            uris: [`http://127.0.0.1:${fixture.address().port}/tiny.txt`],
            saveDir: downloads,
            filename: 'tiny.txt',
            connections: 1,
          },
        ],
      })
    ).body
  )
  assert.ok(tiny.taskId)
  let tinyTask
  for (let i = 0; i < 100; i++) {
    tinyTask = (
      await (await rpc(Methods.TaskGet, { taskId: tiny.taskId }, token)).json()
    ).result?.task
    if (tinyTask?.status === 'completed') break
    await delay(100)
  }
  assert.equal(tinyTask?.status, 'completed')
  assert.equal(
    (
      await web('/api/nas/task-action', admin, {
        taskId: tiny.taskId,
        action: 'open',
      })
    ).status,
    200
  )
  await symlink('/tmp', `${downloads}/escape`)
  assert.ok((await (await add(`${downloads}/escape`)).json()).error)
  const added = await (await add(downloads)).json()
  assert.ok(added.result?.id, JSON.stringify(added))
  let task
  for (let i = 0; i < 250; i++) {
    task = (
      await (
        await rpc(Methods.TaskGet, { taskId: added.result.id }, token)
      ).json()
    ).result?.task
    if (task?.status === 'completed' || task?.status === 'error') break
    await delay(100)
  }
  assert.equal(task?.status, 'completed', JSON.stringify(task))
  assert.deepEqual(await readFile(`${downloads}/fixture.bin`), payload)
  assert.equal((await stat(`${downloads}/fixture.bin`)).uid, 1600)
  const opened = await web('/api/nas/task-action', admin, {
    taskId: task.id,
    action: 'open',
  })
  assert.equal(opened.status, 200, opened.body)
  const fileUrl = JSON.parse(opened.body).url
  const ranged = await web(fileUrl.replace(/^\/motrix/, ''), {
    ...admin,
    range: 'bytes=0-15',
  })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.body, payload.subarray(0, 16).toString())
  const revealed = JSON.parse(
    (
      await web('/api/nas/task-action', admin, {
        taskId: task.id,
        action: 'reveal',
      })
    ).body
  )
  assert.equal(revealed.kind, 'file-manager')
  assert.ok(revealed.url.startsWith('/?launchApp='))
  await writeFile(`${downloads}/selection.torrent`, torrent)
  await chown(`${downloads}/selection.torrent`, 1600, 1600)
  assert.equal(
    (
      await web('/api/nas/torrent', admin, {
        path: `${downloads}/selection.torrent`,
      })
    ).status,
    200
  )
  await writeFile('/tmp/dsm-acl-state', 'readonly')
  assert.ok(
    (
      await (
        await rpc(
          Methods.TaskRemove,
          { taskId: task.id, deleteFiles: true },
          token
        )
      ).json()
    ).error
  )
  await writeFile('/tmp/dsm-acl-state', 'allow')
  const btRequest = await web('/rpc/command/command%3AcreateTask', admin, {
    args: [
      {
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: torrent.toString('base64') },
        selectedFiles: [0],
        saveDir: downloads,
        displayName: 'bt-fixture.bin',
      },
    ],
  })
  assert.equal(btRequest.status, 200, btRequest.body)
  const btId = JSON.parse(btRequest.body).taskId
  assert.ok(btId, btRequest.body)
  let btTask
  for (let i = 0; i < 600; i++) {
    btTask = (
      await (await rpc(Methods.TaskGet, { taskId: btId }, token)).json()
    ).result?.task
    if (['completed', 'seeding', 'error'].includes(btTask?.status)) break
    await delay(100)
  }
  assert.ok(
    ['completed', 'seeding'].includes(btTask?.status),
    JSON.stringify(btTask)
  )
  assert.deepEqual(await readFile(`${downloads}/bt-fixture.bin`), payload)
  assert.ok(announces >= 2)
  const settingsBeforeUpgrade = JSON.parse(
    (await web('/rpc/query/query%3AgetNasSettings', admin, { args: [] })).body
  ).value
  const savedSettings = JSON.parse(
    (
      await web('/rpc/command/command%3AsaveNasSettings', admin, {
        args: [
          {
            revision: settingsBeforeUpgrade.revision,
            settings: {
              ...settingsBeforeUpgrade.settings,
              operatorUrl: 'http://nas.test/motrix/',
            },
          },
        ],
      })
    ).body
  )
  assert.equal(savedSettings.ok, true, JSON.stringify(savedSettings))
  assert.equal(savedSettings.value.restartRequired, true)
  assert.equal(
    (await execute('preupgrade', undefined, { SYNOPKG_PKG_STATUS: 'UPGRADE' }))
      .code,
    0
  )
  // Model an earlier package with no per-task path claims and incomplete file counts.
  // Mutate only this synthetic row, while the package is stopped, as its user.
  execFileSync('runuser', [
    '-u',
    'motrix',
    '--',
    `${target}/runtime/bin/node`,
    '-e',
    `const DB=require(process.argv[1]);const db=new DB(process.argv[2]);db.prepare('UPDATE tasks SET file_count=0 WHERE motrix_id=?').run(process.argv[3]);db.exec('DROP TABLE synology_task_paths');db.close()`,
    `${target}/server/node_modules/better-sqlite3`,
    `${variable}/data/motrix.db`,
    tiny.taskId,
  ])
  await replacePayload()
  assert.equal(
    (await execute('postupgrade', undefined, { SYNOPKG_PKG_STATUS: 'UPGRADE' }))
      .code,
    0
  )
  await life('start')
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 403)
  assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, true)
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 200)
  assert.deepEqual(await readFile(`${downloads}/fixture.bin`), payload)
  const appliedSettings = JSON.parse(
    (await web('/rpc/query/query%3AgetNasSettings', admin, { args: [] })).body
  ).value
  assert.equal(appliedSettings.active.operatorUrl, 'http://nas.test/motrix/')
  assert.equal(appliedSettings.restartRequired, false)
  // A regular directory at the old pathname can pass both account and package
  // ACL checks. Existing tasks must not read or delete the replacement's files.
  const heldDownloads = `${downloads}.original-directory`
  await rename(downloads, heldDownloads)
  await mkdir(downloads)
  await chown(downloads, 1600, 1600)
  await writeFile(`${downloads}/tiny.txt`, 'replacement payload')
  await chown(`${downloads}/tiny.txt`, 1600, 1600)
  const oldTaskFile = `/api/nas/tasks/${tiny.taskId}/file`
  assert.equal((await web(oldTaskFile)).status, 403)
  const refusedSaveDir = `${downloads}/refused-new-task`
  assert.ok((await (await add(refusedSaveDir)).json()).error)
  await assert.rejects(stat(refusedSaveDir), { code: 'ENOENT' })
  assert.ok(
    (
      await (
        await rpc(
          Methods.TaskRemove,
          { taskId: tiny.taskId, deleteFiles: true },
          token
        )
      ).json()
    ).error
  )
  assert.equal(
    await readFile(`${downloads}/tiny.txt`, 'utf8'),
    'replacement payload'
  )
  await life('stop')
  await life('start', false)
  assert.equal(
    JSON.parse((await web('/healthz')).body).status,
    'storage-recovery'
  )
  await life('stop')
  await rename(downloads, `${downloads}.replacement-directory`)
  await rename(heldDownloads, downloads)
  await life('start')
  assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, true)
  assert.equal((await web(oldTaskFile)).body, 'tiny native download')
  assert.equal(
    (
      await web('/api/nas/task-action', admin, {
        taskId: tiny.taskId,
        action: 'open',
      })
    ).status,
    200
  )
  assert.ok(
    !(
      await (
        await rpc(
          Methods.TaskRemove,
          { taskId: task.id, deleteFiles: true },
          token
        )
      ).json()
    ).error
  )
  assert.equal(await stat(`${downloads}/fixture.bin`).catch(() => null), null)
  // Any account database replacement conservatively invalidates old bindings.
  execFileSync('useradd', ['--no-create-home', 'epoch-change'])
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 403)
  token = await pair()
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 200)
  const processRecord = JSON.parse(
    await readFile(`${variable}/server-process.json`, 'utf8')
  )
  assert.equal((await stat(`/proc/${processRecord.pid}`)).uid, 1600)
  await life('stop')
  await writeFile(
    `${variable}/server-process.json`,
    JSON.stringify({ pid: process.pid, started: '1', boot: 'stale' })
  )
  await life('stop')
  await life('start')
  // An unavailable share must leave all recovery journals and engine state
  // untouched while an administrator can repair grants through the Web UI.
  await life('stop')
  const durableFiles = [
    'motrix.db',
    'motrix.db-wal',
    'aria2.session',
    'aria2.db',
    'aria2.db-wal',
  ]
  const durableHashes = () =>
    Promise.all(
      durableFiles.map(async (name) => {
        try {
          return createHash('sha256')
            .update(await readFile(path.join(variable, 'data', name)))
            .digest('hex')
        } catch (error) {
          if (error.code === 'ENOENT') return null
          throw error
        }
      })
    )
  const beforeRecovery = await durableHashes()
  assert.ok(beforeRecovery[0])
  const offline = `${downloads}.offline-fixture`
  await rename(downloads, offline)
  // A directory left behind on the system filesystem is not a mounted share,
  // even when the package can traverse it and it has the old pathname.
  const unmounted = '/volume2/motrix-offline-fixture'
  await mkdir(unmounted, { recursive: true })
  await chown(unmounted, 1600, 1600)
  await writeFile(
    `${variable}/directories.json`,
    JSON.stringify({ roots: [downloads, unmounted] })
  )
  await life('start', false)
  const recoveryHealth = JSON.parse((await web('/healthz')).body)
  assert.equal(recoveryHealth.status, 'storage-recovery')
  assert.equal(recoveryHealth.engine.state, 'stopped')
  const recoveryStatus = JSON.parse((await web('/rpc/auth/status')).body)
  assert.deepEqual(recoveryStatus.nasUnavailableDownloadRoots, [
    downloads,
    unmounted,
  ])
  assert.deepEqual(recoveryStatus.clientPairing, {
    cli: false,
    extension: false,
  })
  const anonymous = JSON.parse((await web('/rpc/auth/status', {})).body)
  assert.equal(anonymous.authed, false)
  assert.equal(anonymous.nasUnavailableDownloadRoots, undefined)
  assert.equal(
    (await web('/rpc/query/query%3AgetNasSettings', {}, { args: [] })).status,
    401
  )
  assert.equal(
    (await web('/rpc/query/query%3AlistTasks', admin, { args: [] })).status,
    404
  )
  assert.equal(
    (await web('/rpc/command/command%3AcreateTask', admin, { args: [] }))
      .status,
    404
  )
  await assert.rejects(fetch('http://127.0.0.1:16812/discovery'))
  const view = JSON.parse(
    (await web('/rpc/query/query%3AgetNasSettings', admin, { args: [] })).body
  ).value
  const queue = async (roots) =>
    JSON.parse(
      (
        await web('/rpc/command/command%3AsaveNasSettings', admin, {
          args: [
            { revision: view.revision, settings: { ...view.settings, roots } },
          ],
        })
      ).body
    )
  assert.equal((await queue([downloads])).error.code, 'folderUnavailable')
  assert.equal((await queue([unmounted])).error.code, 'folderUnavailable')
  assert.equal(await stat(downloads).catch(() => null), null)
  await mkdir(replacement)
  await chown(replacement, 1600, 1600)
  const queued = await queue([replacement])
  assert.equal(queued.ok, true)
  assert.equal(queued.value.settings.directoryIdentities, undefined)
  // Substitution between Save and restart must not change the identity that
  // passed the account's ACL check, even when the replacement is writable.
  await rename(replacement, `${replacement}.authorized`)
  await mkdir(replacement)
  await chown(replacement, 1600, 1600)
  const resave = await web('/rpc/command/command%3AsaveNasSettings', admin, {
    args: [
      { revision: queued.value.revision, settings: queued.value.settings },
    ],
  })
  assert.equal(JSON.parse(resave.body).error.code, 'folderUnavailable')
  await life('stop')
  assert.deepEqual(await durableHashes(), beforeRecovery)
  await life('start', false)
  assert.equal(
    JSON.parse((await web('/healthz')).body).status,
    'storage-recovery'
  )
  await life('stop')
  await rename(replacement, `${replacement}.substitute`)
  await rename(`${replacement}.authorized`, replacement)
  await life('start')
  assert.equal(JSON.parse((await web('/healthz')).body).status, 'ready')
  assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, true)
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 200)
  assert.equal(await stat(downloads).catch(() => null), null)
  assert.deepEqual(await readFile(`${offline}/bt-fixture.bin`), payload)
  await life('stop')
  await rename(offline, downloads)
  const beforeUninstall = await durableHashes()
  const readConfig = () =>
    Promise.all(
      ['package-settings.json', 'directories.json'].map((name) =>
        readFile(path.join(variable, name), 'utf8')
      )
    )
  const retainedConfig = await readConfig()
  assert.equal(
    (await execute('preuninst', undefined, { SYNOPKG_PKG_STATUS: 'UNINSTALL' }))
      .code,
    0
  )
  // DSM replaces target and retains var. An install wizard default must not
  // override the retained instance. Check the actual task and its credential.
  await reinstall('16814')
  assert.deepEqual(await durableHashes(), beforeUninstall)
  assert.deepEqual(await readConfig(), retainedConfig)
  await life('start')
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 403)
  assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, true)
  const retainedTask = await (
    await rpc(Methods.TaskGet, { taskId: tiny.taskId }, token)
  ).json()
  assert.equal(retainedTask.result?.task?.id, tiny.taskId)
  assert.equal(retainedTask.result.task.status, 'completed')
  assert.equal(
    await readFile(`${downloads}/tiny.txt`, 'utf8'),
    'tiny native download'
  )
  assert.equal(
    (
      await execute('preuninst', undefined, {
        SYNOPKG_PKG_STATUS: 'UNINSTALL',
        wizard_delete_data: 'true',
      })
    ).code,
    0
  )
  for (const name of [
    'data',
    'package-settings.json',
    'directories.json',
    'pending-settings.json',
  ]) {
    await assert.rejects(stat(path.join(variable, name)), { code: 'ENOENT' })
  }
  await reinstall('16812')
  await life('start')
  assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, true)
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 401)
  const freshTasks = await web('/rpc/query/query%3AlistTasks', admin, {
    args: [],
  })
  assert.equal(freshTasks.status, 200)
  assert.deepEqual(JSON.parse(freshTasks.body), [])
  assert.deepEqual(await readFile(`${downloads}/bt-fixture.bin`), payload)
  assert.equal(
    await readFile(`${downloads}/tiny.txt`, 'utf8'),
    'tiny native download'
  )
  console.log(
    'DSM Linux simulation passed: nonroot lifecycle and gateway socket isolation, cookie authentication, CLI pairing, account revocation, HTTP/BT download, ACL and symlink denial, replaced grant denied live and after restart, grant substitution before pending settings apply denied, file deletion, upgrade persistence, stale PID, retained-data reinstall and clean reinstall after purge'
  )
} finally {
  await execute('start-stop-status', 'stop')
  seeder.kill('SIGTERM')
  fixture.close()
  authority.close()
  await rm(root, { recursive: true, force: true })
}
