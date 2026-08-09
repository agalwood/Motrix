// src/core/plugin/commands/cross-plugin-invoker.ts
//
// Concrete CrossPluginInvoker that the CommandsCapabilityHost binds in
// Plan D. Combines all 5 safeguards (schema validation, rate limit, caller
// throttle, chain depth, audit) plus PluginRegistry + PluginHost into a
// single `execute(callerId, commandId, args)` pipeline.
//
// Self-call note: when `callerId` equals the callee plugin id,
// CommandsCapabilityHost.execute dispatches directly to the local handler
// and never reaches this invoker. We do not re-check that invariant here.

import { AppError, ErrorCode } from '@shared/errors'
import type { CrossPluginInvoker } from '../capabilities/commands'
import type { PluginRegistry } from '../plugin-registry'
import type { CallerThrottle } from './caller-throttle'
import type { ChainDepth } from './chain-depth'
import type { CommandInvokeAudit, CommandInvokeEntry } from './invoke-audit'
import type { RateLimiter } from './rate-limiter'
import type { SchemaCache } from './schema-cache'

// Minimal subset of PluginHost we depend on — keeps testing easy.
export interface InvokerHost {
  isActive(pluginId: string): boolean
  activate(pluginId: string): Promise<void>
  invokeCommand(
    pluginId: string,
    commandId: string,
    args: unknown
  ): Promise<unknown>
}

export interface CrossPluginInvokerOptions {
  registry: PluginRegistry
  host: InvokerHost
  schemas: SchemaCache
  rateLimiter: RateLimiter
  throttle: CallerThrottle
  depth: ChainDepth
  audit: CommandInvokeAudit
  // current root task in flight if any
  taskIdProvider: () => string | undefined
  // default 256 KiB
  argsMaxBytes?: number
  // default 256 KiB
  resultMaxBytes?: number
  // default 5_000 ms
  activationTimeoutMs?: number
}

interface PublicCommand {
  id: string
  public?: boolean
}

const DEFAULT_ARGS_MAX_BYTES = 256 * 1024
const DEFAULT_RESULT_MAX_BYTES = 256 * 1024
const DEFAULT_ACTIVATION_TIMEOUT_MS = 5_000

function measureBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value ?? null)
    if (json === undefined) {
      return 0
    }
    return Buffer.byteLength(json, 'utf8')
  } catch {
    // JSON cycle / unrepresentable input — best-effort accounting only.
    return 0
  }
}

function parseCalleeId(commandId: string): { pluginId: string } | undefined {
  const parts = commandId.split('.')
  if (parts.length < 3) {
    return undefined
  }
  return { pluginId: `${parts[0]}.${parts[1]}` }
}

export class FullCrossPluginInvoker implements CrossPluginInvoker {
  private readonly registry: PluginRegistry
  private readonly host: InvokerHost
  private readonly schemas: SchemaCache
  private readonly rateLimiter: RateLimiter
  private readonly throttle: CallerThrottle
  private readonly depth: ChainDepth
  private readonly audit: CommandInvokeAudit
  private readonly taskIdProvider: () => string | undefined
  private readonly argsMaxBytes: number
  private readonly resultMaxBytes: number
  private readonly activationTimeoutMs: number

  constructor(opts: CrossPluginInvokerOptions) {
    this.registry = opts.registry
    this.host = opts.host
    this.schemas = opts.schemas
    this.rateLimiter = opts.rateLimiter
    this.throttle = opts.throttle
    this.depth = opts.depth
    this.audit = opts.audit
    this.taskIdProvider = opts.taskIdProvider
    this.argsMaxBytes = opts.argsMaxBytes ?? DEFAULT_ARGS_MAX_BYTES
    this.resultMaxBytes = opts.resultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES
    this.activationTimeoutMs =
      opts.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS
  }

