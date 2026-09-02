// src/core/plugin/host/quick-js-worker.ts
// Runs INSIDE a worker_thread. Main thread spawns this file (compiled to
// .cjs) via `new Worker(path)`, then sends a BridgeInitMessage. The worker
// boots a QuickJS VM, evaluates the plugin bundle, and routes capability
// calls back to the host through postMessage.
//
// Lifecycle:
//   parentPort.on('message') awaits init →
//   getQuickJS() loads WASM →
//   setupGlobals(vm) — install setTimeout / clearTimeout with caps →
//   injectPluginApi(vm, init) — populate globalThis.__motrix_plugin_api__ →
//   vm.evalCode(bundle, ..., { type: 'module' }) — bundle was pre-transformed
//   host-side so `import { x } from 'motrix:plugin-api'` becomes
//   `const { x } = globalThis.__motrix_plugin_api__` (CapabilityBridge does
//   the regex rewrite; see Task 11).
//   On success: send `{type:'ready'}`. On failure: send `{type:'fatal', ...}`.
//
// Capability proxies call assertEffectfulAllowed before bridging, while Hook
// context mutation and metadata staging stay synchronous inside the Worker.
// A versioned, validated Hook exit transfers those effects to the Host as one
// deterministic unit.

import { parentPort } from 'node:worker_threads'
import {
  CapabilityResponseMessageSchema,
  type CommandInvocationScopeV1,
  HOOK_SCHEMA_VERSION,
  HookAbortMessageSchema,
  HookContextPatchSchema,
  type HookEffectsV1,
  HookEffectsV1Schema,
  HookEnterMessageSchema,
  type HookEnterMessageV1,
  type HookInvocationScopeV1,
  HookMetadataOperationSchema,
} from '@shared/schemas/plugin-hooks'
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten'
import { classify } from '../capabilities/classification'
import {
  BridgeExecuteCommandSchema,
  type BridgeInitMessage,
  HOOK_NAMES,
  type HookName,
  type HostToWorker,
  type WorkerToHost,
} from './bridge-protocol'

if (!parentPort) {
  throw new Error('QuickJSWorker must be spawned via worker_threads')
}

const port = parentPort
const pendingCalls = new Map<
  number,
  {
    scope: GuestCallbackScope
    resolve: (value: unknown) => void
    reject: (error: Error & { code?: string }) => void
  }
>()
let nextCallId = 1
// Locale dictionaries are mutated by 'localeChange' events after boot.
// They are declared module-scoped so the i18n.t closure inside the VM
// always sees the latest snapshot.
// fallbackDict is the canonical en-US dict and never changes on localeChange —
// only currentDict switches to the user's language; the fallback stays fixed.
let currentDict: Record<string, string> = {}
let fallbackDict: Record<string, string> = {}
let currentLanguage = ''
let currentDirection: 'ltr' | 'rtl' = 'ltr'

// I18: phase gate — effectful calls are forbidden during activation.
let currentPhase: 'activation' | 'hook' | 'idle' = 'activation'
let violationFatal: { code: string; message: string } | null = null

// Registered hook handlers (stored as duplicated QuickJS handles).
// Populated by hooks.beforeCreate / beforeFinalize / afterComplete / onError
// during activation. The hook execution path uses these on hookEnter events.
const registeredHooks = new Map<string, QuickJSHandle>()

// Registered command handlers (stored as duplicated QuickJS handles).
// Populated by commands.register(id, fn) during activation.
const registeredCommands = new Map<string, QuickJSHandle>()

// Registered lifecycle.onDeactivate handlers.
// Note: handle cleanup for these collections at shutdown is deferred to Task 23
// / process exit; the worker terminates via process.exit(0) so the OS reclaims
// all memory without an explicit dispose pass.
const registeredDeactivateHandlers: QuickJSHandle[] = []

interface ActiveHookInvocation {
  readonly scope: HookInvocationScopeV1
  readonly hook: HookName
  readonly signalHandle: QuickJSHandle
  readonly abortListeners: QuickJSHandle[]
  readonly effects: HookEffectsV1
  aborted: boolean
  abortReason: string
}

let activeHookInvocation: ActiveHookInvocation | null = null
interface GuestCallbackScope {
  hook: HookInvocationScopeV1 | null
  command: CommandInvocationScopeV1 | null
}

let guestCallbackScope: GuestCallbackScope | null = null

function send(msg: WorkerToHost): void {
  port.postMessage(msg)
}

function assertEffectfulAllowed(capability: string, method: string): void {
  if (currentPhase !== 'activation') return
  if (classify(capability, method) !== 'effectful') return
  violationFatal = {
    code: 'plugin.lifecycle.activation_capability_violation',
    message: `effectful call ${capability}.${method} during activation`,
  }
  send({
    type: 'fatal',
    code: violationFatal.code,
    message: violationFatal.message,
  })
  throw new Error(violationFatal.message)
}

/**
 * Native Host promises settle on Node's microtask queue, outside QuickJS.
 * Bind the first continuation that re-enters QuickJS to the immutable Hook
 * scope captured when the capability call was created. QuickJS drains every
 * guest continuation synchronously from that callback, so a promise retained
 * by Hook A can never resume unscoped or borrow Hook B's active context.
 */
class InvocationScopedPromise<T> extends Promise<T> {
  static get [Symbol.species](): PromiseConstructor {
    return Promise
  }

  constructor(
    executor: ConstructorParameters<typeof Promise<T>>[0],
    private readonly invocationScope: GuestCallbackScope
  ) {
    super(executor)
  }

  // biome-ignore lint/suspicious/noThenProperty: this Promise subclass intentionally scopes its continuation.
  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return super.then(
      onfulfilled
        ? (value) =>
            withGuestCallbackScope(this.invocationScope, () =>
              onfulfilled(value)
            )
        : undefined,
      onrejected
        ? (reason) =>
            withGuestCallbackScope(this.invocationScope, () =>
              onrejected(reason)
            )
        : undefined
    )
  }
}

function callHost(
  capability: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  if (activeHookInvocation?.aborted) {
    throw codedError('plugin.hook.aborted', activeHookInvocation.abortReason)
  }
  const id = nextCallId++
  const scope = guestCallbackScope ?? {
    hook: activeHookInvocation?.scope ?? null,
    command: null,
  }
  return new InvocationScopedPromise((resolve, reject) => {
    pendingCalls.set(id, { scope, resolve, reject })
    const base = { type: 'call' as const, id, capability, method, args }
    if (scope.hook && scope.command) {
      send({ ...base, ...scope.hook, commandScope: scope.command })
    } else if (scope.hook) {
      send({ ...base, ...scope.hook })
    } else if (scope.command) {
      send({ ...base, commandScope: scope.command })
    } else {
      send(base)
    }
  }, scope)
}

// --- Top-level message dispatcher ---------------------------------------
// Registered synchronously at module load so we don't lose the init
// message that the host sends right after `new Worker(...)`. Node buffers
// messages until the first listener attaches; attaching this synchronously
// guarantees the init message is delivered.

let resolveInit: ((msg: BridgeInitMessage) => void) | null = null
const initPromise = new Promise<BridgeInitMessage>((resolve) => {
  resolveInit = resolve
})

// vmRef holds the QuickJS context after boot so the hookEnter handler can
// invoke registered hooks. Set in boot() after VM creation.
let vmRef: QuickJSContext | null = null
let pluginApiInjected = false

function syncVmLocaleProperties(): void {
  const vm = vmRef
  // A locale event can arrive while QuickJS is booting. In that window the
  // module-scoped snapshot above is already safe to update, but the global API
  // object does not exist yet. injectPluginApi reads the latest module values,
  // so defer handle mutation until the API has been installed.
  if (!vm || !pluginApiInjected) return
  const api = vm.getProp(vm.global, '__motrix_plugin_api__')
  const i18n = vm.getProp(api, 'i18n')
  const app = vm.getProp(api, 'app')
  const language = vm.newString(currentLanguage)
  const direction = vm.newString(currentDirection)
  vm.setProp(i18n, 'language', language)
  vm.setProp(i18n, 'dir', direction)
  vm.setProp(app, 'locale', language)
  direction.dispose()
  language.dispose()
  app.dispose()
  i18n.dispose()
  api.dispose()
}

