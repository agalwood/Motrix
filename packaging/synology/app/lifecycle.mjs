import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { constants } from 'node:fs'
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

async function readPackageDocument(file, limit = 32 * 1024) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      info.size > limit
    )
      throw new Error('Untrusted DSM package configuration')
    const data = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        data.length - offset,
        offset
      )
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > limit) throw new Error('DSM package configuration too large')
    try {
      return JSON.parse(data.subarray(0, offset).toString('utf8'))
    } catch {
      throw new Error('Invalid DSM package configuration')
    }
  } finally {
    await handle.close()
  }
}

export async function runtimeEnvironment(env) {
  const target = env.SYNOPKG_PKGDEST
  const variable = env.SYNOPKG_PKGVAR
  if (![target, variable].every((p) => p && path.isAbsolute(p)))
    throw new Error('Missing DSM package paths')
  const settings = await readPackageDocument(
    path.join(variable, 'package-settings.json')
  )
  const configFile = path.join(variable, 'directories.json')
  let directories
  try {
    directories = await readPackageDocument(configFile, 36 * 1024)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const share = await realpath('/var/packages/Motrix/shares/motrix')
    directories = { roots: [share] }
    await writeFile(configFile, JSON.stringify(directories), {
      flag: 'wx',
      mode: 0o600,
    })
  }
  const server = path.join(target, 'server')
  const data = path.join(variable, 'data')
  return {
    PATH: `${target}/runtime/bin:/usr/bin:/bin`,
    NODE_ENV: 'production',
    HOME: env.SYNOPKG_PKGHOME || variable,
    SYNOPKG_PKGVAR: variable,
    SYNOPKG_PKGDEST: target,
    MOTRIX_AUTH_MODE: 'synologyDsm',
    MOTRIX_WEB_BASE_PATH: '/motrix',
    MOTRIX_MDXP_HOST: '0.0.0.0',
    MOTRIX_MDXP_PORT: String(settings.clientPort),
    MOTRIX_REMOTE_EXTENSION_ENABLED: settings.extensionUrl ? 'true' : 'false',
    MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: settings.extensionUrl,
    MOTRIX_PUBLIC_URL: settings.operatorUrl,
    MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: settings.allowHttp ? 'true' : 'false',
    MOTRIX_DATA_DIR: data,
    MOTRIX_TEMP_DIR: `${data}/tmp`,
    MOTRIX_PLUGIN_DIR: `${data}/plugins`,
    MOTRIX_EXTRA_DIR: `${server}/extra`,
    MOTRIX_ARIA2_BIN: `${server}/bin/aria2c`,
    MOTRIX_FINALIZE_FS_BIN: `${server}/bin/motrix-finalize-fs`,
    MOTRIX_RENDERER_DIR: `${server}/dist/renderer-web`,
    MOTRIX_BUILTIN_PLUGIN_DIR: `${server}/builtin-plugins`,
    MOTRIX_DEFAULT_SAVE_DIR: directories.roots[0],
    MOTRIX_ALLOWED_SAVE_DIRS: directories.roots.join(':'),
  }
}