  async execute(
    callerId: string,
    commandId: string,
    args: unknown
  ): Promise<unknown> {
    const startTs = Date.now()
    const taskId = this.taskIdProvider() ?? `_no_task_${callerId}_${startTs}`
    const argsSize = measureBytes(args)

    // Parse before entering the depth counter so a malformed commandId is
    // a quick reject without touching shared state.
    const parsed = parseCalleeId(commandId)
    if (!parsed) {
      const entry: CommandInvokeEntry = {
        caller: callerId,
        callee: '',
        commandId,
        argsSize,
        durMs: Date.now() - startTs,
        depth: this.depth.current(taskId),
        ok: false,
        errorCode: 'plugin.command.access_denied',
      }
      this.audit.log(entry)
      throw new AppError(
        ErrorCode.PluginRuntimeFault,
        'plugin.command.access_denied'
      )
    }
    const calleePluginId = parsed.pluginId

    const depthValue = this.depth.enter(taskId)
    const auditFail = (errorCode: string): never => {
      this.audit.log({
        caller: callerId,
        callee: calleePluginId,
        commandId,
        argsSize,
        durMs: Date.now() - startTs,
        depth: depthValue,
        ok: false,
        errorCode,
      })
      throw new AppError(ErrorCode.PluginRuntimeFault, errorCode)
    }

    try {
      // 5a. chain_too_deep
      if (depthValue > this.depth.max) {
        auditFail('plugin.command.chain_too_deep')
      }

      // 5b. access_denied — caller must declare invokesCommands
      const caller = this.registry.get(callerId)
      const declared = caller?.manifest.invokesCommands ?? []
      if (!caller || !declared.includes(commandId)) {
        auditFail('plugin.command.access_denied')
      }

      // 5c. callee enabled + public command exists
      const callee = this.registry.get(calleePluginId)
      if (!callee?.state.enabled) {
        auditFail('plugin.command.not_available')
      }
      const publicCmds = (callee?.manifest.contributes.commands ??
        []) as ReadonlyArray<PublicCommand>
      const cmd = publicCmds.find((c) => c.id === commandId)
      if (!cmd?.public) {
        auditFail('plugin.command.not_public')
      }

      // 5d. caller_throttled
      if (this.throttle.isBlocked(callerId)) {
        auditFail('plugin.command.caller_throttled')
      }

      // 5e. rate_limited — per (caller, callee) pair
      if (!this.rateLimiter.consume(callerId, calleePluginId)) {
        auditFail('plugin.command.rate_limited')
      }

      // 5f. args_too_large
      if (argsSize > this.argsMaxBytes) {
        auditFail('plugin.command.args_too_large')
      }

      // 5g. args_invalid (and throttle on real schema mismatch)
      try {
        this.schemas.validateArgs(calleePluginId, commandId, args)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Only count true schema mismatches against the caller — a missing
        // validator (`not_public`) is the host's bookkeeping problem, not
        // the caller's fault.
        if (msg.startsWith('plugin.command.args_invalid:')) {
          this.throttle.recordInvalid(callerId)
          auditFail('plugin.command.args_invalid')
        }
        if (msg === 'plugin.command.not_public') {
          auditFail('plugin.command.not_public')
        }
        // Unknown schema-cache failure — surface as args_invalid without
        // recording against the caller.
        auditFail('plugin.command.args_invalid')
      }

      // 6. Activate the callee with a hard timeout.
      if (!this.host.isActive(calleePluginId)) {
        try {
          await this.activateWithTimeout(calleePluginId)
        } catch (err) {
          const code =
            err instanceof AppError
              ? err.message
              : 'plugin.command.activation_timeout'
          auditFail(code)
        }
      }

      // 7. Invoke the handler. Never propagate the callee's message/stack.
      let result: unknown
      try {
        result = await this.host.invokeCommand(calleePluginId, commandId, args)
      } catch {
        this.audit.log({
          caller: callerId,
          callee: calleePluginId,
          commandId,
          argsSize,
          durMs: Date.now() - startTs,
          depth: depthValue,
          ok: false,
          errorCode: 'plugin.command.handler_threw',
        })
        throw new AppError(
          ErrorCode.PluginRuntimeFault,
          'plugin.command.handler_threw',
          { calleeMessage: 'redacted' }
        )
      }

      // 8. result_too_large
      const resultSize = measureBytes(result)
      if (resultSize > this.resultMaxBytes) {
        this.audit.log({
          caller: callerId,
          callee: calleePluginId,
          commandId,
          argsSize,
          resultSize,
          durMs: Date.now() - startTs,
          depth: depthValue,
          ok: false,
          errorCode: 'plugin.command.result_too_large',
        })
        throw new AppError(
          ErrorCode.PluginRuntimeFault,
          'plugin.command.result_too_large'
        )
      }

      // 9. result_invalid
      try {
        this.schemas.validateResult(calleePluginId, commandId, result)
      } catch {
        this.audit.log({
          caller: callerId,
          callee: calleePluginId,
          commandId,
          argsSize,
          resultSize,
          durMs: Date.now() - startTs,
          depth: depthValue,
          ok: false,
          errorCode: 'plugin.command.result_invalid',
        })
        throw new AppError(
          ErrorCode.PluginRuntimeFault,
          'plugin.command.result_invalid'
        )
      }

      // 10. Success
      this.audit.log({
        caller: callerId,
        callee: calleePluginId,
        commandId,
        argsSize,
        resultSize,
        durMs: Date.now() - startTs,
        depth: depthValue,
        ok: true,
      })
      return result
    } finally {
      this.depth.exit(taskId)
    }
  }

  private activateWithTimeout(pluginId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(
          new AppError(
            ErrorCode.PluginRuntimeFault,
            'plugin.command.activation_timeout'
          )
        )
      }, this.activationTimeoutMs)

      this.host.activate(pluginId).then(
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        },
        (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(
            err instanceof AppError
              ? err
              : new AppError(
                  ErrorCode.PluginRuntimeFault,
                  'plugin.command.activation_timeout'
                )
          )
        }
      )
    })
  }
}
