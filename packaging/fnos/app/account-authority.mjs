import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_DATABASE_BYTES = 512 * 1024
const MAX_REQUEST_BYTES = 1024
const unavailable = () => new Error('Account authority unavailable')
const uint = (value) =>
  (typeof value === 'string' || typeof value === 'number') &&
  /^(0|[1-9]\d*)$/.test(String(value)) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) < 0xffffffff
const rows = (text, fields) => {
  if (text.includes('\0')) throw unavailable()
  return text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const result = line.split(':')
      if (result.length !== fields) throw unavailable()
      return result
    })
}

/** Pure parser. Password material is used only as keyed revision input and is
 * never returned, logged or persisted. A login shell is not an account flag. */
export function accountFromSnapshot(snapshot, uid, key, now = Date.now()) {
  if (!uint(uid) || !Buffer.isBuffer(key) || key.length !== 32)
    throw unavailable()
  const users = rows(snapshot.passwd, 7).filter(
    (row) => uint(row[2]) && Number(row[2]) === Number(uid)
  )
  if (users.length !== 1) return null
  const user = users[0]
  const username = user[0]
  if (
    !username ||
    username.length > 256 ||
    /[\r\n]/.test(username) ||
    !uint(user[3])
  )
    throw unavailable()
  if (
    rows(snapshot.passwd, 7).filter((row) => row[0] === username).length !== 1
  )
    throw unavailable()
  const passwords = rows(snapshot.shadow, 9).filter(
    (row) => row[0] === username
  )
  if (passwords.length !== 1) return null
  const shadow = passwords[0]
  const password = shadow[1]
  if (!password.startsWith('$')) return null // locked, empty or unsupported verifier
  const days = (value) =>
    value === ''
      ? -1
      : /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : NaN
  const changed = days(shadow[2])
  const maximum = days(shadow[4])
  const expires = days(shadow[7])
  if (![changed, maximum, expires].every(Number.isFinite)) throw unavailable()
  const today = Math.floor(now / 86_400_000)
  if (
    changed === 0 ||
    (expires >= 0 && today >= expires) ||
    (changed >= 0 && maximum >= 0 && today > changed + maximum)
  )
    return null
  const admins = rows(snapshot.group, 4).filter(
    (row) => row[0] === 'Administrators'
  )
  if (admins.length !== 1 || !uint(admins[0][2])) throw unavailable()
  const administrator =
    Number(user[3]) === Number(admins[0][2]) ||
    admins[0][3].split(',').includes(username)
  return {
    platform: 'fnos',
    userId: String(Number(uid)),
    username,
    administrator,
    accountRevision: createHmac('sha256', key)
      .update(JSON.stringify([Number(uid), username, password, changed]))
      .digest('hex'),
  }
}

async function readSystemFile(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.uid !== 0n ||
      (before.mode & 0o022n) !== 0n ||
      before.size > BigInt(MAX_DATABASE_BYTES)
    )
      throw unavailable()
    const buffer = Buffer.alloc(MAX_DATABASE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length
      )
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const named = await lstat(file, { bigint: true })
    if (
      length > MAX_DATABASE_BYTES ||
      before.ino !== named.ino ||
      before.dev !== named.dev ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size
    )
      throw unavailable()
    return {
      text: buffer.subarray(0, length).toString('utf8'),
      info: after,
      file,
    }
  } finally {
    await handle.close()
  }
}

export async function readSystemSnapshot() {
  const values = await Promise.all(
    ['/etc/passwd', '/etc/group', '/etc/shadow'].map(readSystemFile)
  )
  for (const value of values) {
    const current = await lstat(value.file, { bigint: true })
    if (
      current.ino !== value.info.ino ||
      current.dev !== value.info.dev ||
      current.ctimeNs !== value.info.ctimeNs
    )
      throw unavailable()
  }
  return {
    passwd: values[0].text,
    group: values[1].text,
    shadow: values[2].text,
  }
}