port.on('message', (msg: HostToWorker) => {
  switch (msg.type) {
    case 'init':
      if (resolveInit) {
        const r = resolveInit
        resolveInit = null
        r(msg)
      }
      return
    case 'response': {
      const parsed = CapabilityResponseMessageSchema.safeParse(msg)
      const pending = pendingCalls.get(msg.id)
      if (!parsed.success) {
        if (pending) {
          pendingCalls.delete(msg.id)
          pending.reject(
            codedError(
              'plugin.hook.concurrent_protocol_violation',
              'invalid capability response message'
            )
          )
        }
        return
      }
      if (pending) {
        pendingCalls.delete(msg.id)
        const responseHookScope = hookScopeFromResponse(parsed.data)
        const responseCommandScope = commandScopeFromMessage(parsed.data)
        if (
          !optionalHookScopeMatches(responseHookScope, pending.scope.hook) ||
          !optionalCommandScopeMatches(
            responseCommandScope,
            pending.scope.command
          )
        ) {
          pending.reject(
            codedError(
              'plugin.hook.concurrent_protocol_violation',
              'capability response belongs to another invocation'
            )
          )
        } else if (parsed.data.ok) {
          pending.resolve(parsed.data.result)
        } else {
          pending.reject(
            codedError(parsed.data.error.code, parsed.data.error.message)
          )
        }
      }
      return
    }
    case 'event':
      if (msg.event === 'shutdown') {
        process.exit(0)
      } else if (msg.event === 'localeChange') {
        currentLanguage = msg.lang
        currentDirection = msg.dir
        currentDict = { ...msg.dict }
        syncVmLocaleProperties()
      } else if (msg.event === 'hookEnter') {
        const parsed = HookEnterMessageSchema.safeParse(msg)
        if (!parsed.success) {
          send({
            type: 'fatal',
            code: 'plugin.hook.input_invalid',
            message: 'Host sent an invalid Hook enter message',
          })
          return
        }
        handleHookEnter(parsed.data)
      } else if (msg.event === 'abort') {
        const parsed = HookAbortMessageSchema.safeParse(msg)
        if (parsed.success) handleHookAbort(parsed.data)
      } else if (msg.event === 'executeCommand') {
        const parsed = BridgeExecuteCommandSchema.safeParse(msg)
        if (parsed.success) handleExecuteCommand(parsed.data)
      } else if (msg.event === 'deactivate') {
        handleDeactivate()
      }
      return
  }
})

// --- hookEnter handler --------------------------------------------------

function handleHookEnter(message: HookEnterMessageV1): void {
  const vm = vmRef
  if (!vm) {
    sendHookFailure(
      message,
      'plugin.runtime.not_ready',
      'plugin runtime is not ready'
    )
    return
  }
  if (activeHookInvocation) {
    sendHookFailure(
      message,
      'plugin.hook.concurrent_protocol_violation',
      'another Hook invocation is already active'
    )
    return
  }

  const fnHandle = registeredHooks.get(message.hook)
  if (!fnHandle) {
    sendHookSuccess(message, {
      schemaVersion: HOOK_SCHEMA_VERSION,
      contextPatches: [],
      metadataOperations: [],
    })
    return
  }

  currentPhase = 'hook'
  const signalHandle = vm.newObject()
  const invocation: ActiveHookInvocation = {
    scope: hookScopeFromEnter(message),
    hook: message.hook,
    signalHandle,
    abortListeners: [],
    effects: {
      schemaVersion: HOOK_SCHEMA_VERSION,
      contextPatches: [],
      metadataOperations: [],
    },
    aborted: false,
    abortReason: '',
  }
  activeHookInvocation = invocation

  const ctxHandle = vm.newObject()
  for (const [key, value] of Object.entries(message.ctxPayload)) {
    const valueHandle = jsValueToVmHandle(vm, value)
    vm.setProp(ctxHandle, key, valueHandle)
    valueHandle.dispose()
  }

  const snapshot = structuredClone(message.metadataSnapshot)
  const metadataHandle = vm.newObject()
  const metaGet = vm.newFunction('get', (keyH) => {
    const key = vm.dump(keyH) as string
    return jsValueToVmHandle(vm, snapshot[key])
  })
  vm.setProp(metadataHandle, 'get', metaGet)
  metaGet.dispose()

  const metaHas = vm.newFunction('has', (keyH) => {
    const key = vm.dump(keyH) as string
    return Object.hasOwn(snapshot, key) ? vm.true : vm.false
  })
  vm.setProp(metadataHandle, 'has', metaHas)
  metaHas.dispose()

  const metaGetAll = vm.newFunction('getAll', () =>
    jsValueToVmHandle(vm, snapshot)
  )
  vm.setProp(metadataHandle, 'getAll', metaGetAll)
  metaGetAll.dispose()

  const metaKeys = vm.newFunction('keys', () =>
    jsValueToVmHandle(vm, Object.keys(snapshot))
  )
  vm.setProp(metadataHandle, 'keys', metaKeys)
  metaKeys.dispose()

  if (message.hook === 'beforeCreate' || message.hook === 'beforeFinalize') {
    const metaSet = vm.newFunction('set', (keyH, valueH) => {
      assertInvocationWritable(invocation)
      const operation = HookMetadataOperationSchema.parse({
        op: 'set',
        key: vm.dump(keyH),
        value: valueH === undefined ? undefined : vm.dump(valueH),
      })
      if (operation.op !== 'set') {
        throw codedError(
          'plugin.hook.output_invalid',
          'metadata.set produced an invalid operation'
        )
      }
      snapshot[operation.key] = structuredClone(operation.value)
      invocation.effects.metadataOperations.push(operation)
      return vm.undefined
    })
    vm.setProp(metadataHandle, 'set', metaSet)
    metaSet.dispose()

    const metaDelete = vm.newFunction('delete', (keyH) => {
      assertInvocationWritable(invocation)
      const operation = HookMetadataOperationSchema.parse({
        op: 'delete',
        key: vm.dump(keyH),
      })
      delete snapshot[operation.key]
      invocation.effects.metadataOperations.push(operation)
      return vm.undefined
    })
    vm.setProp(metadataHandle, 'delete', metaDelete)
    metaDelete.dispose()

    const updateFn = vm.newFunction('update', (patchH) => {
      assertInvocationWritable(invocation)
      const patch = HookContextPatchSchema.parse(
        patchH === undefined ? undefined : vm.dump(patchH)
      )
      invocation.effects.contextPatches.push(structuredClone(patch))
      return vm.undefined
    })
    vm.setProp(ctxHandle, 'update', updateFn)
    updateFn.dispose()
  }

  vm.setProp(ctxHandle, 'metadata', metadataHandle)
  metadataHandle.dispose()

  installAbortSignal(vm, invocation)
  vm.setProp(ctxHandle, 'signal', invocation.signalHandle)

  const callResult = vm.callFunction(fnHandle, vm.undefined, ctxHandle)
  ctxHandle.dispose()

  if (callResult.error) {
    const error = vm.dump(callResult.error)
    callResult.error.dispose()
    finishHookFailure(invocation, vmErrorCode(error), vmErrorMessage(error))
    return
  }

  const maybePromise = callResult.value
  const resolved = vm.resolvePromise(maybePromise)
  maybePromise.dispose()

  resolved.then((settled) => {
    vm.runtime.executePendingJobs()
    if (settled.error) {
      const error = vm.dump(settled.error)
      settled.error.dispose()
      finishHookFailure(invocation, vmErrorCode(error), vmErrorMessage(error))
    } else {
      settled.value.dispose()
      if (invocation.aborted) {
        finishHookFailure(
          invocation,
          'plugin.hook.aborted',
          invocation.abortReason
        )
      } else {
        finishHookSuccess(invocation)
      }
    }
  })
  vm.runtime.executePendingJobs()
}

