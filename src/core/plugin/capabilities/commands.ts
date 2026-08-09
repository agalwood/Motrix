// commands capability — own-namespace register + execute.
//
// Plugins may register command IDs only within their own namespace
// (`<callerId>.*`) AND only command IDs declared in their manifest's
// `contributes.commands[]` (spec §5 L1741-1746). Executing an own-namespace
// command dispatches directly to the stored handler. Executing a
// foreign-namespace command is delegated to a bound CrossPluginInvoker
// (Plan D). Without a bound invoker, cross-plugin calls are rejected with
// `access_denied`.
//
// Error codes:
//   plugin.commands.id_out_of_namespace        — register callerId doesn't own commandId
//   plugin.command.not_declared_in_manifest    — id missing from manifest.contributes.commands[]
//   plugin.commands.not_found                  — no handler registered for commandId
//   plugin.commands.access_denied              — cross-plugin call with no invoker bound

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class CommandsError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CommandsError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandHandler = (args: unknown) => unknown | Promise<unknown>

export interface CrossPluginInvoker {
  execute(callerId: string, commandId: string, args: unknown): Promise<unknown>
}

export interface CommandsRegistration {
  dispose(): void
}

export interface SelfInvokeEvent {
  callerId: string
  commandId: string
  durMs: number
  ok: boolean
  errorCode?: string
}

export interface CommandsCapabilityHostOptions {
  /**
   * Resolver returning the set of command IDs declared in
   * `manifest.contributes.commands[]` for a given caller. Wired by
   * `capability-host.ts` against `PluginRegistry`. When omitted (e.g. in unit
   * tests or environments without a registry), declaration is NOT enforced
   * and any `<self>.*` id may be registered — back-compat.
   */
  manifestCommandIds?: (callerId: string) => ReadonlySet<string> | undefined
  /**
   * Sink for self-invoke (own-namespace) execute events. Spec §5 L1800 — these
   * are intentionally NOT routed through the cross-plugin audit NDJSON (too
   * high volume) but ARE recorded in the plugin's own pino destination for
   * debugging visibility. Capability-host wires this to LogCapabilityHost.
   */
  onSelfInvoke?: (event: SelfInvokeEvent) => void
}

// ---------------------------------------------------------------------------
// CommandsCapabilityHost
// ---------------------------------------------------------------------------

export class CommandsCapabilityHost {
  private readonly handlers = new Map<string, CommandHandler>()
  private invoker?: CrossPluginInvoker
  private readonly resolveDeclared?: (
    callerId: string
  ) => ReadonlySet<string> | undefined
  private readonly onSelfInvoke?: (event: SelfInvokeEvent) => void

  constructor(opts: CommandsCapabilityHostOptions = {}) {
    this.resolveDeclared = opts.manifestCommandIds
    this.onSelfInvoke = opts.onSelfInvoke
  }

  /**
   * Bind (or replace) a cross-plugin invoker. Called by Plan D when the full
   * plugin host wires up inter-plugin command dispatch.
   */
  bindCrossPluginInvoker(invoker: CrossPluginInvoker): void {
    this.invoker = invoker
  }

  /**
   * Register `handler` for `commandId`. The `commandId` MUST start with
   * `${callerId}.` — i.e. belong to the caller's own namespace. When a
   * manifest resolver is configured, `commandId` must also be declared in
   * the caller's `contributes.commands[]`. Returns a registration whose
   * `dispose()` removes only this command. Repeated registration of the
   * same id replaces the previous handler and emits `console.warn` (spec
   * §5 L1742, consistent with the hooks contract).
   *
   * @throws {CommandsError} plugin.commands.id_out_of_namespace — wrong owner
   * @throws {CommandsError} plugin.command.not_declared_in_manifest — missing from manifest
   */
  register(
    callerId: string,
    commandId: string,
    handler: CommandHandler
  ): CommandsRegistration {
    if (!commandId.startsWith(`${callerId}.`)) {
      throw new CommandsError(
        'plugin.commands.id_out_of_namespace',
        `command "${commandId}" is outside namespace "${callerId}." — commands must start with "${callerId}."`
      )
    }

    if (this.resolveDeclared) {
      const declared = this.resolveDeclared(callerId)
      if (!declared?.has(commandId)) {
        throw new CommandsError(
          'plugin.command.not_declared_in_manifest',
          `command "${commandId}" is not declared in plugin "${callerId}" manifest.contributes.commands[]`
        )
      }
    }

    if (this.handlers.has(commandId)) {
      console.warn(
        `[plugin:commands] handler for "${commandId}" registered more than once; previous handler replaced`
      )
    }

    this.handlers.set(commandId, handler)

    return {
      dispose: () => {
        this.handlers.delete(commandId)
      },
    }
  }

  /**
   * Execute a command.
   *
   * - Own-namespace (`commandId` starts with `${callerId}.`): dispatches to
   *   the registered handler. Rejects with `not_found` if absent. Any error
   *   thrown by the handler surfaces as-is.
   * - Foreign-namespace: forwarded to the bound CrossPluginInvoker. Rejects
   *   with `access_denied` if no invoker is bound.
   */
  async execute(
    callerId: string,
    commandId: string,
    args: unknown
  ): Promise<unknown> {
    if (commandId.startsWith(`${callerId}.`)) {
      const handler = this.handlers.get(commandId)
      if (!handler) {
        throw new CommandsError(
          'plugin.commands.not_found',
          `command "${commandId}" is not registered`
        )
      }
      const startTs = Date.now()
      try {
        const result = await handler(args)
        this.onSelfInvoke?.({
          callerId,
          commandId,
          durMs: Date.now() - startTs,
          ok: true,
        })
        return result
      } catch (err) {
        this.onSelfInvoke?.({
          callerId,
          commandId,
          durMs: Date.now() - startTs,
          ok: false,
          errorCode: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }

    // Cross-plugin path
    if (!this.invoker) {
      throw new CommandsError(
        'plugin.commands.access_denied',
        `cross-plugin command "${commandId}" requires a bound invoker (Plan D)`
      )
    }
    return this.invoker.execute(callerId, commandId, args)
  }

  /**
   * Remove all handlers whose command ID starts with `${callerId}.`.
   * Used during plugin teardown.
   */
  unregisterAll(callerId: string): void {
    const prefix = `${callerId}.`
    for (const key of this.handlers.keys()) {
      if (key.startsWith(prefix)) {
        this.handlers.delete(key)
      }
    }
  }

  /**
   * Returns true if `commandId` has a registered handler. Useful in tests.
   */
  has(commandId: string): boolean {
    return this.handlers.has(commandId)
  }
}
