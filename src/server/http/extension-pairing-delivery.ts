import { BridgeEvents } from '@shared/protocol/bridge'
import type { FastifyRequest } from 'fastify'
import {
  isIssuedRemoteExtensionConfig,
  type RemoteExtensionConfig,
} from '../bridge/remote-extension-config'

/**
 * Operator authentication is required separately. The local exception describes
 * the observed HTTP connection, not proof that no privileged local proxy exists.
 * The operator bearer already grants machine-owner authority.
 */
export function canDeliverExtensionPairingCode(
  config: RemoteExtensionConfig | undefined,
  request: FastifyRequest,
  bearerAuthenticated: boolean
): boolean {
  if (!isIssuedRemoteExtensionConfig(config) || config.status !== 'enabled') {
    return false
  }
  if (config.operatorDelivery === 'web') return true
  if (!bearerAuthenticated) return false

  const { remoteAddress, localPort } = request.raw.socket
  if (
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress ?? '') ||
    localPort === undefined
  ) {
    return false
  }

  const hosts: string[] = []
  const headers = request.raw.rawHeaders
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index]?.toLowerCase()
    const value = headers[index + 1]
    if (
      name === 'origin' ||
      name === 'forwarded' ||
      name?.startsWith('x-forwarded-')
    ) {
      return false
    }
    if (name === 'host' && value !== undefined) hosts.push(value.toLowerCase())
  }
  return (
    hosts.length === 1 &&
    [
      `127.0.0.1:${localPort}`,
      `localhost:${localPort}`,
      `[::1]:${localPort}`,
    ].includes(hosts[0])
  )
}

function isExtensionRequest(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'extension'
  )
}

export function filterExtensionPairingSnapshot(value: unknown): unknown {
  return Array.isArray(value)
    ? value.filter((request) => !isExtensionRequest(request))
    : value
}

export function isExtensionPairingCodeEvent(
  channel: string,
  args: unknown[]
): boolean {
  return channel === BridgeEvents.PairRequested && isExtensionRequest(args[0])
}