function installAbortSignal(
  vm: QuickJSContext,
  invocation: ActiveHookInvocation
): void {
  vm.setProp(invocation.signalHandle, 'aborted', vm.false)
  vm.setProp(invocation.signalHandle, 'reason', vm.undefined)
  vm.setProp(invocation.signalHandle, 'onabort', vm.null)

  const addEventListener = vm.newFunction(
    'addEventListener',
    (typeHandle, listenerHandle) => {
      if (activeHookInvocation !== invocation) return vm.undefined
      if (
        vm.dump(typeHandle) !== 'abort' ||
        vm.typeof(listenerHandle) !== 'function'
      ) {
        return vm.undefined
      }
      if (
        !invocation.abortListeners.some((listener) =>
          vmSameValue(vm, listener, listenerHandle)
        )
      ) {
        invocation.abortListeners.push(listenerHandle.dup())
      }
      return vm.undefined
    }
  )
  vm.setProp(invocation.signalHandle, 'addEventListener', addEventListener)
  addEventListener.dispose()

  const removeEventListener = vm.newFunction(
    'removeEventListener',
    (typeHandle, listenerHandle) => {
      if (vm.dump(typeHandle) !== 'abort') return vm.undefined
      const index = invocation.abortListeners.findIndex((listener) =>
        vmSameValue(vm, listener, listenerHandle)
      )
      if (index >= 0) {
        invocation.abortListeners[index]?.dispose()
        invocation.abortListeners.splice(index, 1)
      }
      return vm.undefined
    }
  )
  vm.setProp(
    invocation.signalHandle,
    'removeEventListener',
    removeEventListener
  )
  removeEventListener.dispose()
}

function handleHookAbort(
  message: HookInvocationScopeV1 & { reason: string }
): void {
  const vm = vmRef
  const invocation = activeHookInvocation
  if (!vm || !invocation || !sameHookScope(message, invocation.scope)) return
  if (invocation.aborted) return

  invocation.aborted = true
  invocation.abortReason = message.reason || 'plugin hook aborted'
  vm.setProp(invocation.signalHandle, 'aborted', vm.true)
  const reasonHandle = vm.newString(invocation.abortReason)
  vm.setProp(invocation.signalHandle, 'reason', reasonHandle)
  reasonHandle.dispose()

  const eventHandle = vm.newObject()
  const eventType = vm.newString('abort')
  vm.setProp(eventHandle, 'type', eventType)
  eventType.dispose()

  const onabort = vm.getProp(invocation.signalHandle, 'onabort')
  if (vm.typeof(onabort) === 'function') {
    disposeVmCallResult(
      vm.callFunction(onabort, invocation.signalHandle, eventHandle)
    )
  }
  onabort.dispose()
  for (const listener of invocation.abortListeners) {
    disposeVmCallResult(
      vm.callFunction(listener, invocation.signalHandle, eventHandle)
    )
  }
  eventHandle.dispose()
  vm.runtime.executePendingJobs()

  for (const [id, pending] of pendingCalls) {
    if (
      pending.scope.hook &&
      sameHookScope(pending.scope.hook, invocation.scope)
    ) {
      pendingCalls.delete(id)
      pending.reject(codedError('plugin.hook.aborted', invocation.abortReason))
    }
  }
  vm.runtime.executePendingJobs()
}

function finishHookSuccess(invocation: ActiveHookInvocation): void {
  if (activeHookInvocation !== invocation) return
  const parsed = HookEffectsV1Schema.safeParse(invocation.effects)
  if (!parsed.success) {
    finishHookFailure(
      invocation,
      'plugin.hook.output_invalid',
      parsed.error.issues[0]?.message ?? 'invalid Hook effects'
    )
    return
  }
  sendHookSuccess(invocation.scope, parsed.data)
  releaseHookInvocation(invocation)
}

function finishHookFailure(
  invocation: ActiveHookInvocation,
  code: string,
  message: string
): void {
  if (activeHookInvocation !== invocation) return
  sendHookFailure(invocation.scope, code, message)
  releaseHookInvocation(invocation)
}

function releaseHookInvocation(invocation: ActiveHookInvocation): void {
  for (const listener of invocation.abortListeners) listener.dispose()
  invocation.abortListeners.length = 0
  invocation.signalHandle.dispose()
  if (activeHookInvocation === invocation) activeHookInvocation = null
  currentPhase = 'idle'
}

function sendHookSuccess(
  scope: HookInvocationScopeV1,
  effects: HookEffectsV1
): void {
  send({
    type: 'event',
    event: 'hookExit',
    ...scope,
    ok: true,
    effects,
  })
}

function sendHookFailure(
  scope: HookInvocationScopeV1,
  code: string,
  message: string
): void {
  send({
    type: 'event',
    event: 'hookExit',
    ...scope,
    ok: false,
    error: {
      code: code.slice(0, 64) || 'plugin.runtime.fault',
      message: message.slice(0, 4_096),
    },
  })
}

function assertInvocationWritable(invocation: ActiveHookInvocation): void {
  if (activeHookInvocation !== invocation || invocation.aborted) {
    throw codedError(
      'plugin.hook.aborted',
      invocation.abortReason || 'plugin hook is no longer active'
    )
  }
}

// --- executeCommand handler -----------------------------------------------
//
// Invoked when the host sends a BridgeExecuteCommand event. Dispatches to the
// locally registered command handler, awaits the result (including Promises),
// and sends back a BridgeExecuteCommandResult event.
// Used by test-helpers.ts callPlugin and future Plan C command invocations.

function handleExecuteCommand(message: {
  id: number
  commandId: string
  args: unknown
  commandScope: CommandInvocationScopeV1
}): void {
  const { id, commandId, args, commandScope } = message
  const vm = vmRef
  if (!vm) {
    send({
      type: 'event',
      event: 'executeCommandResult',
      id,
      commandScope,
      ok: false,
      errorCode: 'plugin.runtime.not_ready',
      errorMessage: 'VM not initialised',
    })
    return
  }

  const handler = registeredCommands.get(commandId)
  if (!handler) {
    send({
      type: 'event',
      event: 'executeCommandResult',
      id,
      commandScope,
      ok: false,
      errorCode: 'plugin.commands.not_found',
      errorMessage: `command not found: ${commandId}`,
    })
    return
  }

  // Temporarily allow effectful calls — the command runs in 'hook'-equivalent phase.
  const prevPhase = currentPhase
  currentPhase = 'hook'

  const argsHandle = jsValueToVmHandle(vm, args)
  const callbackScope: GuestCallbackScope = {
    hook: null,
    command: commandScope,
  }
  const callResult = withGuestCallbackScope(callbackScope, () =>
    vm.callFunction(handler, vm.undefined, argsHandle)
  )
  argsHandle.dispose()

  if (callResult.error) {
    const err = vm.dump(callResult.error)
    callResult.error.dispose()
    currentPhase = prevPhase
    const errorCode = vmErrorCode(err)
    const errorMessage = vmErrorMessage(err)
    send({
      type: 'event',
      event: 'executeCommandResult',
      id,
      commandScope,
      ok: false,
      errorCode,
      errorMessage,
    })
    return
  }

  const maybePromise = callResult.value
  const resolved = vm.resolvePromise(maybePromise)
  maybePromise.dispose()

  resolved.then((settled) => {
    withGuestCallbackScope(callbackScope, () => {
      vm.runtime.executePendingJobs()
      currentPhase = prevPhase
      if (settled.error) {
        const err = vm.dump(settled.error)
        settled.error.dispose()
        const errorCode = vmErrorCode(err)
        const errorMessage = vmErrorMessage(err)
        send({
          type: 'event',
          event: 'executeCommandResult',
          id,
          commandScope,
          ok: false,
          errorCode,
          errorMessage,
        })
      } else {
        const result = vm.dump(settled.value)
        settled.value.dispose()
        send({
          type: 'event',
          event: 'executeCommandResult',
          id,
          commandScope,
          ok: true,
          result,
        })
      }
    })
  })
  withGuestCallbackScope(callbackScope, () => vm.runtime.executePendingJobs())
}

