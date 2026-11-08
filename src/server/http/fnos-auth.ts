import type { ClientPairingCapabilities } from '@shared/schemas/operator-auth'
import type { FastifyInstance } from 'fastify'
import {
  type FnosGatewayOptions,
  fnosIdentityDiagnostic,
  fnosPrincipal,
  isFnosListener,
} from '../platform/fnos/identity'
import { registerNasAuth } from './nas-auth'

export function registerFnosAuth(
  app: FastifyInstance,
  opts: FnosGatewayOptions,
  clientPairing?: ClientPairingCapabilities
) {
  return registerNasAuth(
    app,
    {
      mode: 'fnosGateway',
      now: opts.now,
      isListener: (req) => isFnosListener(req, opts),
      authenticate(req) {
        const user = fnosPrincipal(req, opts)
        return user
          ? {
              platform: 'fnos',
              userId: String(user.uid),
              username: user.username,
              administrator: true,
            }
          : undefined
      },
      hasIdentity: (req) =>
        ['x-trim-userid', 'x-trim-isadmin', 'x-trim-username'].some(
          (key) => req.headers[key] !== undefined
        ),
      diagnostic: (req) => fnosIdentityDiagnostic(req, opts),
    },
    clientPairing
  )
}
