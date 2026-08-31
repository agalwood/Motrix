import type { Logger } from '@core/logger'
import {
  isIssuedRemoteExtensionConfig,
  type RemoteExtensionConfig,
} from './remote-extension-config'

type StartupLogger = Pick<Logger, 'info' | 'warn'>

const INSECURE_OPERATOR_WARNING =
  'Motrix operator UI uses HTTP. The operator token, pairing codes, session cookies, and administrator traffic are not protected by TLS. Use only on a trusted network; HTTPS is recommended.'

/**
 * Print the exact address a user should copy into Motrix Extension.
 *
 * This runs only after the MBP1 listener and remote Extension routes are ready.
 * Parser issuance is checked again at the log boundary so an untrusted string
 * cannot manufacture a startup message or inject terminal control characters.
 */
export function logRemoteExtensionPairingReady(
  log: StartupLogger,
  config: RemoteExtensionConfig
): void {
  if (!isIssuedRemoteExtensionConfig(config) || config.status !== 'enabled') {
    return
  }

  const extensionServerAddress = config.publicWebSocketBaseUrl
  if (config.publicOperatorBaseUrl.startsWith('http://')) {
    log.warn({ operatorTransport: 'http' }, INSECURE_OPERATOR_WARNING)
  }
  log.info(
    { extensionServerAddress },
    `Motrix Extension pairing ready. Enter this Server address in the Extension: ${extensionServerAddress}`
  )
}