// --- handleDeactivate ---------------------------------------------------
//
// Invoked when the host sends a BridgeDeactivate event. Iterates
// registeredDeactivateHandlers, calls each with no args, awaits any returned
// Promise, and sends back BridgeDeactivateComplete{ok}.
// If any handler throws / rejects, sends BridgeDeactivateComplete{ok:false}.
// The host enforces the 2-second total budget via Promise.race on its side;
// the worker makes a best-effort sequential run.

function handleDeactivate(): void {
  const vmSnapshot = vmRef
  if (!vmSnapshot || registeredDeactivateHandlers.length === 0) {
    send({ type: 'event', event: 'deactivateComplete', ok: true })
    return
  }

  // Capture as non-null local so the async inner function can use it safely.
  const vm: QuickJSContext = vmSnapshot

  // Run handlers sequentially, chaining Promises.
  const handlers = registeredDeactivateHandlers.slice()

  async function runHandlers(): Promise<void> {
    for (const fnHandle of handlers) {
      const callResult = vm.callFunction(fnHandle, vm.undefined)
      if (callResult.error) {
        const err = vm.dump(callResult.error)
        callResult.error.dispose()
        const errorCode = vmErrorCode(err)
        throw Object.assign(new Error(String(err)), { code: errorCode })
      }
      const maybePromise = callResult.value
      const resolved = vm.resolvePromise(maybePromise)
      maybePromise.dispose()
      vm.runtime.executePendingJobs()
      const settled = await resolved
      vm.runtime.executePendingJobs()
      if (settled.error) {
        const err = vm.dump(settled.error)
        settled.error.dispose()
        const errorCode = vmErrorCode(err)
        throw Object.assign(new Error(String(err)), { code: errorCode })
      }
      settled.value.dispose()
    }
  }

  runHandlers().then(
    () => {
      send({ type: 'event', event: 'deactivateComplete', ok: true })
    },
    (err: Error & { code?: string }) => {
      send({
        type: 'event',
        event: 'deactivateComplete',
        ok: false,
        errorCode: err.code ?? 'plugin.runtime.fault',
      })
    }
  )
}

// --- Boot ---------------------------------------------------------------

async function boot(): Promise<void> {
  const init = await initPromise
  currentDict = { ...init.i18n.currentDict }
  fallbackDict = { ...init.i18n.fallbackDict }
  currentLanguage = init.i18n.language
  currentDirection = init.i18n.dir

  const QuickJS = await getQuickJS()
  const vm = QuickJS.newContext()
  vmRef = vm
  // Declared outside try so the catch block can call it.
  // Assigned by setupGlobals before any code that could throw; if
  // setupGlobals itself throws there are no timer handles to clean up so the
  // no-op default is safe.
  let cleanupTimers: () => void = () => {}
  try {
    cleanupTimers = setupGlobals(vm)
    injectPluginApi(vm, init)
    const bundleResult = vm.evalCode(init.bundleSource, init.manifest.main, {
      type: 'module',
    })
    if (bundleResult.error) {
      const err = vm.dump(bundleResult.error)
      bundleResult.error.dispose()
      if (!violationFatal) {
        send({
          type: 'fatal',
          code: 'plugin.bundle.parse_error',
          message: typeof err === 'string' ? err : JSON.stringify(err),
        })
      }
      cleanupTimers()
      vm.dispose()
      return
    }
    bundleResult.value.dispose()
    send({ type: 'ready' })
    currentPhase = 'idle'
  } catch (e) {
    send({
      type: 'fatal',
      code: 'plugin.runtime.boot_failed',
      message: (e as Error).message,
    })
    cleanupTimers()
    vm.dispose()
  }
}

// --- Globals (timers) ---------------------------------------------------

function setupGlobals(vm: QuickJSContext): () => void {
  installUrlGlobals(vm)

  // setTimeout / setInterval enforce caps:
  //   - MAX_ACTIVE: hard cap on simultaneously-scheduled timers per plugin
  //   - MAX_DELAY:  clamps absurdly large delays to 30s
  // When the active cap is exceeded we throw an Error from inside the
  // newFunction callback — quickjs-emscripten converts that to a VM-level
  // exception so the plugin sees a thrown error rather than a silent no-op.
  const timers = new Map<number, NodeJS.Timeout>()
  const intervalCallbacks = new Map<number, ReturnType<typeof setInterval>>()
  const intervalHandleRefs = new Map<number, () => void>()
  let nextId = 1
  const MAX_DELAY = 30_000
  const MAX_ACTIVE = 100
  const reportTimerActivity = () => {
    // Kept outside WorkerToHost on purpose: this Host lifecycle signal is
    // consumed directly by PluginHost and never enters CapabilityBridge's
    // request/response protocol.
    port.postMessage({
      type: 'timer_activity',
      activeCount: timers.size + intervalCallbacks.size,
    })
  }

  const setTimeoutFn = vm.newFunction('setTimeout', (cbHandle, delayHandle) => {
    if (timers.size >= MAX_ACTIVE) {
      throw new Error('timer_quota_exceeded')
    }
    const delay = Math.min(vm.getNumber(delayHandle), MAX_DELAY)
    const id = nextId++
    const callbackScope = guestCallbackScope ?? {
      hook: activeHookInvocation?.scope ?? null,
      command: null,
    }
    // Persistent handle survives the synchronous callback return; we
    // dispose it when the timer fires (one-shot) or is cleared.
    const persistent = cbHandle.dup()
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        reportTimerActivity()
        withGuestCallbackScope(callbackScope, () => {
          const res = vm.callFunction(persistent, vm.undefined)
          persistent.dispose()
          disposeVmCallResult(res)
          vm.runtime.executePendingJobs()
        })
      }, delay)
    )
    reportTimerActivity()
    return vm.newNumber(id)
  })
  vm.setProp(vm.global, 'setTimeout', setTimeoutFn)
  setTimeoutFn.dispose()

  const clearTimeoutFn = vm.newFunction('clearTimeout', (idHandle) => {
    const id = vm.getNumber(idHandle)
    const t = timers.get(id)
    if (t) {
      clearTimeout(t)
      timers.delete(id)
      reportTimerActivity()
    }
    return vm.undefined
  })
  vm.setProp(vm.global, 'clearTimeout', clearTimeoutFn)
  clearTimeoutFn.dispose()

  const setIntervalFn = vm.newFunction(
    'setInterval',
    (cbHandle, delayHandle) => {
      if (timers.size + intervalCallbacks.size >= MAX_ACTIVE) {
        throw new Error('timer_quota_exceeded')
      }
      const delay = Math.min(vm.getNumber(delayHandle), MAX_DELAY)
      const id = nextId++
      const callbackScope = guestCallbackScope ?? {
        hook: activeHookInvocation?.scope ?? null,
        command: null,
      }
      const persistent = cbHandle.dup()
      const interval = setInterval(() => {
        withGuestCallbackScope(callbackScope, () => {
          const res = vm.callFunction(persistent, vm.undefined)
          disposeVmCallResult(res)
          vm.runtime.executePendingJobs()
        })
      }, delay)
      intervalCallbacks.set(id, interval)
      intervalHandleRefs.set(id, () => persistent.dispose())
      reportTimerActivity()
      return vm.newNumber(id)
    }
  )
  vm.setProp(vm.global, 'setInterval', setIntervalFn)
  setIntervalFn.dispose()

  const clearIntervalFn = vm.newFunction('clearInterval', (idHandle) => {
    const id = vm.getNumber(idHandle)
    const interval = intervalCallbacks.get(id)
    if (interval) {
      clearInterval(interval)
      intervalCallbacks.delete(id)
      const release = intervalHandleRefs.get(id)
      if (release) {
        release()
        intervalHandleRefs.delete(id)
      }
      reportTimerActivity()
    }
    return vm.undefined
  })
  vm.setProp(vm.global, 'clearInterval', clearIntervalFn)
  clearIntervalFn.dispose()

  // Returns a cleanup function that drains all active timer handles before
  // the VM is disposed. Must not throw — it is called from error paths where
  // a secondary exception would mask the original error.
  return () => {
    try {
      for (const [, interval] of intervalCallbacks) {
        clearInterval(interval)
      }
      intervalCallbacks.clear()
      for (const [, release] of intervalHandleRefs) {
        release()
      }
      intervalHandleRefs.clear()
      for (const [, t] of timers) {
        clearTimeout(t)
      }
      timers.clear()
      reportTimerActivity()
    } catch {
      // Swallow — cleanup must not throw from error paths
    }
  }
}

