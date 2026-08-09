// src/core/plugin/host/bridge-protocol.ts
// Bidirectional message protocol between QuickJSWorker (worker thread)
// and CapabilityBridge (main thread). Every message carries an `id`
// for request/response correlation; events use `id = 0`.

import type { PluginManifest } from '@shared/types/plugin'
import type { ManifestLocaleDict } from '../manifest/i18n-resolve'

export type BridgeMessageId = number // > 0 for calls; 0 for one-way events

// The four task-lifecycle hook names plugins can tap. Defined once here so the
// host, worker, and bridge share a single source of truth instead of
// re-spelling the union at each annotation site.
export type HookName =
  | 'beforeCreate'
  | 'beforeFinalize'
  | 'afterComplete'
  | 'onError'

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
export interface BridgeCallMessage {
  type: 'call'
  id: BridgeMessageId
  capability: string // 'log' | 'app' | 'i18n' | ...
  method: string
  args: unknown[]
}

// Host → worker.
export type BridgeResponseMessage =
  | { type: 'response'; id: BridgeMessageId; ok: true; result: unknown }
  | {
      type: 'response'
      id: BridgeMessageId
      ok: false
      error: { code: string; message: string }
    }

// Host → worker (one-way events).
// BridgeHookEnter: sent by host to worker when entering a hook invocation.
// ctxPayload carries the input fields the plugin reads from `ctx` —
// shaped after BeforeCreateHttpContextDTO / BeforeFinalizeContextDTO /
// AfterCompleteContextDTO / OnErrorContextDTO depending on `hook`. The
// worker copies these onto the `ctx` object handed to the registered
// handler. `metadataSnapshot` is the read-side of ctx.metadata (key→value
// pairs already committed by previous hooks); writes go through the
// staged-effect store via callHost('metadata', ...).
export interface BridgeHookEnter {
  type: 'event'
  event: 'hookEnter'
  hook: HookName
  taskId: string
  ctxPayload?: Record<string, unknown>
  metadataSnapshot?: Record<string, unknown>
}

// Host → worker: invoke a registered command by id.
// Used by test harness (test-helpers.ts callPlugin) and future Plan C invocations.
// The worker dispatches to the locally registered handler and replies with
// BridgeExecuteCommandResult.
export interface BridgeExecuteCommand {
  type: 'event'
  event: 'executeCommand'
  id: BridgeMessageId // correlation id for the response
  commandId: string
  args: unknown
}

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
  | { type: 'event'; event: 'abort' }
  | BridgeHookEnter
  | BridgeExecuteCommand
  | BridgeDeactivate

// Worker → host: sent after worker finishes handling a hook.
// Plan B: host receives this and clears currentFsTaskHost slot.
// Plan C: carries error context for chain-abort decisions.
export interface BridgeHookExit {
  type: 'event'
  event: 'hookExit'
  ok: boolean
  errorCode?: string
}

// Worker → host: result of a BridgeExecuteCommand invocation.
export type BridgeExecuteCommandResult =
  | {
      type: 'event'
      event: 'executeCommandResult'
      id: BridgeMessageId
      ok: true
      result: unknown
    }
  | {
      type: 'event'
      event: 'executeCommandResult'
      id: BridgeMessageId
      ok: false
      errorCode: string
      errorMessage: string
    }

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
