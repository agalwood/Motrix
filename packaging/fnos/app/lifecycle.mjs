import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export function runtimeEnvironment(env) {
  for (const key of ['TRIM_APPDEST', 'TRIM_PKGVAR']) {
    if (!env[key] || !path.isAbsolute(env[key]))
      throw new Error(`Missing ${key}`)
  }
  const shares = (env.TRIM_DATA_SHARE_PATHS ?? '').split(':').filter(Boolean)
  if (shares.length !== 1 || !path.isAbsolute(shares[0]))
    throw new Error('The Motrix download share is unavailable')
  const clientPort = env.wizard_client_port || env.TRIM_SERVICE_PORT || '16802'
  if (
    !/^[0-9]{1,5}$/.test(clientPort) ||
    Number(clientPort) < 1024 ||
    Number(clientPort) > 65535
  )
    throw new Error('Client port must be between 1024 and 65535')
  const server = path.join(env.TRIM_APPDEST, 'server')
  const data = path.join(env.TRIM_PKGVAR, 'motrix')
  return {
    ...env,
    NODE_ENV: 'production',
    PATH: `${env.TRIM_APPDEST}/runtime/bin:${env.PATH ?? '/usr/bin:/bin'}`,
    MOTRIX_AUTH_MODE: 'fnosGateway',
    MOTRIX_WEB_BASE_PATH: '/app/motrix',
    MOTRIX_MDXP_HOST: '0.0.0.0',
    MOTRIX_MDXP_PORT: String(Number(clientPort)),
    // The Server's shared URL parser owns validation. Invalid optional client
    // configuration closes that surface without preventing the gateway UI.
    MOTRIX_REMOTE_EXTENSION_ENABLED: env.wizard_extension_enabled || 'false',
    MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: env.wizard_extension_url || '',
    MOTRIX_PUBLIC_URL: env.wizard_operator_url || '',
    MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP:
      env.wizard_allow_operator_http || 'false',
    MOTRIX_DATA_DIR: data,
    MOTRIX_TEMP_DIR: `${data}/tmp`,
    MOTRIX_PLUGIN_DIR: `${data}/plugins`,
    MOTRIX_EXTRA_DIR: `${server}/extra`,
    MOTRIX_ARIA2_BIN: `${server}/bin/aria2c`,
    MOTRIX_FINALIZE_FS_BIN: `${server}/bin/motrix-finalize-fs`,
    MOTRIX_RENDERER_DIR: `${server}/dist/renderer-web`,
    MOTRIX_BUILTIN_PLUGIN_DIR: `${server}/builtin-plugins`,
    MOTRIX_DEFAULT_SAVE_DIR: shares[0],
    MOTRIX_ALLOWED_SAVE_DIRS: shares[0],
    MOTRIX_HOST_LANGUAGE: env.TRIM_SYS_LANGUAGE ?? 'zh-CN',
  }
}

export function processStartTime(contents) {
  const fields = contents
    .slice(contents.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)
  return fields[0] === 'Z' ? undefined : fields[19]
}

export function matchesEntrypoint(command, entry) {
  const args = command.split('\0')
  if (args.at(-1) === '') args.pop()
  let index = 1
  // Execution wrappers may prepend Node preload/optimization options. Match
  // the script operand, never a later argument to an unrelated script.
  while (index < args.length) {
    if (args[index] === '--no-opt' || args[index].startsWith('--require='))
      index += 1
    else if (args[index] === '-r' || args[index] === '--require') index += 2
    else break
  }
  return args[index] === entry && index === args.length - 1
}

async function identity(pid, executable, entry) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
  try {
    const [info, command, exe, boot] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
      realpath(`/proc/${pid}/exe`),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ])
    const started = processStartTime(info)
    if (
      !started ||
      exe !== (await realpath(executable)) ||
      !matchesEntrypoint(command, entry)
    )
      return undefined
    return { pid, started, boot: boot.trim() }
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code))
      return undefined
    throw error
  }
}

export async function healthy(socketPath) {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/app/motrix/healthz' }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.setTimeout(1_000, () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}

export async function lifecycle(action, env = process.env) {
  // Stop/status must work even when downloads are unmounted or API tokens expire.
  const target = env.TRIM_APPDEST
  const variable = env.TRIM_PKGVAR
  if (!target || !variable) throw new Error('Missing fnOS application paths')
  const executable = path.join(target, 'runtime/bin/node')
  const entry = path.join(target, 'server/dist/server/index.mjs')
  const pidFile = path.join(variable, 'server-process.json')
  const socketPath = path.join(target, 'app.sock')
  const readRecord = async () => {
    try {
      return JSON.parse(await readFile(pidFile, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }
  const alive = async (record) => {
    if (!record) return false
    const current = await identity(record.pid, executable, entry)
    return (
      current?.started === record.started &&
      current?.boot === record.boot &&
      current !== undefined
    )
  }
  const stop = async (record) => {
    if (await alive(record)) {
      process.kill(record.pid, 'SIGTERM')
      const deadline = Date.now() + 60_000
      while (await alive(record)) {
        if (Date.now() >= deadline)
          throw new Error(
            'Motrix did not stop within 60 seconds; process record retained'
          )
        await delay(200)
      }
    }
    await rm(pidFile, { force: true })
  }
  const record = await readRecord()
  if (action === 'status')
    return (await alive(record)) && (await healthy(socketPath)) ? 0 : 3
  if (action === 'stop') {
    await stop(record)
    return 0
  }
  if (action !== 'start') throw new Error('Expected start, stop or status')
  if (await alive(record)) {
    if (!(await healthy(socketPath)))
      throw new Error(
        'Motrix is running but is not healthy; inspect server.log'
      )
    return 0
  }
  const runtime = runtimeEnvironment(env)
  if (!runtime.TRIM_API_TOKEN)
    throw new Error('fnOS did not supply an API token')
  // Missing shares are never recreated: that might write into an unmounted volume.
  if (!(await stat(runtime.MOTRIX_DEFAULT_SAVE_DIR)).isDirectory())
    throw new Error('Download share unavailable')
  await access(executable)
  await mkdir(runtime.MOTRIX_DATA_DIR, { recursive: true, mode: 0o700 })
  await chmod(runtime.MOTRIX_DATA_DIR, 0o700)
  const logPath = path.join(variable, 'server.log')
  const logStat = await stat(logPath).catch(() => undefined)
  if (logStat?.size > 8 * 1024 * 1024) await rename(logPath, `${logPath}.1`)
  const log = await open(logPath, 'a', 0o600)
  let child
  try {
    child = spawn(executable, [entry], {
      cwd: path.dirname(entry),
      env: runtime,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    })
    await once(child, 'spawn')
  } finally {
    await log.close()
  }
  child.unref()
  const started = await identity(child.pid, executable, entry)
  if (!started)
    throw new Error('Motrix exited during startup; inspect server.log')
  const temporary = `${pidFile}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(started)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temporary, pidFile)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && (await alive(started))) {
      if (await healthy(socketPath)) return 0
      await delay(250)
    }
    throw new Error('Motrix startup health check failed; inspect server.log')
  } catch (error) {
    await stop(started)
    throw error
  } finally {
    await rm(temporary, { force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.umask(0o077)
  lifecycle(process.argv[2])
    .then((code) => {
      process.exitCode = code
    })
    .catch(async (error) => {
      const message = `${error.message}\n`
      if (process.env.TRIM_TEMP_LOGFILE)
        await writeFile(process.env.TRIM_TEMP_LOGFILE, message).catch(() => {})
      process.stderr.write(message)
      process.exitCode = 1
    })
}