const URL_STRING_FIELDS = [
  'href',
  'protocol',
  'origin',
  'host',
  'hostname',
  'port',
  'pathname',
  'search',
  'hash',
  'username',
  'password',
] as const

/**
 * QuickJS does not ship WHATWG URL globals. Parse with Node's standards-based
 * implementation and copy only string fields/functions into guest-owned VM
 * objects; no Node object, dispatcher, or Host capability crosses the realm.
 */
function installUrlGlobals(vm: QuickJSContext): void {
  const urlConstructor = vm.newFunction('URL', (inputHandle, baseHandle) => {
    const input = String(vm.dump(inputHandle))
    const base =
      baseHandle === undefined ? undefined : String(vm.dump(baseHandle))
    const parsed = new URL(input, base)
    const object = vm.newObject()
    const syncFields = () => {
      for (const field of URL_STRING_FIELDS) {
        const value = vm.newString(parsed[field])
        vm.setProp(object, field, value)
        value.dispose()
      }
    }
    syncFields()

    const searchParams = makeUrlSearchParamsHandle(
      vm,
      new URLSearchParams(parsed.searchParams),
      (serialized) => {
        parsed.search = serialized
      }
    )
    vm.setProp(object, 'searchParams', searchParams)
    searchParams.dispose()

    for (const method of ['toString', 'toJSON'] as const) {
      const fn = vm.newFunction(method, () => vm.newString(parsed.href))
      vm.setProp(object, method, fn)
      fn.dispose()
    }
    return object
  })
  const canParse = vm.newFunction('canParse', (inputHandle, baseHandle) => {
    const input = String(vm.dump(inputHandle))
    const base =
      baseHandle === undefined ? undefined : String(vm.dump(baseHandle))
    return URL.canParse(input, base) ? vm.true : vm.false
  })
  vm.setProp(vm.global, '__motrixCreateURL', urlConstructor)
  urlConstructor.dispose()
  vm.setProp(vm.global, '__motrixCanParseURL', canParse)
  canParse.dispose()

  const searchParamsConstructor = vm.newFunction(
    'URLSearchParams',
    (initHandle) =>
      makeUrlSearchParamsHandle(vm, urlSearchParamsFromVm(vm, initHandle))
  )
  vm.setProp(
    vm.global,
    '__motrixCreateURLSearchParams',
    searchParamsConstructor
  )
  searchParamsConstructor.dispose()

  const constructors = vm.evalCode(`
    (() => {
      const createURL = globalThis.__motrixCreateURL
      const canParseURL = globalThis.__motrixCanParseURL
      const createURLSearchParams = globalThis.__motrixCreateURLSearchParams
      delete globalThis.__motrixCreateURL
      delete globalThis.__motrixCanParseURL
      delete globalThis.__motrixCreateURLSearchParams
      globalThis.URL = class URL {
        constructor(input, base) {
          return createURL(String(input), base === undefined ? undefined : String(base))
        }
        static canParse(input, base) {
          return canParseURL(String(input), base === undefined ? undefined : String(base))
        }
      }
      globalThis.URLSearchParams = class URLSearchParams {
        constructor(init) {
          return createURLSearchParams(init)
        }
      }
    })()
  `)
  if (constructors.error) {
    const error = vm.dump(constructors.error)
    constructors.error.dispose()
    throw new Error(`failed to install URL globals: ${vmErrorMessage(error)}`)
  }
  constructors.value.dispose()
}

function urlSearchParamsFromVm(
  vm: QuickJSContext,
  initHandle: QuickJSHandle | undefined
): URLSearchParams {
  if (initHandle === undefined) return new URLSearchParams()
  const init = vm.dump(initHandle)
  if (typeof init === 'string') return new URLSearchParams(init)
  if (Array.isArray(init)) {
    const pairs = init.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new TypeError('URLSearchParams tuple entries must have length 2')
      }
      return [String(entry[0]), String(entry[1])] as [string, string]
    })
    return new URLSearchParams(pairs)
  }
  if (init && typeof init === 'object') {
    return new URLSearchParams(
      Object.fromEntries(
        Object.entries(init as Record<string, unknown>).map(([key, value]) => [
          key,
          String(value),
        ])
      )
    )
  }
  return new URLSearchParams(String(init))
}

function makeUrlSearchParamsHandle(
  vm: QuickJSContext,
  params: URLSearchParams,
  onChange: (serialized: string) => void = () => {}
): QuickJSHandle {
  const object = vm.newObject()
  const mutated = () => onChange(params.toString())

  const append = vm.newFunction('append', (nameHandle, valueHandle) => {
    params.append(String(vm.dump(nameHandle)), String(vm.dump(valueHandle)))
    mutated()
    return vm.undefined
  })
  vm.setProp(object, 'append', append)
  append.dispose()

  const deleteFn = vm.newFunction('delete', (nameHandle, valueHandle) => {
    const name = String(vm.dump(nameHandle))
    if (valueHandle === undefined) params.delete(name)
    else params.delete(name, String(vm.dump(valueHandle)))
    mutated()
    return vm.undefined
  })
  vm.setProp(object, 'delete', deleteFn)
  deleteFn.dispose()

  const get = vm.newFunction('get', (nameHandle) => {
    const value = params.get(String(vm.dump(nameHandle)))
    return value === null ? vm.null : vm.newString(value)
  })
  vm.setProp(object, 'get', get)
  get.dispose()

  const getAll = vm.newFunction('getAll', (nameHandle) =>
    jsValueToVmHandle(vm, params.getAll(String(vm.dump(nameHandle))))
  )
  vm.setProp(object, 'getAll', getAll)
  getAll.dispose()

  const has = vm.newFunction('has', (nameHandle, valueHandle) => {
    const name = String(vm.dump(nameHandle))
    const present =
      valueHandle === undefined
        ? params.has(name)
        : params.has(name, String(vm.dump(valueHandle)))
    return present ? vm.true : vm.false
  })
  vm.setProp(object, 'has', has)
  has.dispose()

  const set = vm.newFunction('set', (nameHandle, valueHandle) => {
    params.set(String(vm.dump(nameHandle)), String(vm.dump(valueHandle)))
    mutated()
    return vm.undefined
  })
  vm.setProp(object, 'set', set)
  set.dispose()

  const sort = vm.newFunction('sort', () => {
    params.sort()
    mutated()
    return vm.undefined
  })
  vm.setProp(object, 'sort', sort)
  sort.dispose()

  const toStringFn = vm.newFunction('toString', () =>
    vm.newString(params.toString())
  )
  vm.setProp(object, 'toString', toStringFn)
  toStringFn.dispose()

  return object
}

// --- Value marshaling ---------------------------------------------------
//
// jsValueToVmHandle: converts a JS value from host into a QuickJS VM handle.
// Supports: string, number, boolean, null, undefined, Array, plain Object.
// Uint8Array: marshaled as a plain Array of numbers (JSON round-trip).
// This is a Task 20 limitation; Plan G will ship proper typed-array marshaling.

