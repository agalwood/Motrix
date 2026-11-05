import path from 'node:path'

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
    configFile: path.join(variable, 'directories.json'),
  }
}