export async function configure(env) {
  const destination = path.join(env.SYNOPKG_PKGVAR, 'package-settings.json')
  if (await stat(destination).catch(() => undefined)) return
  const port = env.wizard_client_port || '16802'
  if (!/^[0-9]{4,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error('Client port must be between 1024 and 65535')
  await writeFile(
    destination,
    JSON.stringify({
      clientPort: Number(port),
      extensionUrl: env.wizard_extension_url || '',
      operatorUrl: env.wizard_operator_url || '',
      allowHttp: env.wizard_allow_operator_http === 'true',
    }),
    { flag: 'wx', mode: 0o600 }
  )
}

/** Apply the administrator's restart journal before any new application process
 * starts. Retain it on failure so interrupted two-file application is replayable. */
export async function applyPendingSettings(env) {
  const variable = env.SYNOPKG_PKGVAR
  const pending = path.join(variable, 'pending-settings.json')
  let value
  try {
    value = await readPackageDocument(pending, 36 * 1024)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (
    !value ||
    Object.keys(value)
      .filter((key) => key !== 'directoryIdentities')
      .sort()
      .join(',') !== 'allowHttp,clientPort,extensionUrl,operatorUrl,roots' ||
    !Number.isInteger(value.clientPort) ||
    value.clientPort < 1024 ||
    value.clientPort > 65535 ||
    typeof value.allowHttp !== 'boolean' ||
    !['extensionUrl', 'operatorUrl'].every(
      (key) =>
        typeof value[key] === 'string' &&
        value[key].length <= 2048 &&
        !/\p{Cc}/u.test(value[key])
    ) ||
    !Array.isArray(value.roots) ||
    value.roots.length < 1 ||
    value.roots.length > 64 ||
    !value.roots.every(
      (root) =>
        typeof root === 'string' &&
        root.length <= 4096 &&
        /^\/volume[1-9]\d*\/[^:]+$/.test(root) &&
        !/\p{Cc}/u.test(root) &&
        root
          .split('/')
          .slice(1)
          .every((part) => part && part !== '.' && part !== '..')
    )
  )
    throw new Error('Invalid pending package settings')
  const { roots, directoryIdentities: pendingIdentities, ...settings } = value
  let directoryIdentities = pendingIdentities
  if (directoryIdentities === undefined) {
    // A replay of an old path-only journal must not discard a grant that
    // already has an identity. First upgrades from path-only grants still work.
    const previous = await readPackageDocument(
      path.join(variable, 'directories.json'),
      36 * 1024
    ).catch((error) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (previous?.directoryIdentities !== undefined) {
      directoryIdentities = roots.map(
        (root) => previous.directoryIdentities[previous.roots.indexOf(root)]
      )
    }
  }
  if (
    directoryIdentities !== undefined &&
    (!Array.isArray(directoryIdentities) ||
      directoryIdentities.length !== roots.length ||
      !directoryIdentities.every(
        (id) => typeof id === 'string' && /^\d{1,20}:\d{1,20}$/.test(id)
      ))
  ) {
    throw new Error('Invalid pending directory identities')
  }
  for (const [name, data] of [
    ['package-settings.json', settings],
    ['directories.json', { roots, directoryIdentities }],
  ]) {
    const temporary = path.join(variable, `${name}.${randomUUID()}.next`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(data)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, path.join(variable, name))
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const directory = await open(variable, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
  await rm(pending)
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
    const req = request({ socketPath, path: '/motrix/healthz' }, (res) => {
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
  const target = env.SYNOPKG_PKGDEST
  const variable = env.SYNOPKG_PKGVAR
  if (!target || !variable) throw new Error('Missing DSM application paths')
  const executable = path.join(target, 'runtime/bin/node')
  const entry = path.join(target, 'server/dist/server/index.mjs')
  const pidFile = path.join(variable, 'server-process.json')
  const socketPath = path.join(variable, 'web.sock')
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
  if (process.getuid?.() === 0)
    throw new Error('DSM lifecycle must run as the package account')
  if (action === 'postinst' || action === 'postupgrade') {
    await configure(env)
    return 0
  }
  const record = await readRecord()
  if (action === 'preupgrade' || action === 'preuninst') {
    await stop(record)
    if (
      action === 'preuninst' &&
      env.SYNOPKG_PKG_STATUS === 'UNINSTALL' &&
      env.wizard_delete_data === 'true'
    ) {
      await rm(path.join(variable, 'data'), { recursive: true, force: true })
      for (const name of [
        'package-settings.json',
        'directories.json',
        'pending-settings.json',
      ])
        await rm(path.join(variable, name), { force: true })
    }
    return 0
  }
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
  await configure(env)
  await applyPendingSettings(env)
  const runtime = await runtimeEnvironment(env)
  // The Server checks existing shares before opening its database or engine.
  // Unavailable grants start the authenticated settings surface only.
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
      if (process.env.SYNOPKG_TEMP_LOGFILE)
        await writeFile(process.env.SYNOPKG_TEMP_LOGFILE, message).catch(
          () => {}
        )
      process.stderr.write(message)
      process.exitCode = 1
    })
}
