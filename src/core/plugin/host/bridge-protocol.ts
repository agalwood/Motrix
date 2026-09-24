// src/core/plugin/host/bridge-protocol.ts
// Bidirectional message protocol between QuickJSWorker (worker thread)
// and CapabilityBridge (main thread). Calls and responses carry a numeric
// correlation id. Hook-scoped traffic also carries the immutable invocation,
// call-chain, and permission-generation tuple.

/* Keep command provenance on the same strict schema as call/response DTOs. */
import {
  type CapabilityCallMessageV1,
  type CapabilityResponseMessageV1,
  CommandInvocationScopeV1Schema,
  type HookAbortMessageV1,
  type HookEnterMessageV1,
  type HookExitMessageV1,
  type HookInvocationScopeV1,
  type HookNameV1,
} from '@shared/schemas/plugin-hooks'
import type { PluginManifest } from '@shared/types/plugin'
import { z } from 'zod'
import type { ManifestLocaleDict } from '../manifest/i18n-resolve'

export type BridgeMessageId = number

// The four task-lifecycle hook names plugins can tap. Defined once here so the
// host, worker, and bridge share a single source of truth instead of
// re-spelling the union at each annotation site.
export type HookName = HookNameV1

// Runtime ordering of HookName — used by the worker to register hook handlers.
export const HOOK_NAMES: readonly HookName[] = [
  'beforeCreate',
  'beforeFinalize',
  'afterComplete',
  'onError',
]

// Sent host → worker once at worker bootstrap.
export interface BridgeInitMessage {
  type: 'init'
  pluginId: string
  manifest: PluginManifest
  bundleSource: string // raw text of dist/plugin.js
  app: {
    version: string
    platform: 'darwin' | 'win32' | 'linux'
    runtime: 'electron' | 'server'
    locale: string
    arch: 'x64' | 'arm64'
  }
  i18n: {
    language: string
    dir: 'ltr' | 'rtl'
    currentDict: ManifestLocaleDict
    fallbackDict: ManifestLocaleDict
  }
  limits: {
    heapMB: number // 32..64
    stackKB: number // 256
  }
}

// Worker → host.
export type BridgeCallMessage = CapabilityCallMessageV1

// Host → worker.
export type BridgeResponseMessage = CapabilityResponseMessageV1

// Host → worker (one-way events).
// BridgeHookEnter: sent by host to worker when entering a hook invocation.
// ctxPayload carries the input fields the plugin reads from `ctx` —
// shaped after BeforeCreateHttpContextDTO / BeforeFinalizeContextDTO /
// AfterCompleteContextDTO / OnErrorContextDTO depending on `hook`. The
// worker copies these onto the `ctx` object handed to the registered
// handler. `metadataSnapshot` is the read-side of ctx.metadata (key→value
// pairs already committed by previous hooks). Pre-Hook writes are recorded
// synchronously in the Worker and returned as validated Hook-exit effects.
export type BridgeHookEnter = HookEnterMessageV1
export type BridgeHookScope = HookInvocationScopeV1
export type BridgeAbort = HookAbortMessageV1

// Host → worker: invoke a registered command by id.
// Used by test harness (test-helpers.ts callPlugin) and future Plan C invocations.
// The worker dispatches to the locally registered handler and replies with
// BridgeExecuteCommandResult.
export const BridgeExecuteCommandSchema = z.strictObject({
  type: z.literal('event'),
  event: z.literal('executeCommand'),
  id: z.number().int().positive().safe(),
  commandId: z.string().min(1).max(256),
  args: z.unknown(),
  commandScope: CommandInvocationScopeV1Schema,
})
export type BridgeExecuteCommand = z.infer<typeof BridgeExecuteCommandSchema>

// Host → worker: signal the worker to run its registered onDeactivate handlers.
export interface BridgeDeactivate {
  type: 'event'
  event: 'deactivate'
}

// Worker → host: sent after worker finishes running all onDeactivate handlers.
export interface BridgeDeactivateComplete {
  type: 'event'
  event: 'deactivateComplete'
  ok: boolean
  errorCode?: string
}

// Host → worker (one-way events).
export type BridgeEventMessage =
  | {
      type: 'event'
      event: 'localeChange'
      lang: string
      dir: 'ltr' | 'rtl'
      dict: ManifestLocaleDict
    }
  | { type: 'event'; event: 'shutdown' }
  | BridgeAbort
  | BridgeHookEnter
  | BridgeExecuteCommand
  | BridgeDeactivate

// Worker → host: sent after the Worker finishes handling a Hook. The Host
// accepts it only for the currently admitted invocation and validates effects
// before adding them to the staged chain.
export type BridgeHookExit = HookExitMessageV1

// Worker → host: result of a BridgeExecuteCommand invocation.
export const BridgeExecuteCommandResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('event'),
    event: z.literal('executeCommandResult'),
    id: z.number().int().positive().safe(),
    commandScope: BridgeExecuteCommandSchema.shape.commandScope,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('event'),
    event: z.literal('executeCommandResult'),
    id: z.number().int().positive().safe(),
    commandScope: BridgeExecuteCommandSchema.shape.commandScope,
    ok: z.literal(false),
    errorCode: z.string().min(1).max(128),
    errorMessage: z.string().max(16 * 1024),
  }),
])
export type BridgeExecuteCommandResult = z.infer<
  typeof BridgeExecuteCommandResultSchema
>

// Worker → host (one-way events).
export type BridgeWorkerEvent =
  | { type: 'ready' }
  | {
      type: 'register'
      kind: 'hook' | 'command'
      key: string // hook name or command id
    }
  | { type: 'fatal'; code: string; message: string }
  | BridgeHookExit
  | BridgeExecuteCommandResult
  | BridgeDeactivateComplete

export type HostToWorker =
  | BridgeInitMessage
  | BridgeResponseMessage
  | BridgeEventMessage

export type WorkerToHost = BridgeCallMessage | BridgeWorkerEvent
