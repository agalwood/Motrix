import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer, request } from 'node:http'
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
execFileSync('useradd', ['--uid', '1600', '--no-create-home', 'motrix'])
for (const folder of [
  target,
  variable,
  downloads,
  `${root}/shares`,
  '/usr/syno/sbin',
  '/usr/syno/bin',
  '/usr/syno/synoman/webman/modules',
])
  await mkdir(folder, { recursive: true })
await cp(path.join(project, 'app'), target, { recursive: true })
await symlink(downloads, `${root}/shares/motrix`)
execFileSync('chown', ['-R', '1600:1600', root, downloads])
// These programs simulate DSM authority responses. They are never packaged.
// No passwords or actual DSM cookies are used by this Linux acceptance test.
await writeFile('/tmp/dsm-account-state', 'active')
await writeFile('/tmp/dsm-acl-state', 'allow')
const mock = async (file, body) => {
  await writeFile(file, `#!/bin/sh\n[ "$(id -u)" = 1600 ] || exit 1\n${body}\n`)
  await chmod(file, 0o755)
}
await mock(
  '/usr/syno/synoman/webman/modules/authenticate.cgi',
  '[ "$HTTP_COOKIE" = "id=synthetic-session" ] && [ "$REMOTE_ADDR" = 127.0.0.1 ] && printf alice'
)
await mock(
  '/usr/syno/sbin/synouser',
  `
[ "$1" = --get ] && [ "$2" = alice ] || exit 1
state=$(cat /tmp/dsm-account-state)
[ "$state" != unavailable ] || exit 1
printf 'User Name : [alice]\\nUser Type : [AUTH_LOCAL]\\nUser uid : [1700]\\n'
if [ "$state" = disabled ]; then echo 'Expired : [true]'; else echo 'Expired : [false]'; fi
[ "$state" != demoted ] && echo '(101) administrators'
exit 0`
)
await mock(
  '/usr/syno/bin/synoacltool',
  `
[ "$1" = -get-perm ] && [ "$3" = alice ] || exit 1
case "$(cat /tmp/dsm-acl-state)" in
allow) echo 'Final permission: [rwxpdDaARWcCo]';;
readonly) echo 'Final permission: [r-x---a-R-c--]';;
*) echo 'unexpected output';;
esac`
)
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
const life = async (action) => {
  const result = await execute('start-stop-status', action)
  if (result.code !== 0)
    throw new Error(
      `${action}: ${result.output}\n${await readFile(path.join(variable, 'server.log'), 'utf8').catch(() => '')}`
    )
  if (action === 'start')
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
  'x-motrix-web-origin': 'http://nas.test',
  origin: 'http://nas.test',
  'content-type': 'application/json',
}
const web = (route, headers = admin, body) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: `${variable}/web.sock`,
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
try {
  assert.equal((await execute('postinst')).code, 0)
  await life('start')
  await life('status')
  const status = JSON.parse((await web('/rpc/auth/status')).body)
  assert.equal(status.username, 'alice')
  assert.deepEqual(status.clientPairing, { cli: true, extension: false })
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
  for (const state of ['disabled', 'demoted', 'unavailable']) {
    await writeFile('/tmp/dsm-account-state', state)
    assert.equal((await rpc(Methods.TaskList, {}, token)).status, 403)
    assert.equal(JSON.parse((await web('/rpc/auth/status')).body).authed, false)
  }
  await writeFile('/tmp/dsm-account-state', 'active')
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
  assert.equal(
    (await execute('preupgrade', undefined, { SYNOPKG_PKG_STATUS: 'UPGRADE' }))
      .code,
    0
  )
  await rm(target, { recursive: true, force: true })
  await cp(path.join(project, 'app'), target, { recursive: true })
  execFileSync('chown', ['-R', '1600:1600', target])
  assert.equal(
    (await execute('postupgrade', undefined, { SYNOPKG_PKG_STATUS: 'UPGRADE' }))
      .code,
    0
  )
  await life('start')
  assert.equal((await rpc(Methods.TaskList, {}, token)).status, 200)
  assert.deepEqual(await readFile(`${downloads}/fixture.bin`), payload)
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
  assert.equal(
    (await execute('preuninst', undefined, { SYNOPKG_PKG_STATUS: 'UNINSTALL' }))
      .code,
    0
  )
  assert.ok(await stat(`${variable}/data`))
  assert.equal(
    (
      await execute('preuninst', undefined, {
        SYNOPKG_PKG_STATUS: 'UNINSTALL',
        wizard_delete_data: 'true',
      })
    ).code,
    0
  )
  assert.equal(await stat(`${variable}/data`).catch(() => null), null)
  assert.ok(await stat(downloads))
  console.log(
    'DSM Linux simulation passed: nonroot lifecycle, cookie authentication, CLI pairing, account revocation, HTTP/BT download, ACL denial, symlink denial, file deletion, upgrade persistence, stale PID, uninstall retention'
  )
} finally {
  await execute('start-stop-status', 'stop')
  seeder.kill('SIGTERM')
  fixture.close()
  await rm(root, { recursive: true, force: true })
}
