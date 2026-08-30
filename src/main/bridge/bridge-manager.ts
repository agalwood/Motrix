import type { BridgeRuntime } from './index'

export type BridgeRuntimeFactory = () => Promise<BridgeRuntime | null>
export type NativeMessagingUnregister = () => Promise<void>

export interface BridgeStopOptions {
  unregisterNativeMessaging?: boolean
}

/**
 * Holds the optional WebSocket bridge runtime and lets callers start/stop it
 * in response to settings changes. The factory is invoked anew each start —
 * a fresh port, registry, native messaging manifest sync happens on every
 * enable transition.
 */
export class BridgeManager {
  private runtime: BridgeRuntime | null = null
  private pendingUnregister: BridgeRuntime['installer'] | null = null
  private cleanupPending = false
  private transition: Promise<void> = Promise.resolve()

  constructor(
    private factory: BridgeRuntimeFactory,
    private unregisterNativeMessaging?: NativeMessagingUnregister
  ) {}

  get current(): BridgeRuntime | null {
    return this.runtime
  }

  async start(): Promise<void> {
    return this.enqueue(() => this.startCurrent())
  }

  async stop(options: BridgeStopOptions = {}): Promise<void> {
    return this.enqueue(() => this.stopCurrent(options))
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) await this.start()
    else await this.stop({ unregisterNativeMessaging: true })
  }

  /**
   * Stop then start as ONE serialized transition, for a settings change
   * (e.g. `bridge.fixedPort`) that must take effect without a full
   * disable/enable round trip. `await this.stop(); await this.start()`
   * would enqueue two independent transitions, so a concurrent
   * `setEnabled(false)` or a second `restart()` could interleave between
   * them — leaving the bridge running after the user disabled it, or a
   * duplicate-handler throw from a start racing a stop's handler removal.
   *
   * No-op when the bridge is not currently running: the master switch is
   * off by design there, and starting it would defeat that. Native
   * Messaging registration is kept (plain `stopCurrent({})`, never
   * `unregisterNativeMessaging: true`) — a restart must not silently
   * unregister it the way disabling the bridge does.
   */
  async restart(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.runtime) return
      await this.stopCurrent({})
      await this.startCurrent()
    })
  }

  private async startCurrent(): Promise<void> {
    if (this.runtime) return
    let runtime: BridgeRuntime | null
    try {
      runtime = await this.factory()
    } catch (startError) {
      if (!this.unregisterNativeMessaging) throw startError
      this.cleanupPending = true
      try {
        await this.unregisterNativeMessaging()
        this.cleanupPending = false
      } catch (unregisterError) {
        throw new AggregateError(
          [startError, unregisterError],
          'Bridge startup and Native Messaging cleanup both failed'
        )
      }
      throw startError
    }
    this.runtime = runtime
    if (runtime) {
      // A successful registration supersedes any cleanup retry retained from
      // a previous disabled transition.
      this.pendingUnregister = null
      this.cleanupPending = false
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transition.then(operation, operation)
    this.transition = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async stopCurrent(options: BridgeStopOptions): Promise<void> {
    const r = this.runtime
    const shouldUnregister =
      options.unregisterNativeMessaging === true || this.cleanupPending
    if (!r && !shouldUnregister) return

    if (r) {
      this.runtime = null
      if (shouldUnregister) {
        this.pendingUnregister = r.installer
      }
    }
    if (shouldUnregister) {
      this.cleanupPending = true
    }

    let shutdownError: unknown
    if (r) {
      try {
        await r.shutdown()
      } catch (error) {
        shutdownError = error
      }
    }

    let unregisterError: unknown
    if (shouldUnregister) {
      const pendingUnregister = this.pendingUnregister
      const unregister =
        this.unregisterNativeMessaging ??
        (pendingUnregister ? () => pendingUnregister.unregister() : null)
      if (unregister) {
        try {
          await unregister()
          this.pendingUnregister = null
          this.cleanupPending = false
        } catch (error) {
          unregisterError = error
        }
      }
    }

    if (shutdownError && unregisterError) {
      throw new AggregateError(
        [shutdownError, unregisterError],
        'Bridge shutdown and Native Messaging cleanup both failed'
      )
    }
    if (shutdownError) throw shutdownError
    if (unregisterError) throw unregisterError
  }
}
