import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { listenNas } from '../nas/listener'

export function dsmDefaultSaveDir(
  current: string,
  configured: string,
  rootsValue: string | undefined
): string {
  const roots = rootsValue?.split(':').filter(Boolean) ?? []
  const normalized = path.posix.resolve(current)
  return roots.length > 0 &&
    !roots.some(
      (root) => normalized === root || normalized.startsWith(`${root}/`)
    )
    ? configured
    : current
}

export function synologyRuntime(env: NodeJS.ProcessEnv = process.env) {
  if (env.MOTRIX_AUTH_MODE !== 'synologyDsm') return undefined
  const variable = env.SYNOPKG_PKGVAR
  if (
    !variable ||
    !path.isAbsolute(variable) ||
    env.MOTRIX_WEB_BASE_PATH !== '/motrix'
  )
    throw new Error('Invalid DSM runtime configuration')
  if (process.getuid?.() === 0)
    throw new Error('DSM Server must run as the package account')
  return {
    socketPath: path.join(variable, 'web.sock'),
    clientSocketPath: path.join(variable, 'client.sock'),
    variable,
    configFile: path.join(variable, 'directories.json'),
  }
}

/** DSM provisions the supplementary http group through conf/privilege.
 * Read the system-assigned GID instead of assuming a numeric value. */
export function dsmGatewayGroup(contents: string, groups: number[]): number {
  const entries = contents
    .split('\n')
    .filter((line) => line.startsWith('http:'))
  if (entries.length !== 1) throw new Error('DSM http group is unavailable')
  const fields = entries[0].split(':')
  const gid = Number(fields[2])
  if (
    fields.length !== 4 ||
    !/^[1-9]\d*$/.test(fields[2]) ||
    !Number.isSafeInteger(gid) ||
    gid >= 0xffffffff ||
    !groups.includes(gid)
  )
    throw new Error('DSM http group is not assigned to the package account')
  return gid
}

export async function dsmGatewayGroupId() {
  const info = await stat('/etc/group')
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0)
    throw new Error('Untrusted DSM group database')
  return dsmGatewayGroup(
    await readFile('/etc/group', 'utf8'),
    process.getgroups?.() ?? []
  )
}

export async function listenSynology(app: FastifyInstance, socketPath: string) {
  await listenNas(app, socketPath, await dsmGatewayGroupId())
}
