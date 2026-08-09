// src/core/plugin/commands/schema-cache.ts
//
// Host-side validator cache for cross-plugin commands.
//
// At plugin install time we compile each public command's argsSchema and
// resultSchema with Ajv. At invocation time we look up the compiled
// validators by (pluginId, commandId) and run them against args/results.
//
// Invariants:
// - Compilation only happens here in the host main thread (never inside a
//   plugin QuickJS VM).
// - useDefaults is OFF so validation cannot mutate the args object.
// - Only commands marked `public: true` AND carrying BOTH argsSchema AND
//   resultSchema are compiled. Everything else is treated as if the
//   command were not part of the public surface.

import { AppError, ErrorCode } from '@shared/errors'
import Ajv, { type AnySchema, type ValidateFunction } from 'ajv'

export interface CommandSchemaInput {
  id: string
  argsSchema?: unknown
  resultSchema?: unknown
  public?: boolean
}

interface CompiledPair {
  args: ValidateFunction
  result: ValidateFunction
}

export class SchemaCache {
  private readonly ajv = new Ajv({
    allErrors: false,
    strict: true,
    useDefaults: false,
  })
  private readonly byPlugin = new Map<string, Map<string, CompiledPair>>()

  installCommandSchemas(
    pluginId: string,
    cmds: ReadonlyArray<CommandSchemaInput>
  ): void {
    const compiled = new Map<string, CompiledPair>()
    for (const cmd of cmds) {
      if (
        cmd.public !== true ||
        cmd.argsSchema === undefined ||
        cmd.resultSchema === undefined
      ) {
        continue
      }
      let args: ValidateFunction
      let result: ValidateFunction
      try {
        // Ajv typings demand AnySchema; the manifest layer passes us raw
        // JSON which we have not yet validated, so we widen here and rely
        // on Ajv to throw on malformed input (caught below).
        args = this.ajv.compile(cmd.argsSchema as AnySchema)
        result = this.ajv.compile(cmd.resultSchema as AnySchema)
      } catch (cause) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          `plugin.command.schema_compile_failed: ${cmd.id}`,
          cause instanceof Error ? cause.message : String(cause)
        )
      }
      compiled.set(cmd.id, { args, result })
    }
    this.byPlugin.set(pluginId, compiled)
  }

  validateArgs(pluginId: string, commandId: string, args: unknown): void {
    const pair = this.byPlugin.get(pluginId)?.get(commandId)
    if (!pair) {
      throw new AppError(
        ErrorCode.PluginRuntimeFault,
        'plugin.command.not_public'
      )
    }
    if (!pair.args(args)) {
      throw new AppError(
        ErrorCode.PluginRuntimeFault,
        `plugin.command.args_invalid: ${this.ajv.errorsText(pair.args.errors)}`
      )
    }
  }

  validateResult(pluginId: string, commandId: string, result: unknown): void {
    const pair = this.byPlugin.get(pluginId)?.get(commandId)
    if (!pair) {
      // No validator installed — defensive no-op. CrossPluginInvoker only
      // reaches this branch after a successful validateArgs lookup, so
      // absence here means "no compiled validator for this command", not
      // "callee returned bad data".
      return
    }
    if (!pair.result(result)) {
      throw new AppError(
        ErrorCode.PluginRuntimeFault,
        `plugin.command.result_invalid: ${this.ajv.errorsText(pair.result.errors)}`
      )
    }
  }

  uninstall(pluginId: string): void {
    this.byPlugin.delete(pluginId)
  }
}
