import { chmod, chown, lstat, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import type { FastifyInstance } from 'fastify'

export async function listenNas(
  app: FastifyInstance,
  socketPath: string,
  gatewayGroupId?: number
): Promise<void> {
  await prepareNasSocket(socketPath, gatewayGroupId)
  await app.listen({ path: socketPath })
  await secureNasSocket(socketPath, gatewayGroupId)
}

export async function prepareNasSocket(
  socketPath: string,
  gatewayGroupId?: number
): Promise<void> {
  if (
    gatewayGroupId !== undefined &&
    (!Number.isInteger(gatewayGroupId) ||
      gatewayGroupId <= 0 ||
      gatewayGroupId >= 0xffffffff ||
      !process.getgroups?.().includes(gatewayGroupId))
  )
    throw new Error('Gateway group is not available to the package account')
  const before = await lstat(socketPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  )
  if (before) {
    if (!before.isSocket() || before.uid !== process.getuid?.())
      throw new Error('Refusing to replace an unowned socket path')
    await new Promise<void>((resolve, reject) => {
      const probe = connect(socketPath)
      probe.setTimeout(1_000, () => {
        probe.destroy()
        reject(new Error('Gateway socket is busy'))
      })
      probe.once('connect', () => {
        probe.destroy()
        reject(new Error('Gateway socket is already listening'))
      })
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') resolve()
        else reject(error)
      })
    })
    const current = await lstat(socketPath)
    if (before.dev !== current.dev || before.ino !== current.ino)
      throw new Error('Gateway socket changed during startup')
    await unlink(socketPath)
  }
}

export async function secureNasSocket(
  socketPath: string,
  gatewayGroupId?: number
): Promise<void> {
  // Grant only a declared supplementary gateway group. Application state keeps
  // its private owner/modes; membership is never an authenticated NAS identity.
  if (gatewayGroupId !== undefined) await chown(socketPath, -1, gatewayGroupId)
  await chmod(socketPath, gatewayGroupId === undefined ? 0o600 : 0o660)
}
