import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { 'project-dir': { type: 'string' } },
})
const project = path.resolve(values['project-dir'])
if (process.platform !== 'linux')
  throw new Error('fnOS lifecycle smoke requires Linux /proc and flock')
const root = await mkdtemp('/tmp/mtx-fpk-')
const target = path.join(root, 'target')
const data = path.join(root, 'var')
const downloads = path.join(root, 'downloads')
const apiSocket = path.join(root, 'api.sock')
const env = {
  ...process.env,
  TRIM_APPDEST: target,
  TRIM_PKGVAR: data,
  TRIM_DATA_SHARE_PATHS: downloads,
  TRIM_API_TOKEN: 'smoke-token',
  TRIM_TEMP_LOGFILE: path.join(root, 'error.log'),
  MOTRIX_FNOS_API_SOCKET: apiSocket,
}
const api = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  const value =
    body.req === 'trim.file.getSharedAccessibleFolders'
      ? { paths: [downloads] }
      : body.data.path.map((entry) => ({
          path: entry,
          readable: true,
          writable: true,
          deletable: true,
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
    const child = spawn('bash', [path.join(project, 'cmd/main'), action], {
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
const get = (route, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = request(
      { socketPath: path.join(target, 'app.sock'), path: route, headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      }
    )
    req.on('error', reject).end()
  })
try {
  await cp(path.join(project, 'app'), target, { recursive: true })
  await mkdir(data)
  await mkdir(downloads)
  await new Promise((resolve, reject) => {
    api.once('error', reject)
    api.listen(apiSocket, resolve)
  })
  const start = await lifecycle('start')
  assert.equal(
    start.code,
    0,
    `${start.output}\n${await readFile(path.join(data, 'server.log'), 'utf8').catch(() => '')}`
  )
  const first = await readFile(path.join(data, 'server-process.json'), 'utf8')
  assert.equal((await lifecycle('start')).code, 0)
  assert.equal(
    await readFile(path.join(data, 'server-process.json'), 'utf8'),
    first
  )
  assert.equal((await lifecycle('status')).code, 0)
  assert.equal((await get('/app/motrix/rpc/auth/status')).status, 401)
  const admin = {
    host: 'nas.local',
    'x-trim-userid': '1000',
    'x-trim-isadmin': 'true',
    'x-trim-username': 'admin',
  }
  const auth = await get('/app/motrix/rpc/auth/status', admin)
  assert.equal(auth.status, 200)
  assert.equal(JSON.parse(auth.body).mode, 'fnosGateway')
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
  await writeFile(path.join(data, 'motrix/persistence-probe'), 'preserved')
  assert.equal((await lifecycle('stop')).code, 0)
  assert.equal((await lifecycle('status')).code, 3)
  assert.equal((await lifecycle('start')).code, 0)
  assert.equal(
    await readFile(path.join(data, 'motrix/persistence-probe'), 'utf8'),
    'preserved'
  )
  assert.equal((await lifecycle('stop')).code, 0)
  // A stale/reused PID must never signal an unrelated process.
  await writeFile(
    path.join(data, 'server-process.json'),
    JSON.stringify({ pid: process.pid, started: '1', boot: 'stale' })
  )
  assert.equal((await lifecycle('stop')).code, 0)
  console.log(
    `fnOS lifecycle smoke passed: ${process.arch}, uid=${process.getuid()}, start/status/stop/restart, gateway auth, data retention, stale PID`
  )
} finally {
  await lifecycle('stop')
  await new Promise((resolve) => api.close(resolve))
  await rm(root, { recursive: true, force: true })
}
