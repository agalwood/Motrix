import { isIP } from 'node:net'
import type { NasAuthDiagnostic } from '@shared/schemas/operator-auth'
import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { NasGatewayOptions } from '../../http/nas-auth'
import { type SynologyAccounts, validDsmUsername } from './accounts'
import { type DsmCommand, DsmCommandError, dsmCommand } from './commands'

const header = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .regex(/^\P{Cc}*$/u)
const cgiHeadersSchema = z.object({
  cookie: header(8192).min(1),
  'x-motrix-dsm-remote-addr': z.string().refine((value) => isIP(value) !== 0),
  'x-motrix-dsm-server-addr': z.string().refine((value) => isIP(value) !== 0),
  'x-motrix-dsm-server-port': z
    .string()
    .regex(/^[1-9]\d{0,4}$/)
    .refine((value) => Number(value) <= 65535),
  'x-motrix-dsm-scheme': z.enum(['http', 'https']),
  host: header(512).optional().catch(undefined),
  'user-agent': header(2048).optional().catch(undefined),
  'x-syno-token': header(4096).optional().catch(undefined),
})

export function synologyGateway(
  socketPath: string,
  accounts: SynologyAccounts,
  command: DsmCommand = dsmCommand
): NasGatewayOptions {
  const isListener = (req: FastifyRequest) =>
    req.server.server.address() === socketPath &&
    req.raw.socket.remoteAddress === undefined
  const diagnostics = new WeakMap<FastifyRequest, NasAuthDiagnostic>()
  return {
    mode: 'synologyDsm',
    publicShell: true,
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
      const parsed = cgiHeadersSchema.safeParse(req.headers)
      if (!parsed.success)
        return deny({ stage: 'gateway', code: 'invalidContext' })
      const context = parsed.data
      const scheme = context['x-motrix-dsm-scheme']
      let stage: 'session' | 'account' = 'session'
      try {
        const username = (
          await command(
            '/usr/syno/synoman/webman/modules/authenticate.cgi',
            [],
            {
              HTTP_COOKIE: context.cookie,
              REMOTE_ADDR: context['x-motrix-dsm-remote-addr'],
              SERVER_ADDR: context['x-motrix-dsm-server-addr'],
              SERVER_PORT: context['x-motrix-dsm-server-port'],
              ...(scheme === 'https' ? { HTTPS: 'on' } : {}),
              REQUEST_SCHEME: scheme,
              REQUEST_METHOD: 'GET',
              SERVER_PROTOCOL: 'HTTP/1.1',
              GATEWAY_INTERFACE: 'CGI/1.1',
              SCRIPT_NAME: '/webman/modules/authenticate.cgi',
              REQUEST_URI: '/webman/modules/authenticate.cgi',
              ...(context.host ? { HTTP_HOST: context.host } : {}),
              ...(context['user-agent']
                ? { HTTP_USER_AGENT: context['user-agent'] }
                : {}),
              ...(context['x-syno-token']
                ? { HTTP_X_SYNO_TOKEN: context['x-syno-token'] }
                : {}),
            }
          )
        ).trim()
        if (!validDsmUsername(username))
          return deny({ stage, code: 'rejected' })
        stage = 'account'
        const account = await accounts.lookup(
          username,
          AbortSignal.timeout(4000)
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
