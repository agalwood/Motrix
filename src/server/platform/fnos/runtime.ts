import path from 'node:path'

export { listenNas as listenFnos } from '../nas/listener'

export function fnosRuntime(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.MOTRIX_AUTH_MODE === undefined ||
    env.MOTRIX_AUTH_MODE === 'operator' ||
    env.MOTRIX_AUTH_MODE === 'synologyDsm'
  )
    return undefined
  if (env.MOTRIX_AUTH_MODE !== 'fnosGateway')
    throw new Error('Invalid MOTRIX_AUTH_MODE')
  const target = env.TRIM_APPDEST
  if (!target || !path.isAbsolute(target))
    throw new Error('fnOS requires TRIM_APPDEST')
  if (env.MOTRIX_WEB_BASE_PATH !== '/app/motrix')
    throw new Error('fnOS requires /app/motrix as its base path')
  const accountSocketPath = env.MOTRIX_NAS_ACCOUNT_SOCKET
  if (
    accountSocketPath !== undefined &&
    accountSocketPath !== '/run/motrix-account-authority/account.sock'
  )
    throw new Error('Invalid fnOS account authority socket')
  return { socketPath: path.join(target, 'app.sock'), accountSocketPath }
}
