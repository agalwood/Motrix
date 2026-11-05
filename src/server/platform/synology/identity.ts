import { isIP } from 'node:net'
import type { FastifyRequest } from 'fastify'
import type { NasGatewayOptions } from '../../http/nas-auth'
import type { SynologyAccounts } from './accounts'
import { type DsmCommand, dsmCommand } from './commands'

export function synologyGateway(
  socketPath: string,
  accounts: SynologyAccounts,
  command: DsmCommand = dsmCommand
): NasGatewayOptions {
  const isListener = (req: FastifyRequest) =>
    req.server.server.address() === socketPath &&
    req.raw.socket.remoteAddress === undefined
  return {
    mode: 'synologyDsm',
    publicShell: true,
    isListener,
    // Unlike fnOS, DSM must authenticate upgrades as well. A ticket alone
    // never extends a disabled account or a logged-out DSM session.
    hasIdentity: () => true,
    async authenticate(req) {
      if (!isListener(req)) return undefined
      const cookie = req.headers.cookie
      const remote = req.headers['x-motrix-dsm-remote-addr']
      const server = req.headers['x-motrix-dsm-server-addr']
      if (
        typeof cookie !== 'string' ||
        cookie.length > 8192 ||
        /[\r\n\0]/.test(cookie) ||
        typeof remote !== 'string' ||
        !isIP(remote) ||
        typeof server !== 'string' ||
        !isIP(server)
      )
        return undefined
      try {
        const username = (
          await command(
            '/usr/syno/synoman/webman/modules/authenticate.cgi',
            [],
            {
              HTTP_COOKIE: cookie,
              REMOTE_ADDR: remote,
              SERVER_ADDR: server,
              REQUEST_METHOD: 'GET',
              SERVER_PROTOCOL: 'HTTP/1.1',
              ...(typeof req.headers['x-syno-token'] === 'string'
                ? { HTTP_X_SYNO_TOKEN: req.headers['x-syno-token'] }
                : {}),
            }
          )
        ).trim()
        return (
          (await accounts.lookup(username, AbortSignal.timeout(4000))) ??
          undefined
        )
      } catch {
        return undefined
      }
    },
  }
}
