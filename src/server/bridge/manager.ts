import type { TrustedExtensionRegistry } from '@core/bridge/trusted-extension-registry'
import {
  BridgeCommands,
  BridgeQueries,
  type Browser,
} from '@shared/protocol/bridge'
import type { Handler } from '@shared/protocol/handler-types'
import { ServiceUnavailableError } from '../http/service-unavailable-error'
import type { ServerBridgeRuntime } from './bootstrap'

export type ServerBridgeRuntimeFactory = () => Promise<ServerBridgeRuntime>

/**
 * Owns the optional Server bridge runtime while keeping the renderer-facing
 * bridge RPC surface stable for the lifetime of the HTTP control plane.
 * Trusted-extension management is deliberately independent of the MDXP
 * listener: an occupied port must not make the durable registry disappear.
 */
export class ServerBridgeManager {
  private runtime: ServerBridgeRuntime | null = null
  private transition: Promise<void> = Promise.resolve()
  private registryTransition: Promise<void> = Promise.resolve()
  private desiredEnabled = false
  private registryAccepting = true

  readonly bridgeCommandHandlers: Record<string, Handler>
  readonly bridgeQueryHandlers: Record<string, Handler>

  constructor(
    private readonly registry: TrustedExtensionRegistry,
    private readonly factory: ServerBridgeRuntimeFactory,
    private readonly isRegistryReady: () => boolean = () => true
  ) {
    this.bridgeCommandHandlers = {
      [BridgeCommands.AddTrusted]: async (params: {
        id: string
        browser: Browser
        label?: string
      }) => {
        await this.enqueueRegistry(() =>
          this.registry.add(
            params.id,
            params.browser,
            'user-added',
            params.label
          )
        )
      },
      [BridgeCommands.RemoveTrusted]: async (params: {
        id: string
        browser: Browser
      }) => {
        await this.enqueueRegistry(() =>
          this.registry.remove(params.id, params.browser)
        )
      },
      [BridgeCommands.ResolvePair]: (...args: unknown[]) =>
        this.invokeCommand(BridgeCommands.ResolvePair, args),
      [BridgeCommands.RevokePair]: (...args: unknown[]) =>
        this.invokeCommand(BridgeCommands.RevokePair, args),
    }
    this.bridgeQueryHandlers = {
      [BridgeQueries.ListTrusted]: async () =>
        this.enqueueRegistry(async () => this.registry.list()),
      [BridgeQueries.ListPaired]: (...args: unknown[]) =>
        this.invokeQuery(BridgeQueries.ListPaired, args),
      [BridgeQueries.ProbeUrl]: (...args: unknown[]) =>
        this.invokeQuery(BridgeQueries.ProbeUrl, args),
      [BridgeQueries.ResolveUrl]: (...args: unknown[]) =>
        this.invokeQuery(BridgeQueries.ResolveUrl, args),
      [BridgeQueries.CancelResolveUrl]: (...args: unknown[]) =>
        this.invokeQuery(BridgeQueries.CancelResolveUrl, args),
      [BridgeQueries.ListPendingPairRequests]: (...args: unknown[]) =>
        this.invokeQuery(BridgeQueries.ListPendingPairRequests, args),
      [BridgeQueries.GetStatus]: (...args: unknown[]) =>
        this.invokeQuery(BridgeQueries.GetStatus, args),
    }
  }

  get current(): ServerBridgeRuntime | null {
    return this.runtime
  }

  start(): Promise<void> {
    this.desiredEnabled = true
    return this.enqueue(() => this.startCurrent())
  }

  stop(): Promise<void> {
    this.desiredEnabled = false
    return this.enqueue(() => this.stopCurrent())
  }

  setEnabled(enabled: boolean): Promise<void> {
    return enabled ? this.start() : this.stop()
  }

  restart(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.desiredEnabled) return
      await this.stopCurrent()
      await this.startCurrent()
    })
  }

  async shutdown(): Promise<void> {
    this.desiredEnabled = false
    this.registryAccepting = false
    await Promise.all([
      this.enqueue(() => this.stopCurrent()),
      this.registryTransition,
    ])
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transition.then(operation, operation)
    this.transition = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private enqueueRegistry<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.registryAccepting || !this.isRegistryReady()) {
      throw new ServiceUnavailableError(
        'Trusted extension registry unavailable'
      )
    }
    const result = this.registryTransition.then(operation, operation)
    this.registryTransition = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async startCurrent(): Promise<void> {
    if (this.runtime) return
    const runtime = await this.factory()
    if (!this.desiredEnabled) {
      await runtime.shutdown()
      return
    }
    this.runtime = runtime
  }

  private async stopCurrent(): Promise<void> {
    const runtime = this.runtime
    this.runtime = null
    await runtime?.shutdown()
  }

  private async availableRuntime(): Promise<ServerBridgeRuntime> {
    if (this.runtime) return this.runtime
    if (this.desiredEnabled) await this.transition
    if (this.runtime) return this.runtime
    throw new ServiceUnavailableError('Bridge is unavailable')
  }

  private async invokeCommand(
    channel: string,
    args: unknown[]
  ): Promise<unknown> {
    const runtime = await this.availableRuntime()
    const handler = runtime.bridgeCommandHandlers[channel]
    if (!handler) throw new ServiceUnavailableError('Bridge is unavailable')
    return handler(...args)
  }

  private async invokeQuery(
    channel: string,
    args: unknown[]
  ): Promise<unknown> {
    const runtime = await this.availableRuntime()
    const handler = runtime.bridgeQueryHandlers[channel]
    if (!handler) throw new ServiceUnavailableError('Bridge is unavailable')
    return handler(...args)
  }
}