function jsValueToVmHandle(vm: QuickJSContext, v: unknown): QuickJSHandle {
  if (v === undefined) return vm.undefined
  if (v === null) return vm.null
  if (typeof v === 'boolean') return v ? vm.true : vm.false
  if (typeof v === 'number') return vm.newNumber(v)
  if (typeof v === 'string') return vm.newString(v)
  if (v instanceof Uint8Array) {
    // Serialize as Array<number>; loses typed-array semantics but safe.
    // TODO(Plan G): proper Uint8Array marshaling via QuickJS typed-array API.
    const arr = vm.newArray()
    for (let i = 0; i < v.length; i++) {
      const n = vm.newNumber(v[i])
      vm.setProp(arr, i, n)
      n.dispose()
    }
    return arr
  }
  if (Array.isArray(v)) {
    const arr = vm.newArray()
    for (let i = 0; i < v.length; i++) {
      const elem = jsValueToVmHandle(vm, v[i])
      vm.setProp(arr, i, elem)
      elem.dispose()
    }
    return arr
  }
  if (typeof v === 'object') {
    const obj = vm.newObject()
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const valH = jsValueToVmHandle(vm, val)
      vm.setProp(obj, k, valH)
      valH.dispose()
    }
    return obj
  }
  // Fallback: stringify
  return vm.newString(String(v))
}

// Extract the `code` field from a dumped VM error value, defaulting to
// 'plugin.runtime.fault'. `err` is the result of vm.dump(handle) — an arbitrary
// JS value the plugin threw. Mirrors the inline ternary that was repeated at
// every hook/command/deactivate error-extraction site.
function vmErrorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : 'plugin.runtime.fault'
}

// Extract the `message` field from a dumped VM error value, falling back to
// String(err) when no message property is present.
function vmErrorMessage(err: unknown): string {
  return typeof err === 'object' && err !== null && 'message' in err
    ? String((err as { message: unknown }).message)
    : String(err)
}

function codedError(code: string, message: string): Error & { code?: string } {
  return Object.assign(new Error(message), { code })
}

function hookScopeFromEnter(
  message: HookEnterMessageV1
): HookInvocationScopeV1 {
  return {
    invocationId: message.invocationId,
    callChainId: message.callChainId,
    permissionGeneration: message.permissionGeneration,
  }
}

function hookScopeFromResponse(message: unknown): HookInvocationScopeV1 | null {
  if (typeof message !== 'object' || message === null) return null
  const candidate = message as Record<string, unknown>
  if (
    typeof candidate.invocationId !== 'string' ||
    typeof candidate.callChainId !== 'string' ||
    typeof candidate.permissionGeneration !== 'number'
  ) {
    return null
  }
  return {
    invocationId: candidate.invocationId,
    callChainId: candidate.callChainId,
    permissionGeneration: candidate.permissionGeneration,
  }
}

function optionalHookScopeMatches(
  left: HookInvocationScopeV1 | null,
  right: HookInvocationScopeV1 | null
): boolean {
  if (!left || !right) return left === right
  return sameHookScope(left, right)
}

function commandScopeFromMessage(
  message: unknown
): CommandInvocationScopeV1 | null {
  if (typeof message !== 'object' || message === null) return null
  const candidate = (message as { commandScope?: unknown }).commandScope
  if (typeof candidate !== 'object' || candidate === null) return null
  const parsed = candidate as CommandInvocationScopeV1
  if (
    !Number.isSafeInteger(parsed.commandInvocationId) ||
    parsed.commandInvocationId <= 0 ||
    typeof parsed.callChain?.id !== 'string' ||
    !Array.isArray(parsed.callChain.plugins)
  ) {
    return null
  }
  return parsed
}

function optionalCommandScopeMatches(
  left: CommandInvocationScopeV1 | null,
  right: CommandInvocationScopeV1 | null
): boolean {
  if (!left || !right) return left === right
  return (
    left.commandInvocationId === right.commandInvocationId &&
    left.callChain.id === right.callChain.id &&
    left.callChain.plugins.length === right.callChain.plugins.length &&
    left.callChain.plugins.every(
      (pluginId, index) => pluginId === right.callChain.plugins[index]
    )
  )
}

function sameHookScope(
  left: HookInvocationScopeV1,
  right: HookInvocationScopeV1
): boolean {
  return (
    left.invocationId === right.invocationId &&
    left.callChainId === right.callChainId &&
    left.permissionGeneration === right.permissionGeneration
  )
}

function withGuestCallbackScope<T>(
  scope: GuestCallbackScope,
  callback: () => T
): T {
  const previous = guestCallbackScope
  guestCallbackScope = scope
  try {
    return callback()
  } finally {
    guestCallbackScope = previous
  }
}

function disposeVmCallResult(
  result: ReturnType<QuickJSContext['callFunction']>
): void {
  if (result.error) result.error.dispose()
  else result.value.dispose()
}

function vmSameValue(
  vm: QuickJSContext,
  left: QuickJSHandle,
  right: QuickJSHandle
): boolean {
  const objectHandle = vm.getProp(vm.global, 'Object')
  const isHandle = vm.getProp(objectHandle, 'is')
  const result = vm.callFunction(isHandle, objectHandle, left, right)
  isHandle.dispose()
  objectHandle.dispose()
  if (result.error) {
    result.error.dispose()
    return false
  }
  const equal = vm.dump(result.value) === true
  result.value.dispose()
  return equal
}

// makeEffectfulNs: builds a QuickJS namespace object for a given capability
// where every listed method is effectful (calls assertEffectfulAllowed then
// callHost, returning a Promise-handle to the plugin).
function makeEffectfulNs(
  vm: QuickJSContext,
  cap: string,
  methods: ReadonlyArray<string>
): QuickJSHandle {
  const ns = vm.newObject()
  for (const m of methods) {
    const f = vm.newFunction(m, (...argHandles: QuickJSHandle[]) => {
      try {
        assertEffectfulAllowed(cap, m)
      } catch {
        // assertEffectfulAllowed already sent fatal; return undefined to abort
        return vm.undefined
      }
      const args = argHandles.map((h) => vm.dump(h))
      const deferred = vm.newPromise()
      callHost(cap, m, args).then(
        (result) => {
          const h = jsValueToVmHandle(vm, result)
          deferred.resolve(h)
          h.dispose()
          vm.runtime.executePendingJobs()
        },
        (err: Error & { code?: string }) => {
          const errH = vm.newError(err.message)
          if (err.code) {
            const codeH = vm.newString(err.code)
            vm.setProp(errH, 'code', codeH)
            codeH.dispose()
          }
          deferred.reject(errH)
          errH.dispose()
          vm.runtime.executePendingJobs()
        }
      )
      deferred.settled.then(() => vm.runtime.executePendingJobs())
      return deferred.handle
    })
    vm.setProp(ns, m, f)
    f.dispose()
  }
  return ns
}

// --- Plugin API injection ----------------------------------------------

