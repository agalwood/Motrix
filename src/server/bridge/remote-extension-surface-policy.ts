import type {
  ExtensionMbp1RouteDecision,
  ExtensionMbp1RouteRequest,
} from '@core/bridge/web-socket-bridge-server'
import {
  RemoteExtensionAdmissionPolicy,
  type RemoteExtensionAdmissionRejection,
} from './remote-extension-admission-policy'
import {
  isIssuedRemoteExtensionConfig,
  type RemoteExtensionConfig,
} from './remote-extension-config'
import { evaluateRemoteExtensionHost } from './remote-extension-host-policy'
import { evaluateRemoteExtensionRoute } from './remote-extension-route-policy'

function rejectedAdmission(
  reason: RemoteExtensionAdmissionRejection
): ExtensionMbp1RouteDecision {
  return {
    kind: 'reject',
    status: reason === 'capacity' || reason === 'rate-limited' ? 429 : 403,
  }
}

/**
 * Atomic adapter from the Server's strict public policy modules into core's
 * raw MBP1 route boundary. No normalized framework URL, forwarded Host, query
 * token, or request body participates in routing or authentication.
 */
export class RemoteExtensionSurfacePolicy {
  private readonly admission: RemoteExtensionAdmissionPolicy

  constructor(private readonly config: RemoteExtensionConfig) {
    if (!isIssuedRemoteExtensionConfig(config) || config.status !== 'enabled') {
      throw new Error('remote Extension surface configuration rejected')
    }
    this.admission = new RemoteExtensionAdmissionPolicy({ config })
  }

  evaluate(request: ExtensionMbp1RouteRequest): ExtensionMbp1RouteDecision {
    const route = evaluateRemoteExtensionRoute(this.config, request)
    if (!route.ok) {
      return route.reason === 'unknown-route'
        ? { kind: 'not-extension' }
        : {
            kind: 'reject',
            status: route.reason === 'method-not-allowed' ? 405 : 404,
          }
    }
    const host = evaluateRemoteExtensionHost(this.config, request.rawHeaders)
    if (!host.ok) return { kind: 'reject', status: 403 }

    const source = {
      directPeerAddress: request.directPeerAddress,
      rawHeaders: request.rawHeaders,
    }
    if (route.route === 'discovery') {
      const decision = this.admission.admitDiscoveryRequest(source)
      return decision.ok
        ? { kind: 'route', route: 'discovery' }
        : rejectedAdmission(decision.reason)
    }
    if (route.route === 'nonce') {
      const decision = this.admission.admitNonceRequest(source)
      return decision.ok
        ? {
            kind: 'route',
            route: 'nonce',
            releaseAdmission: () => decision.lease.release(),
          }
        : rejectedAdmission(decision.reason)
    }
    if (route.route === 'pair') {
      const decision = this.admission.acquirePairPreAuthSocket()
      return decision.ok
        ? {
            kind: 'route',
            route: 'pair',
            pairNonce: route.pairNonce,
            releaseAdmission: () => decision.lease.release(),
          }
        : rejectedAdmission(decision.reason)
    }

    const decision = this.admission.acquireV1PreAuthSocket()
    return decision.ok
      ? {
          kind: 'route',
          route: 'v1',
          releaseAdmission: () => decision.lease.release(),
        }
      : rejectedAdmission(decision.reason)
  }

  dispose(): void {
    this.admission.dispose()
  }
}
