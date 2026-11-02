import { chmod, lstat, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

export function fnosRuntime(env: NodeJS.ProcessEnv = process.env) {
  if (env.MOTRIX_AUTH_MODE === undefined || env.MOTRIX_AUTH_MODE === 'operator')
    return undefined
  if (env.MOTRIX_AUTH_MODE !== 'fnosGateway')
    throw new Error('Invalid MOTRIX_AUTH_MODE')
  const target = env.TRIM_APPDEST
  if (!target || !path.isAbsolute(target))
    throw new Error('fnOS requires TRIM_APPDEST')
  if (env.MOTRIX_WEB_BASE_PATH !== '/app/motrix')
    throw new Error('fnOS requires /app/motrix as its base path')
  return { socketPath: path.join(target, 'app.sock') }
}

export async function listenFnos(
  app: FastifyInstance,
  socketPath: string
): Promise<void> {
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
  await app.listen({ path: socketPath })
  // Only the package account and root gateway may submit identity headers.
  await chmod(socketPath, 0o600)
}