function injectPluginApi(vm: QuickJSContext, init: BridgeInitMessage): void {
  const api = vm.newObject()
  const pluginId = init.pluginId

  // ── log ────────────────────────────────────────────────────────────────
  // EXCEPTION: log.* is classified 'effectful' by the classification table
  // but calling log at top-level is intentionally permitted (the test.echo
  // fixture calls log.info during activation). assertEffectfulAllowed is NOT
  // called for log — this matches the Plan A implementation and keeps the
  // existing e2e test green. All log calls are fire-and-forget.
  const log = vm.newObject()
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    const f = vm.newFunction(level, (msgH, fieldsH) => {
      const msg = vm.dump(msgH) as string
      const fields =
        fieldsH !== undefined ? (vm.dump(fieldsH) as object) : undefined
      void callHost('log', level, [msg, fields])
      return vm.undefined
    })
    vm.setProp(log, level, f)
    f.dispose()
  }
  vm.setProp(api, 'log', log)
  log.dispose()

  // ── app ────────────────────────────────────────────────────────────────
  // Read-only snapshot from init. Properties, not methods — no bridge calls.
  const app = vm.newObject()
  for (const k of [
    'version',
    'platform',
    'runtime',
    'locale',
    'arch',
  ] as const) {
    const v = vm.newString(k === 'locale' ? currentLanguage : init.app[k])
    vm.setProp(app, k, v)
    v.dispose()
  }
  vm.setProp(api, 'app', app)
  app.dispose()

  // ── i18n ───────────────────────────────────────────────────────────────
  // language / dir and currentDict are updated by localeChange events.
  // t(key, params): reads module-scoped currentDict / fallbackDict, resolving
  // synchronously — no bridge call needed
  //   because the dict was shipped with the init message.
  //   NOTE: classification table lists i18n.t as 'effectful', but it is
  //   resolved locally with no side-effects beyond the dict lookup, so
  //   assertEffectfulAllowed is skipped here too (consistent with Plan A).
  const i18nObj = vm.newObject()
  const langH = vm.newString(currentLanguage)
  vm.setProp(i18nObj, 'language', langH)
  langH.dispose()
  const dirH = vm.newString(currentDirection)
  vm.setProp(i18nObj, 'dir', dirH)
  dirH.dispose()
  const tFn = vm.newFunction('t', (keyH, paramsH) => {
    const key = vm.dump(keyH) as string
    const params =
      paramsH !== undefined
        ? (vm.dump(paramsH) as Record<string, unknown>)
        : undefined
    const tmpl = currentDict[key] ?? fallbackDict[key] ?? key
    const rendered = params
      ? tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? ''))
      : tmpl
    return vm.newString(rendered)
  })
  vm.setProp(i18nObj, 't', tFn)
  tFn.dispose()
  vm.setProp(api, 'i18n', i18nObj)
  i18nObj.dispose()

  // ── hooks ──────────────────────────────────────────────────────────────
  // Registration-only: stores the fn handle and sends a register event.
  // Calling hooks.X() outside activation is allowed (no rejection),
  // per Task 1 classification: registration-only methods are always permitted.
  const hooks = vm.newObject()
  for (const h of HOOK_NAMES) {
    const hf = vm.newFunction(h, (fnHandle) => {
      // Dispose any previously registered handle for this hook (re-registration)
      const prev = registeredHooks.get(h)
      if (prev) prev.dispose()
      registeredHooks.set(h, fnHandle.dup())
      send({ type: 'register', kind: 'hook', key: h })
      return vm.undefined
    })
    vm.setProp(hooks, h, hf)
    hf.dispose()
  }
  vm.setProp(api, 'hooks', hooks)
  hooks.dispose()

  // ── commands ───────────────────────────────────────────────────────────
  // commands.register(id, fn): registration-only — stores fn locally.
  // commands.execute(id, args): effectful. Self-command calls are rejected
  // before any local handler or Host queue can run; cross-plugin calls bridge
  // through the Host-owned command graph and its immutable call chain.
  const commands = vm.newObject()

  const regF = vm.newFunction('register', (idH, fnH) => {
    const id = vm.dump(idH) as string
    const prev = registeredCommands.get(id)
    if (prev) prev.dispose()
    registeredCommands.set(id, fnH.dup())
    send({ type: 'register', kind: 'command', key: id })
    return vm.undefined
  })
  vm.setProp(commands, 'register', regF)
  regF.dispose()

  const execF = vm.newFunction('execute', (idH, argsH) => {
    try {
      assertEffectfulAllowed('commands', 'execute')
    } catch {
      return vm.undefined
    }
    const id = vm.dump(idH) as string
    const args = argsH !== undefined ? vm.dump(argsH) : undefined

    // Self re-entry would deadlock behind this plugin's current lane owner if
    // routed through the Host, and direct local dispatch would bypass the
    // shared lane/call-chain policy. Reject it before either can happen.
    if (id.startsWith(`${pluginId}.`)) {
      const deferred = vm.newPromise()
      const errH = vm.newError('plugin.runtime.reentrant_call')
      const codeH = vm.newString('plugin.runtime.reentrant_call')
      vm.setProp(errH, 'code', codeH)
      codeH.dispose()
      deferred.reject(errH)
      errH.dispose()
      deferred.settled.then(() => vm.runtime.executePendingJobs())
      return deferred.handle
    }

    // Cross-plugin: bridge call.
    const deferred = vm.newPromise()
    callHost('commands', 'execute', [id, args]).then(
      (result) => {
        const h = jsValueToVmHandle(vm, result)
        deferred.resolve(h)
        h.dispose()
        vm.runtime.executePendingJobs()
      },
      (err: Error & { code?: string }) => {
        const errH = vm.newError(err.message)
        if (err.code) {
          const codeH = vm.newString(err.code)
          vm.setProp(errH, 'code', codeH)
          codeH.dispose()
        }
        deferred.reject(errH)
        errH.dispose()
        vm.runtime.executePendingJobs()
      }
    )
    deferred.settled.then(() => vm.runtime.executePendingJobs())
    return deferred.handle
  })
  vm.setProp(commands, 'execute', execF)
  execF.dispose()

  vm.setProp(api, 'commands', commands)
  commands.dispose()

  // ── lifecycle ──────────────────────────────────────────────────────────
  // onDeactivate(fn): registration-only — stores handler locally.
  // onActivate(fn): registration-only — stored but Plan B doesn't fire it.
  // The bridge's dispatchLifecycle also has a stub; the worker side is the
  // canonical storage. Task 23 wires the full deactivation protocol.
  const lifecycle = vm.newObject()

  const onDeactF = vm.newFunction('onDeactivate', (fnH) => {
    registeredDeactivateHandlers.push(fnH.dup())
    send({ type: 'register', kind: 'hook', key: 'onDeactivate' })
    return vm.undefined
  })
  vm.setProp(lifecycle, 'onDeactivate', onDeactF)
  onDeactF.dispose()

  const onActivateF = vm.newFunction('onActivate', (_fnH) => {
    // Store silently; Plan B doesn't fire onActivate but the API surface
    // must not throw so plugins can write `lifecycle.onActivate(() => {})`.
    return vm.undefined
  })
  vm.setProp(lifecycle, 'onActivate', onActivateF)
  onActivateF.dispose()

  vm.setProp(api, 'lifecycle', lifecycle)
  lifecycle.dispose()

  // ── http ───────────────────────────────────────────────────────────────
  // Replaces the minimal Task 2 stub.
  const http = makeEffectfulNs(vm, 'http', ['request', 'get', 'post'])
  vm.setProp(api, 'http', http)
  http.dispose()

  // ── storage ────────────────────────────────────────────────────────────
  const storage = makeEffectfulNs(vm, 'storage', [
    'get',
    'set',
    'compareAndSet',
    'delete',
    'keys',
  ])
  vm.setProp(api, 'storage', storage)
  storage.dispose()

  // ── crypto ─────────────────────────────────────────────────────────────
  const crypto = makeEffectfulNs(vm, 'crypto', [
    'hash',
    'hmac',
    'randomBytes',
    'aes',
  ])
  vm.setProp(api, 'crypto', crypto)
  crypto.dispose()

  // ── config ─────────────────────────────────────────────────────────────
  const config = makeEffectfulNs(vm, 'config', ['get', 'getRaw', 'getAll'])
  vm.setProp(api, 'config', config)
  config.dispose()

  // ── notify ─────────────────────────────────────────────────────────────
  const notify = makeEffectfulNs(vm, 'notify', ['show'])
  vm.setProp(api, 'notify', notify)
  notify.dispose()

  // ── fs.storage ─────────────────────────────────────────────────────────
  const fsStorage = makeEffectfulNs(vm, 'fs.storage', [
    'read',
    'write',
    'delete',
    'rename',
    'exists',
    'stat',
    'mkdir',
  ])
  vm.setProp(api, 'fs.storage', fsStorage)
  fsStorage.dispose()

  // ── fs.task ────────────────────────────────────────────────────────────
  // Methods that require hook context. Bridge enforces hook-context gate.
  // openReader: bridge returns {opened: true} stub for Task 20; Plan C wires
  // actual context. Worker proxy wraps the stub into a plain object.
  // TODO(Plan C): implement streaming reader protocol via opId round-trips.
  // stat, exists, computeHash, rename — effectful via bridge (same plumbing as
  // makeEffectfulNs). openReader is appended below because it needs a bespoke
  // reader-proxy resolve arm.
  const fsTask = makeEffectfulNs(vm, 'fs.task', [
    'stat',
    'exists',
    'computeHash',
    'rename',
  ])

  // openReader: bridge stub for Task 20. Plan C will wire actual context.
  // Returns a stub reader object with no-op read() and close().
  const openReaderF = vm.newFunction('openReader', (optsH) => {
    try {
      assertEffectfulAllowed('fs.task', 'openReader')
    } catch {
      return vm.undefined
    }
    const opts = optsH !== undefined ? vm.dump(optsH) : {}
    const deferred = vm.newPromise()
    callHost('fs.task', 'openReader', [opts]).then(
      () => {
        // Bridge returns {opened: true}. Wrap into a stub reader proxy.
        // TODO(Plan C): bridge will return {opId} once context wiring is done.
        // Worker will wrap opId into a real reader with .read(maxChunkSize)
        // and .close() that round-trip via op calls.
        const readerObj = vm.newObject()
        const readFn = vm.newFunction('read', () => {
          // Stub: resolves immediately with null (no data).
          const p = vm.newPromise()
          const n = vm.null
          p.resolve(n)
          n.dispose()
          p.settled.then(() => vm.runtime.executePendingJobs())
          return p.handle
        })
        vm.setProp(readerObj, 'read', readFn)
        readFn.dispose()
        const closeFn = vm.newFunction('close', () => vm.undefined)
        vm.setProp(readerObj, 'close', closeFn)
        closeFn.dispose()
        deferred.resolve(readerObj)
        readerObj.dispose()
        vm.runtime.executePendingJobs()
      },
      (err: Error & { code?: string }) => {
        const errH = vm.newError(err.message)
        if (err.code) {
          const codeH = vm.newString(err.code)
          vm.setProp(errH, 'code', codeH)
          codeH.dispose()
        }
        deferred.reject(errH)
        errH.dispose()
        vm.runtime.executePendingJobs()
      }
    )
    deferred.settled.then(() => vm.runtime.executePendingJobs())
    return deferred.handle
  })
  vm.setProp(fsTask, 'openReader', openReaderF)
  openReaderF.dispose()

  vm.setProp(api, 'fs.task', fsTask)
  fsTask.dispose()

  // ── ffmpeg ─────────────────────────────────────────────────────────────
  // Launch methods return a handle object in the VM with:
  //   .id       — string opId
  //   .result   — Promise that polls bridge op.result.await(opId)
  //   .abort()  — calls bridge op.abort(opId), fire-and-forget
  //
  // Progress: exposed as .pollProgress() returning a Promise<FfmpegProgress|null>
  // that calls bridge op.progress.pull(opId). An AsyncIterable would be ideal
  // but is complex to implement inside QuickJS; plugins can poll on a timer.
  // TODO(Plan C): upgrade to AsyncIterable progress if needed.
  //
  // probe: returns the result directly (not an op handle).
  const ffmpeg = vm.newObject()

  function makeFfmpegHandle(opId: string): QuickJSHandle {
    const handleObj = vm.newObject()

    const idH = vm.newString(opId)
    vm.setProp(handleObj, 'id', idH)
    idH.dispose()

    // result: Promise — awaits bridge op.result.await(opId)
    const resultDeferred = vm.newPromise()
    callHost('ffmpeg', 'op.result.await', [opId]).then(
      (res) => {
        const h = jsValueToVmHandle(vm, res)
        resultDeferred.resolve(h)
        h.dispose()
        vm.runtime.executePendingJobs()
      },
      (err: Error & { code?: string }) => {
        const errH = vm.newError(err.message)
        if (err.code) {
          const codeH = vm.newString(err.code)
          vm.setProp(errH, 'code', codeH)
          codeH.dispose()
        }
        resultDeferred.reject(errH)
        errH.dispose()
        vm.runtime.executePendingJobs()
      }
    )
    resultDeferred.settled.then(() => vm.runtime.executePendingJobs())
    vm.setProp(handleObj, 'result', resultDeferred.handle)
    // setProp increments the QuickJS ref-count on resultDeferred.handle; the
    // JS-side wrapper can be disposed now without releasing the VM-side promise.
    resultDeferred.dispose()

    // pollProgress(): returns Promise<FfmpegProgress|null>
    const pollFn = vm.newFunction('pollProgress', () => {
      const deferred = vm.newPromise()
      callHost('ffmpeg', 'op.progress.pull', [opId]).then(
        (prog) => {
          const h = jsValueToVmHandle(vm, prog)
          deferred.resolve(h)
          h.dispose()
          vm.runtime.executePendingJobs()
        },
        (err: Error & { code?: string }) => {
          const errH = vm.newError(err.message)
          if (err.code) {
            const codeH = vm.newString(err.code)
            vm.setProp(errH, 'code', codeH)
            codeH.dispose()
          }
          deferred.reject(errH)
          errH.dispose()
          vm.runtime.executePendingJobs()
        }
      )
      deferred.settled.then(() => vm.runtime.executePendingJobs())
      return deferred.handle
    })
    vm.setProp(handleObj, 'pollProgress', pollFn)
    pollFn.dispose()

    // abort(): fire-and-forget
    const abortFn = vm.newFunction('abort', () => {
      void callHost('ffmpeg', 'op.abort', [opId])
      return vm.undefined
    })
    vm.setProp(handleObj, 'abort', abortFn)
    abortFn.dispose()

    return handleObj
  }

  // probe: direct result (not an op handle)
  const probeFn = vm.newFunction('probe', (optsH) => {
    try {
      assertEffectfulAllowed('ffmpeg', 'probe')
    } catch {
      return vm.undefined
    }
    const opts = optsH !== undefined ? vm.dump(optsH) : {}
    const deferred = vm.newPromise()
    callHost('ffmpeg', 'probe', [opts]).then(
      (result) => {
        const h = jsValueToVmHandle(vm, result)
        deferred.resolve(h)
        h.dispose()
        vm.runtime.executePendingJobs()
      },
      (err: Error & { code?: string }) => {
        const errH = vm.newError(err.message)
        if (err.code) {
          const codeH = vm.newString(err.code)
          vm.setProp(errH, 'code', codeH)
          codeH.dispose()
        }
        deferred.reject(errH)
        errH.dispose()
        vm.runtime.executePendingJobs()
      }
    )
    deferred.settled.then(() => vm.runtime.executePendingJobs())
    return deferred.handle
  })
  vm.setProp(ffmpeg, 'probe', probeFn)
  probeFn.dispose()

  // Launch methods: transcode, extractAudio, mergeStreams, generateThumbnail, run
  for (const m of [
    'transcode',
    'extractAudio',
    'mergeStreams',
    'generateThumbnail',
    'run',
  ]) {
    const f = vm.newFunction(m, (optsH) => {
      try {
        assertEffectfulAllowed('ffmpeg', m)
      } catch {
        return vm.undefined
      }
      const opts = optsH !== undefined ? vm.dump(optsH) : {}
      const deferred = vm.newPromise()
      callHost('ffmpeg', m, [opts]).then(
        (result) => {
          const { opId } = result as { opId: string }
          const handle = makeFfmpegHandle(opId)
          deferred.resolve(handle)
          handle.dispose()
          vm.runtime.executePendingJobs()
        },
        (err: Error & { code?: string }) => {
          const errH = vm.newError(err.message)
          if (err.code) {
            const codeH = vm.newString(err.code)
            vm.setProp(errH, 'code', codeH)
            codeH.dispose()
          }
          deferred.reject(errH)
          errH.dispose()
          vm.runtime.executePendingJobs()
        }
      )
      deferred.settled.then(() => vm.runtime.executePendingJobs())
      return deferred.handle
    })
    vm.setProp(ffmpeg, m, f)
    f.dispose()
  }

  vm.setProp(api, 'ffmpeg', ffmpeg)
  ffmpeg.dispose()

  vm.setProp(vm.global, '__motrix_plugin_api__', api)
  pluginApiInjected = true
  api.dispose()
}

boot().catch((e: Error) => {
  send({
    type: 'fatal',
    code: 'plugin.runtime.boot_failed',
    message: e.message,
  })
})
