// Invoked only with the verified runtime by the root-owned cmd/main launcher.
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const runtime = '/run/motrix-account-authority'
const socketPath = path.join(runtime, 'account.sock')
const recordPath = path.join(runtime, 'process.json')
const entry = fileURLToPath(new URL('./account-authority.mjs', import.meta.url))
const executableDirectory = path.join(path.dirname(entry), '.authority-runtime')
const error = () => new Error('Motrix account authority lifecycle unavailable')
const target = process.env.TRIM_APPDEST
const data = process.env.TRIM_PKGVAR
const action = process.argv[2]

function packageIds() {
  const uid = Number(
    execFileSync('/usr/bin/id', ['-u', 'motrix'], { encoding: 'utf8' }).trim()
  )
  const gid = Number(
    execFileSync('/usr/bin/getent', ['group', 'motrix'], {
      encoding: 'utf8',
    }).split(':')[2]
  )
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(gid) ||
    gid <= 0
  )
    throw error()
  return { uid, gid }
}
async function protectedFile(file, directory = false) {
  const info = await lstat(file)
  if (
    info.uid !== 0 ||
    (info.mode & 0o022) !== 0 ||
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile())
  )
    throw error()
}
async function identity(pid, executable) {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !/^node-[a-f0-9]{64}$/.test(path.basename(executable)) ||
    path.dirname(executable) !== executableDirectory
  )
    return null
  try {
    const [contents, command, exe, boot, status] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
      realpath(`/proc/${pid}/exe`),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8'),
    ])
    const fields = contents
      .slice(contents.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)
    const args = command.split('\0').filter(Boolean)
    if (
      fields[0] === 'Z' ||
      exe !== executable ||
      args[1] !== entry ||
      !/^Uid:\s+0\s+0\s+0\s+0$/m.test(status)
    )
      return null
    return { pid, executable, started: fields[19], boot: boot.trim() }
  } catch (cause) {
    if (['ENOENT', 'ESRCH'].includes(cause.code)) return null
    throw cause
  }
}
async function record() {
  try {
    await protectedFile(recordPath)
    const value = JSON.parse(await readFile(recordPath, 'utf8'))
    const current = await identity(value.pid, value.executable ?? '')
    return current?.started === value.started && current?.boot === value.boot
      ? current
      : null
  } catch (cause) {
    if (cause.code === 'ENOENT') return null
    throw cause
  }
}
async function healthy() {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    let result = ''
    const finish = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1500, () => finish(false))
    socket.on('error', () => finish(false))
    socket.on('data', (chunk) => {
      result += chunk.toString('utf8')
      if (result.length > 8192) finish(false)
    })
    socket.once('connect', () => socket.end('{"version":1,"uid":0}\n'))
    socket.once('end', () => {
      try {
        const response = JSON.parse(result)
        finish(response.version === 1 && response.ok === true)
      } catch {
        finish(false)
      }
    })
  })
}
async function listenerExists() {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.setTimeout(1000, () => {
      socket.destroy()
      reject(error())
    })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (cause) => {
      if (['ENOENT', 'ECONNREFUSED'].includes(cause.code)) resolve(false)
      else reject(error())
    })
  })
}
async function stopAuthority() {
  const current = await record()
  if (current) {
    process.kill(current.pid, 'SIGTERM')
    const deadline = Date.now() + 5000
    while (await record()) {
      if (Date.now() >= deadline) throw error()
      await delay(50)
    }
  }
  // An unrecorded live helper is not ours to signal or silently leave running.
  if (await listenerExists()) throw error()
  await rm(recordPath, { force: true })
  // Keep the current launcher runtime; remove obsolete pinned copies only
  // after both the owned process and the local listener have stopped.
  for (const file of await readdir(executableDirectory)) {
    const candidate = path.join(executableDirectory, file)
    if (/^node-[a-f0-9]{64}$/.test(file) && candidate !== process.execPath) {
      await protectedFile(candidate)
      await rm(candidate)
    }
  }
}
async function startAuthority(gid) {
  const current = await record()
  if (current) {
    if (!(await healthy())) throw error()
    return
  }
  if (await listenerExists()) throw error()
  const log = await open(path.join(runtime, 'authority.log'), 'a', 0o600)
  let child
  try {
    child = spawn(
      process.execPath,
      [
        entry,
        '--socket',
        socketPath,
        '--state',
        path.join(data, '.nas-account-authority'),
        '--gid',
        String(gid),
      ],
      {
        cwd: runtime,
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      }
    )
    await once(child, 'spawn')
  } finally {
    await log.close()
  }
  child.unref()
  const started = await identity(child.pid, process.execPath)
  if (!started) throw error()
  const temporary = `${recordPath}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(started)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temporary, recordPath)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (await record())) {
      if (await healthy()) return
      await delay(50)
    }
    throw error()
  } catch (cause) {
    // Do not leave an unrecorded privileged child behind if persistence failed.
    if (await identity(child.pid, process.execPath))
      process.kill(child.pid, 'SIGTERM')
    await stopAuthority()
    throw cause
  } finally {
    await rm(temporary, { force: true })
  }
}
async function application(action) {
  const child = spawn(
    '/usr/sbin/runuser',
    [
      '-u',
      'motrix',
      '-g',
      'motrix',
      '--',
      path.join(target, 'runtime/bin/node'),
      path.join(target, 'lifecycle.mjs'),
      action,
    ],
    {
      cwd: '/',
      env: { ...process.env, MOTRIX_NAS_ACCOUNT_SOCKET: socketPath },
      stdio: 'inherit',
    }
  )
  const [code] = await once(child, 'exit')
  return code ?? 1
}
async function main() {
  if (
    process.platform !== 'linux' ||
    process.geteuid?.() !== 0 ||
    !['start', 'stop', 'status'].includes(action) ||
    !target ||
    !path.isAbsolute(target) ||
    !data ||
    !path.isAbsolute(data)
  )
    throw error()
  await protectedFile(runtime, true)
  await protectedFile(path.dirname(entry), true)
  await protectedFile(executableDirectory, true)
  await protectedFile(entry)
  await protectedFile(fileURLToPath(import.meta.url))
  const { gid } = packageIds()
  if (action === 'stop') {
    const code = await application('stop')
    if (code !== 0) return code
    await stopAuthority()
    return 0
  }
  if (action === 'status')
    return (await record()) &&
      (await healthy()) &&
      (await application('status')) === 0
      ? 0
      : 3
  await startAuthority(gid)
  try {
    const code = await application('start')
    if (code !== 0) await stopAuthority()
    return code
  } catch (cause) {
    await stopAuthority()
    throw cause
  }
}
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch(() => {
    // Root never writes the package-controlled TRIM_TEMP_LOGFILE or app log.
    process.stderr.write('Motrix account authority lifecycle unavailable\n')
    process.exitCode = 1
  })
