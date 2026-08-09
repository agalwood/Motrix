// Bootstrap wiring for the cross-plugin command system.
//
// Constructs the five safeguards (SchemaCache, RateLimiter, CallerThrottle,
// ChainDepth, CommandInvokeAudit), composes them into a FullCrossPluginInvoker,
// and binds the invoker to the CommandsCapabilityHost. Both the Electron main
// process (src/main/index.ts) and the Node server (src/server/index.ts) call
// this — keeping the wiring symmetric across the two runtimes.
//
// Plan D / spec §5 / invariants I9 + I23 + I24.

import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import type { CommandsCapabilityHost } from '../capabilities/commands'
import type { PluginHost } from '../host/plugin-host'
import type { PluginRegistry } from '../plugin-registry'
import { CallerThrottle } from './caller-throttle'
import { ChainDepth } from './chain-depth'
import { FullCrossPluginInvoker } from './cross-plugin-invoker'
import { CommandInvokeAudit } from './invoke-audit'
import { RateLimiter } from './rate-limiter'
import { SchemaCache } from './schema-cache'

const RATE_LIMIT_PER_PAIR = 10
const RATE_LIMIT_WINDOW_MS = 1_000

const THROTTLE_THRESHOLD = 10
const THROTTLE_WINDOW_MS = 60_000
const THROTTLE_BLOCK_MS = 5 * 60_000

const CHAIN_MAX_DEPTH = 8

export interface CommandSystemOptions {
  registry: PluginRegistry
  host: PluginHost
  capabilityHost: { commands: CommandsCapabilityHost }
  pluginsDir: string
  /**
   * Optional override that returns the current root task id (e.g. the
   * download task that triggered a hook chain). When undefined, the invoker
   * uses an internal AsyncLocalStorage so nested cross-plugin calls share
   * a synthetic task id and chain depth still accumulates correctly.
   */
  externalTaskIdProvider?: () => string | undefined
}

export interface CommandSystem {
  schemas: SchemaCache
  rateLimiter: RateLimiter
  throttle: CallerThrottle
  depth: ChainDepth
  audit: CommandInvokeAudit
  invoker: FullCrossPluginInvoker
  /** Internal store; exposed for tests + lifecycle hooks. */
  taskIdStore: AsyncLocalStorage<string>
  /** Re-install schemas for every plugin currently in the registry. */
  refreshSchemas(): void
  /** Clear throttle + schemas for a single plugin (uninstall / disable). */
  onPluginRemoved(pluginId: string): void
}

export function wireCommandSystem(opts: CommandSystemOptions): CommandSystem {
  const schemas = new SchemaCache()
  const rateLimiter = new RateLimiter({
    limit: RATE_LIMIT_PER_PAIR,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })
  const throttle = new CallerThrottle({
    threshold: THROTTLE_THRESHOLD,
    windowMs: THROTTLE_WINDOW_MS,
    blockMs: THROTTLE_BLOCK_MS,
  })
  const depth = new ChainDepth(CHAIN_MAX_DEPTH)
  const audit = new CommandInvokeAudit(
    path.join(opts.pluginsDir, '_audit', 'command-invokes.ndjson')
  )

  const taskIdStore = new AsyncLocalStorage<string>()

  // Chain-depth depends on a stable taskId across nested invocations. We
  // prefer the externally-supplied root task id (e.g. a download task driving
  // a hook chain) — when absent, we fall back to AsyncLocalStorage which
  // FullCrossPluginInvoker primes on its first execute(). This guarantees the
  // chain limit is enforced for cross-plugin RPC chains even outside a task.
  const taskIdProvider = (): string | undefined =>
    opts.externalTaskIdProvider?.() ?? taskIdStore.getStore()

  const invoker = new FullCrossPluginInvoker({
    registry: opts.registry,
    host: opts.host,
    schemas,
    rateLimiter,
    throttle,
    depth,
    audit,
    taskIdProvider,
  })

  // Wrap invoker.execute so the synthetic taskId, generated when no external
  // task is in flight, is propagated to nested executes via AsyncLocalStorage.
  // Without this, A→B→C cross-plugin chains would each start at depth 1.
  const originalExecute = invoker.execute.bind(invoker)
  invoker.execute = (
    callerId: string,
    commandId: string,
    args: unknown
  ): Promise<unknown> => {
    if (taskIdProvider() !== undefined) {
      return originalExecute(callerId, commandId, args)
    }
    const synthetic = `_chain_${callerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    return taskIdStore.run(synthetic, () =>
      originalExecute(callerId, commandId, args)
    )
  }

  opts.capabilityHost.commands.bindCrossPluginInvoker(invoker)

  const refreshSchemas = (): void => {
    for (const dto of opts.registry.list()) {
      const indexed = opts.registry.get(dto.id)
      if (!indexed) continue
      const cmds = indexed.manifest.contributes.commands ?? []
      schemas.installCommandSchemas(dto.id, cmds)
    }
  }

  refreshSchemas()

  const onPluginRemoved = (pluginId: string): void => {
    schemas.uninstall(pluginId)
    throttle.reset(pluginId)
  }

  return {
    schemas,
    rateLimiter,
    throttle,
    depth,
    audit,
    invoker,
    taskIdStore,
    refreshSchemas,
    onPluginRemoved,
  }
}
