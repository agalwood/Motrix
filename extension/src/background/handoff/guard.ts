import type { BackendOperationCoordinator } from '@/background/BackendOperationCoordinator'
import type { EndpointConfigStore } from '@/background/EndpointConfigStore'
import type { TakeoverTarget } from '@/shared/takeover'
import { supportsAutomaticTakeover } from '@/shared/takeoverAvailability'

export class HandoffEndpointChangedError extends Error {
  constructor() {
    super('the selected backend changed during download handoff')
    this.name = 'HandoffEndpointChangedError'
  }
}

export interface HandoffGuard {
  readonly origin: TakeoverTarget['origin']
  readonly endpointId?: string
  readonly endpointRevision?: number
  /** Synchronous fence immediately before browser cancellation or sending. */
  assertCurrent(): void
}

/** Owns only the lifetime of a download's selected backend. Normal reconnects
 * retain the guard; catalog activation/edit invalidates it synchronously. */
export class HandoffEndpointTracker {
  private generation = 0

  constructor(
    private readonly store: Pick<
      EndpointConfigStore,
      'getForLifecycleMutation'
    >,
    private readonly coordinator: BackendOperationCoordinator
  ) {}

  invalidate(): void {
    this.generation += 1
  }

  capture(origin: HandoffGuard['origin']): Promise<HandoffGuard | null> {
    // Read selection under the same queue that invalidates guards and writes
    // the catalog, so capture cannot observe half of an endpoint switch.
    return this.coordinator.run(async () => {
      const config = await this.store.getForLifecycleMutation()
      if (origin === 'auto' && !supportsAutomaticTakeover(config)) return null
      const generation = this.generation
      return {
        origin,
        endpointId: config.activeEndpointId,
        endpointRevision:
          config.servers.find((server) => server.id === config.activeEndpointId)
            ?.revision ?? 0,
        assertCurrent: () => {
          if (generation !== this.generation) {
            throw new HandoffEndpointChangedError()
          }
        },
      }
    })
  }
}
