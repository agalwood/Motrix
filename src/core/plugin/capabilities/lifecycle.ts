// lifecycle capability — per-plugin deactivate handler registry with 2s budget.
//
// Plugins register callbacks via `registerOnDeactivate`. When a plugin is
// being shut down, the host calls `runDeactivate(pluginId)` which runs all
// registered handlers sequentially, sharing a total time budget (default
// 2000ms). If the budget is exceeded by any single handler (or there is no
// time left before a handler starts) a LifecycleError with code
// `plugin.lifecycle.deactivate_timeout` is thrown.
//
// Plan B Task 23 wires `runDeactivate` into `PluginHost.dispose`. This module
// only ships the registry + budget enforcement.

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class LifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'LifecycleError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeactivateHandler = () => void | Promise<void>

export interface LifecycleRegistration {
  /** Removes this handler from the registry. */
  dispose(): void
}

export interface LifecycleCapabilityHostOptions {
  /** Total ms budget shared across all handlers per plugin. Default 2000. */
  totalBudgetMs?: number
}

// ---------------------------------------------------------------------------
// LifecycleCapabilityHost
// ---------------------------------------------------------------------------

export class LifecycleCapabilityHost {
  private readonly handlers = new Map<string, DeactivateHandler[]>()
  private readonly totalBudgetMs: number

  constructor(opts?: LifecycleCapabilityHostOptions) {
    this.totalBudgetMs = opts?.totalBudgetMs ?? 2000
  }

  /**
   * Register a deactivate handler for `pluginId`. Returns a registration
   * handle whose `dispose()` removes only this handler.
   */
  registerOnDeactivate(
    pluginId: string,
    fn: DeactivateHandler
  ): LifecycleRegistration {
    if (!this.handlers.has(pluginId)) {
      this.handlers.set(pluginId, [])
    }
    // biome-ignore lint/style/noNonNullAssertion: we just ensured the key exists
    const list = this.handlers.get(pluginId)!
    list.push(fn)

    return {
      dispose: () => {
        const current = this.handlers.get(pluginId)
        if (!current) return
        const idx = current.indexOf(fn)
        if (idx !== -1) current.splice(idx, 1)
      },
    }
  }

  /**
   * Run all registered deactivate handlers for `pluginId` sequentially,
   * sharing `totalBudgetMs`. Clears the handler list after the run (whether
   * it succeeded or failed). Throws `LifecycleError` on timeout or handler
   * throw.
   */
  async runDeactivate(pluginId: string): Promise<void> {
    const list = this.handlers.get(pluginId) ?? []
    // Snapshot so dispose() calls during run don't mutate the in-flight list.
    const snapshot = list.slice()
    // Clear immediately so subsequent calls start fresh.
    this.handlers.delete(pluginId)

    const startMs = Date.now()

    for (const handler of snapshot) {
      const elapsed = Date.now() - startMs
      const remaining = this.totalBudgetMs - elapsed

      if (remaining <= 0) {
        throw new LifecycleError(
          'plugin.lifecycle.deactivate_timeout',
          `plugin "${pluginId}" deactivate budget exhausted before all handlers ran`
        )
      }

      await this._raceWithTimeout(pluginId, handler, remaining)
    }
  }

  /**
   * Clear all registered handlers for `pluginId` without running them.
   * Called on full plugin removal / uninstall.
   */
  reset(pluginId: string): void {
    this.handlers.delete(pluginId)
  }

  /**
   * Number of registered handlers for `pluginId`. Useful in tests.
   */
  count(pluginId: string): number {
    return this.handlers.get(pluginId)?.length ?? 0
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _raceWithTimeout(
    pluginId: string,
    handler: DeactivateHandler,
    remainingMs: number
  ): Promise<void> {
    let timerId: ReturnType<typeof setTimeout> | undefined

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(
          new LifecycleError(
            'plugin.lifecycle.deactivate_timeout',
            `plugin "${pluginId}" deactivate handler timed out (budget ${this.totalBudgetMs}ms)`
          )
        )
      }, remainingMs)
    })

    const handlerPromise = Promise.resolve().then(
      () => handler() as void | Promise<void>
    )

    return Promise.race([handlerPromise, timeoutPromise]).then(
      () => {
        clearTimeout(timerId)
      },
      (err: unknown) => {
        clearTimeout(timerId)
        throw err
      }
    )
  }
}
