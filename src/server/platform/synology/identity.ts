import type { NasAuthDiagnostic } from '@shared/schemas/operator-auth'
import type { FastifyRequest } from 'fastify'
import type { NasGatewayOptions } from '../../http/nas-auth'
import type { SynologyAccounts } from './accounts'
import { DsmCommandError } from './commands'
import { dsmContextSchema } from './validation'

export function synologyGateway(
  socketPath: string,
  accounts: SynologyAccounts
): NasGatewayOptions {
  const isListener = (req: FastifyRequest) =>
    req.server.server.address() === socketPath &&
    req.raw.socket.remoteAddress === undefined
  const diagnostics = new WeakMap<FastifyRequest, NasAuthDiagnostic>()
  return {
    mode: 'synologyDsm',
    publicShell: true,
    capabilities: {
      settings: true,
      fileActions: true,
      torrentPicker: true,
      clientGateway: true,
    },
    isListener,
    // DSM authenticates upgrades as well; tickets cannot extend a disabled account.
    hasIdentity: () => true,
    diagnostic: (req) => diagnostics.get(req),
    async authenticate(req) {
      const deny = (value: NasAuthDiagnostic) => {
        diagnostics.set(req, value)
        return undefined
      }
      if (!isListener(req))
        return deny({ stage: 'gateway', code: 'untrustedListener' })
      if (!req.headers.cookie)
        return deny({ stage: 'session', code: 'missingCookie' })
      const parsed = dsmContextSchema.safeParse({
        cookie: req.headers.cookie,
        remoteAddress: req.headers['x-motrix-dsm-remote-addr'],
        serverAddress: req.headers['x-motrix-dsm-server-addr'],
        serverPort: req.headers['x-motrix-dsm-server-port'],
        scheme: req.headers['x-motrix-dsm-scheme'],
        host: req.headers.host,
        userAgent: req.headers['user-agent'],
      })
      if (!parsed.success)
        return deny({ stage: 'gateway', code: 'invalidContext' })
      const stage = 'account'
      try {
        const account = await accounts.authenticate(
          parsed.data,
          AbortSignal.timeout(5000)
        )
        if (!account) return deny({ stage, code: 'rejected' })
        diagnostics.delete(req)
        return account
      } catch (error) {
        return deny(
          error instanceof DsmCommandError
            ? {
                stage,
                code: 'commandFailed',
                failure: error.failure,
                ...(error.exitCode !== undefined
                  ? { exitCode: error.exitCode }
                  : {}),
              }
            : { stage, code: 'unavailable' }
        )
      }
    },
  }
}
