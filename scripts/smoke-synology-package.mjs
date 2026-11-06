import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  access,
  chmod,
  chown,
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
function grantAuthority() {
  // Simulate DSM's declared tool worker only before starting any package process.
  execFileSync('python3', [
    '-c',
    'import os,struct,sys;os.setxattr(sys.argv[1],"security.capability",struct.pack("<IIIII",0x02000001,(1<<6)|(1<<7)|(1<<8),0,0,0))',
    `${target}/bin/motrix-dsm-authority`,
  ])
}
grantAuthority()

// These programs simulate DSM authority responses. They are never packaged.
// No passwords or actual DSM cookies are used by this Linux acceptance test.
await writeFile('/tmp/dsm-session-state', 'active')
await writeFile('/tmp/dsm-account-state', 'active')
await writeFile('/tmp/dsm-acl-state', 'allow')
const mock = async (file, body) => {
  await writeFile(
    file,
    `#!/bin/sh\n[ "$(id -u)" = 0 ] || exit 91\ncase "$(awk '/^CapEff:/ {print $2}' /proc/$$/status)" in 0000000000000002|0000000000000006) ;; *) exit 92 ;; esac\n[ -z "$LD_PRELOAD$NODE_OPTIONS$SSH_AUTH_SOCK" ] || exit 93\n${body}\n`
  )
  await chmod(file, 0o755)
}
await mock(
  '/usr/syno/synoman/webman/authenticate.cgi',
  '[ "$(cat /tmp/dsm-session-state)" = active ] || exit 5; [ "$HTTP_COOKIE" = "id=synthetic-session" ] && [ "$REMOTE_ADDR" = 127.0.0.1 ] && [ "$SERVER_PORT" = 5000 ] && [ "$REQUEST_SCHEME" = http ] && printf alice'
)
await chown('/usr/syno/synoman/webman/authenticate.cgi', 1, 1)
await symlink(
  '../authenticate.cgi',
  '/usr/syno/synoman/webman/modules/authenticate.cgi'
)
await mock(
  '/usr/syno/sbin/synouser',
  `
[ "$1" = --get ] || exit 1
if [ "$2" = timeout ]; then exec sleep 20; fi
if [ "$2" = motrix ]; then printf 'User Name : [motrix]\\nUser Type : [AUTH_LOCAL]\\nUser uid : [1600]\\nExpired : [false]\\n'; exit 0; fi
[ "$2" = alice ] || exit 1
state=$(cat /tmp/dsm-account-state)
[ "$state" != unavailable ] || exit 1
printf 'User Name : [alice]\\nUser Type : [AUTH_LOCAL]\\nUser uid : [1700]\\n'
if [ "$state" = disabled ]; then echo 'Expired : [true]'; else echo 'Expired : [false]'; fi
if [ "$state" = demoted ]; then echo 'Member Of : [0]'; else echo 'Member Of : [1]'; echo '(101) administrators'; fi
exit 0`
)
await mock(
  '/usr/syno/bin/synoacltool',
  `
[ "$1" = -get-perm ] && [ "$3" = alice ] || exit 1
case "$2" in /proc/self/fd/*) ;; *) exit 94 ;; esac
[ -e "$2" ] || exit 95
case "$(cat /tmp/dsm-acl-state)" in
allow) echo 'Final permission: [rwxpdDaARWcCo]';;
readonly) echo 'Final permission: [r-x---a-R-c--]';;
*) echo 'unexpected output';;
esac`
)
await chmod('/usr/syno/sbin/synouser', 0o700)
for (const body of [
  { operation: 'exec', command: '/bin/sh' },
  { operation: 'account', username: '--add' },
  { operation: 'acl', username: 'alice', path: '/etc/shadow' },
  { operation: 'session', context: { LD_PRELOAD: '/tmp/injection.so' } },
]) {
  const result = spawnSync(
    'runuser',
    ['-u', 'motrix', '--', `${target}/bin/motrix-dsm-authority`],
    { input: JSON.stringify(body), encoding: 'utf8' }
  )
  assert.equal(result.status, 126)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
}
// Exercise the privileged monitor and inherited signal state with real Linux
// credentials, not a mocked spawn. All identities/data here are synthetic.
execFileSync('runuser', [
  '-u',
  'motrix',
  '--',
  'python3',
  '-c',
  `import json,os,signal,subprocess,sys,time
tool=sys.argv[1]
started=time.monotonic()
p=subprocess.Popen([tool],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
p.stdin.write(json.dumps({"operation":"account","username":"timeout"}).encode())
p.stdin.close()
p.stdin=None
for _ in range(100):
    with open('/proc/%s/status'%p.pid) as f:
        root=any(line.startswith('Uid:') and line.split()[1:] == ['0']*4 for line in f)
    if root: break
    time.sleep(.01)
assert root, 'monitor did not enter its protected identity'
try:
    os.kill(p.pid,signal.SIGSTOP)
    raise AssertionError('package caller could suspend authority deadline')
except PermissionError: pass
out,err=p.communicate(timeout=5)
assert p.returncode == 126 and out == err == b''
assert time.monotonic()-started < 5
signal.signal(signal.SIGALRM,signal.SIG_IGN)
signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGALRM})
p=subprocess.Popen([tool],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert p.wait(timeout=8) == -signal.SIGALRM, 'incomplete stdin bypassed alarm'
p.stdin.close()
assert p.stdout.read() == p.stderr.read() == b''
`,
  `${target}/bin/motrix-dsm-authority`,
])
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
  'x-motrix-dsm-server-port': '5000',
  'x-motrix-dsm-scheme': 'http',
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
  assert.equal(
    JSON.parse((await web('/healthz', {})).body).nasAuthority
      .accountLookupProbe,
    'passed'
  )
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
    stage: 'session',
    code: 'commandFailed',
    failure: 'exit',
    exitCode: 5,
  })
  assert.equal(JSON.stringify(rejectedSession).includes('alice'), false)
  assert.equal(
    JSON.stringify(rejectedSession).includes('synthetic-session'),
    false
  )
  await writeFile('/tmp/dsm-session-state', 'active')
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
  grantAuthority()
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
    'DSM Linux simulation passed: nonroot lifecycle and gateway socket isolation, cookie authentication, CLI pairing, account revocation, HTTP/BT download, ACL denial, symlink denial, file deletion, upgrade persistence, stale PID, uninstall retention'
  )
} finally {
  await execute('start-stop-status', 'stop')
  seeder.kill('SIGTERM')
  fixture.close()
  await rm(root, { recursive: true, force: true })
}