export async function loadAuthorityKey(directory) {
  if (
    process.platform !== 'linux' ||
    process.geteuid?.() !== 0 ||
    !path.isAbsolute(directory) ||
    path.basename(directory) !== '.nas-account-authority'
  )
    throw unavailable()
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  const dir = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  )
  try {
    const info = await dir.stat()
    if (info.uid !== 0 || (info.mode & 0o077) !== 0) throw unavailable()
    // Open through the held directory descriptor, not a mutable parent path.
    const base = `/proc/self/fd/${dir.fd}`
    const filename = `${base}/authority.key`
    const temporary = `${base}/.key-${randomUUID()}`
    const existing = await lstat(filename).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!existing) {
      const fresh = await open(temporary, 'wx', 0o600)
      try {
        await fresh.writeFile(randomBytes(32))
        await fresh.sync()
        await link(temporary, filename).catch((error) => {
          if (error.code !== 'EEXIST') throw error
        })
      } finally {
        await fresh.close()
        await unlink(temporary)
      }
      await dir.sync()
    }
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const state = await file.stat()
      if (
        !state.isFile() ||
        state.uid !== 0 ||
        (state.mode & 0o077) !== 0 ||
        state.size !== 32
      )
        throw unavailable()
      const key = await file.readFile()
      if (key.length !== 32) throw unavailable()
      return key
    } finally {
      await file.close()
    }
  } finally {
    await dir.close()
  }
}

/** Privileged, local-only service. The root-owned socket parent must be
 * provisioned by the lifecycle launcher; this service never changes it. */
export async function startAccountAuthority({
  socketPath,
  stateDirectory,
  groupId,
  snapshot = readSystemSnapshot,
}) {
  if (
    process.platform !== 'linux' ||
    process.geteuid?.() !== 0 ||
    !uint(groupId) ||
    !path.isAbsolute(socketPath)
  )
    throw unavailable()
  const parent = await lstat(path.dirname(socketPath))
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0 ||
    (parent.mode & 0o022) !== 0
  )
    throw unavailable()
  const old = await lstat(socketPath).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (old) {
    if (!old.isSocket() || old.uid !== 0) throw unavailable()
    await new Promise((resolve, reject) => {
      const probe = connect(socketPath)
      probe.setTimeout(1000, () => {
        probe.destroy()
        reject(unavailable())
      })
      probe.once('connect', () => {
        probe.destroy()
        reject(unavailable())
      })
      probe.once('error', (error) =>
        error.code === 'ECONNREFUSED' ? resolve() : reject(unavailable())
      )
    })
    const current = await lstat(socketPath)
    if (current.dev !== old.dev || current.ino !== old.ino) throw unavailable()
    await unlink(socketPath)
  }
  const key = await loadAuthorityKey(stateDirectory)
  const clients = new Set()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(1000, () => socket.destroy())
    let bytes = Buffer.alloc(0)
    let handled = false
    socket.on('data', (chunk) => {
      if (handled) return
      if (bytes.length + chunk.length > MAX_REQUEST_BYTES) {
        socket.destroy()
        return
      }
      bytes = Buffer.concat([bytes, chunk])
      if (!bytes.includes(10)) return
      handled = true
      socket.pause()
      void (async () => {
        try {
          const request = JSON.parse(bytes.toString('utf8'))
          if (
            !request ||
            Object.keys(request).length !== 2 ||
            request.version !== 1 ||
            !uint(request.uid)
          )
            throw unavailable()
          const identity = accountFromSnapshot(
            await snapshot(),
            request.uid,
            key
          )
          socket.end(
            `${JSON.stringify({ version: 1, ok: true, identity })}\n`,
            () => socket.destroy()
          )
        } catch {
          socket.end('{"version":1,"ok":false,"error":"unavailable"}\n', () =>
            socket.destroy()
          )
        }
      })()
    })
  })
  server.maxConnections = 32
  server.on('error', () => {})
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await chown(socketPath, 0, Number(groupId))
    await chmod(socketPath, 0o660)
  } catch (error) {
    for (const socket of clients) socket.destroy()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    key.fill(0)
    throw error
  }
  let closing
  return {
    close() {
      closing ??= new Promise((resolve, reject) => {
        for (const socket of clients) socket.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
      }).finally(() => key.fill(0))
      return closing
    },
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { parseArgs } = await import('node:util')
    const { values } = parseArgs({
      options: {
        socket: { type: 'string' },
        state: { type: 'string' },
        gid: { type: 'string' },
      },
    })
    const authority = await startAccountAuthority({
      socketPath: values.socket,
      stateDirectory: values.state,
      groupId: values.gid,
    })
    const close = () => {
      void authority.close().then(
        () => process.exit(0),
        () => process.exit(1)
      )
    }
    process.once('SIGTERM', close)
    process.once('SIGINT', close)
  } catch {
    process.stderr.write('Account authority unavailable\n')
    process.exitCode = 1
  }
}
