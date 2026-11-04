// Run only in a disposable Linux container. This suite changes its local users.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startAccountAuthority } from '../../packaging/fnos/cmd/account-authority.mjs'

if (
  process.platform !== 'linux' ||
  process.geteuid?.() !== 0 ||
  process.env.MOTRIX_DISPOSABLE_ACCOUNT_TEST !== '1'
)
  throw new Error(
    'This suite requires an explicitly disposable root Linux container'
  )
await access('/.dockerenv')
const clientModule = process.env.MOTRIX_ACCOUNT_CLIENT_MODULE
if (!clientModule || !path.isAbsolute(clientModule))
  throw new Error(
    'Set MOTRIX_ACCOUNT_CLIENT_MODULE to the bundled fnOS account client'
  )
const command = (file, args, input) =>
  execFileSync(file, args, { input, stdio: ['pipe', 'pipe', 'pipe'] })
command('groupadd', ['--gid', '1600', 'motrixfixture'])
command('groupadd', ['--gid', '1700', 'Administrators'])
command('useradd', ['--uid', '1600', '--gid', '1600', 'motrixfixture'])
command('useradd', [
  '--uid',
  '1700',
  '--gid',
  '1600',
  '--groups',
  'Administrators',
  '--shell',
  '/usr/sbin/nologin',
  'alice',
])
const changePassword = () =>
  command('chpasswd', [], `alice:${randomBytes(32).toString('hex')}\n`)
changePassword()
const root = await mkdtemp('/tmp/motrix-accounts-')
await chmod(root, 0o755)
const socketPath = path.join(root, 'accounts.sock')
const stateDirectory = path.join(root, '.nas-account-authority')
const options = { socketPath, stateDirectory, groupId: 1600 }
let service
let assertions = 0
const check = async (label, action) => {
  await action()
  assertions++
  process.stdout.write(`PASS ${label}\n`)
}
const query = (socket = socketPath, abort = false) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./account-client-probe.mjs', import.meta.url)),
        clientModule,
        socket,
        path.join(stateDirectory, 'authority.key'),
        String(abort),
      ],
      {
        uid: 1600,
        gid: 1600,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let output = ''
    let errors = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      errors += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0)
        reject(new Error(`Account probe failed (${code}): ${errors}`))
      else {
        try {
          resolve(JSON.parse(output))
        } catch (error) {
          reject(error)
        }
      }
    })
  })
const rawQuery = (body) =>
  new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let response = ''
    socket.setTimeout(2000, () => {
      socket.destroy()
      reject(new Error('Protocol timeout'))
    })
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      response += chunk
    })
    socket.on('close', () => resolve(response))
    socket.on('connect', () => socket.end(body))
  })
try {
  service = await startAccountAuthority(options)
  let original
  await check(
    'unprivileged client can query an administrator but cannot read shadow or the authority key',
    async () => {
      original = await query()
      assert.equal(original.username, 'alice')
      assert.equal(original.administrator, true)
      assert.match(original.accountRevision, /^[a-f0-9]{64}$/)
      const socket = await stat(socketPath)
      assert.equal(socket.uid, 0)
      assert.equal(socket.gid, 1600)
      assert.equal(socket.mode & 0o777, 0o660)
      const shadow = await readFile('/etc/shadow', 'utf8')
      const verifier = shadow
        .split('\n')
        .find((line) => line.startsWith('alice:'))
        .split(':')[1]
      assert.ok(!JSON.stringify(original).includes(verifier))
    }
  )
  await check(
    'duplicate helper refuses the live socket without interrupting the first',
    async () => {
      await assert.rejects(startAccountAuthority(options))
      assert.deepEqual(await query(), original)
    }
  )
  await check(
    'account disable and re-enable are visible without restarting the helper',
    async () => {
      command('usermod', ['--lock', 'alice'])
      assert.equal(await query(), null)
      command('usermod', ['--unlock', 'alice'])
      assert.deepEqual(await query(), original)
    }
  )
  await check(
    'administrator demotion is visible on the next lookup',
    async () => {
      command('gpasswd', ['--delete', 'alice', 'Administrators'])
      assert.equal((await query()).administrator, false)
      command('usermod', ['--append', '--groups', 'Administrators', 'alice'])
    }
  )
  await check(
    'password replacement changes the account generation',
    async () => {
      changePassword()
      assert.notEqual((await query()).accountRevision, original.accountRevision)
    }
  )
  await check(
    'restarting the helper retains the account generation',
    async () => {
      const before = await query()
      await service.close()
      service = await startAccountAuthority(options)
      assert.deepEqual(await query(), before)
    }
  )
  await check('expired or deleted accounts cannot be authorized', async () => {
    command('chage', ['--expiredate', '1', 'alice'])
    assert.equal(await query(), null)
    command('chage', ['--expiredate', '-1', 'alice'])
    command('userdel', ['alice'])
    assert.equal(await query(), null)
  })
  await check(
    'malformed, oversized and partial protocol requests are bounded',
    async () => {
      for (const body of [
        '{\n',
        '{"version":1,"uid":[1700]}\n',
        '{"version":1,"uid":1700,"file":"/etc/shadow"}\n',
      ]) {
        assert.deepEqual(JSON.parse(await rawQuery(body)), {
          version: 1,
          ok: false,
          error: 'unavailable',
        })
      }
      assert.equal(await rawQuery('x'.repeat(2048)), '')
      assert.equal(await rawQuery('{'), '')
    }
  )
  await check(
    'client rejects cancellation, socket aliases and world-writable parent directories',
    async () => {
      const alias = path.join(root, 'alias.sock')
      await symlink(socketPath, alias)
      await assert.rejects(query(alias))
      await assert.rejects(query(socketPath, true))
      await chmod(root, 0o777)
      await assert.rejects(query())
      await chmod(root, 0o755)
    }
  )
  await check(
    'helper refuses an application-controlled state directory',
    async () => {
      const unsafe = path.join(root, 'unsafe')
      await mkdir(unsafe)
      const directory = path.join(unsafe, '.nas-account-authority')
      await mkdir(directory, { mode: 0o777 })
      await chmod(directory, 0o777)
      await assert.rejects(
        startAccountAuthority({
          ...options,
          socketPath: path.join(root, 'unsafe.sock'),
          stateDirectory: directory,
        })
      )
    }
  )
  process.stdout.write(`Account authority acceptance: ${assertions} passed\n`)
} finally {
  await service?.close()
  await rm(root, { recursive: true, force: true })
}
