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
// Task 20: injectPluginApi rebuilt to expose proxies for ALL Phase 1A
// capabilities. Each effectful proxy calls assertEffectfulAllowed before
// bridging; hook/command registration stores handles locally; hookEnter
// events dispatch into registered handlers.
//
// Tests for this module live in Task 21's e2e fixture (test.allcaps).
// Direct worker unit tests are omitted — WASM + worker_threads complexity
// makes them fragile compared to the e2e path.

import { parentPort } from 'node:worker_threads'
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten'
import { classify } from '../capabilities/classification'
import {
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
const pendingCalls = new Map<number, (msg: HostToWorker) => void>()
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

async function callHost(
  capability: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const id = nextCallId++
  return new Promise((resolve, reject) => {
    pendingCalls.set(id, (resp) => {
      if (resp.type !== 'response') return
      if (resp.ok) {
        resolve(resp.result)
      } else {
        const e: Error & { code?: string } = new Error(resp.error.message)
        e.code = resp.error.code
        reject(e)
      }
    })
    send({ type: 'call', id, capability, method, args })
  })
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
      const handler = pendingCalls.get(msg.id)
      if (handler) {
        pendingCalls.delete(msg.id)
        handler(msg)
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
        handleHookEnter(
          msg.hook,
          msg.taskId,
          msg.ctxPayload,
          msg.metadataSnapshot
        )
      } else if (msg.event === 'executeCommand') {
        handleExecuteCommand(msg.id, msg.commandId, msg.args)
      } else if (msg.event === 'deactivate') {
        handleDeactivate()
      }
      return
  }
})

// --- hookEnter handler --------------------------------------------------

function handleHookEnter(
  hook: HookName,
  taskId: string,
  ctxPayload?: Record<string, unknown>,
  metadataSnapshot?: Record<string, unknown>
): void {
  const vm = vmRef
  if (!vm) {
    send({
      type: 'event',
      event: 'hookExit',
      ok: false,
      errorCode: 'plugin.runtime.not_ready',
    })
    return
  }

  const fnHandle = registeredHooks.get(hook)
  if (!fnHandle) {
    // No handler registered for this hook — no-op exit.
    send({ type: 'event', event: 'hookExit', ok: true })
    return
  }

  currentPhase = 'hook'

  // Construct ctx envelope inside the VM.
  //   - taskId          always present (bridge supplies it)
  //   - ctxPayload      hook-shape fields (type, uris, headers, ...) — required
  //                     by every plugin's branching logic at handler entry
  //   - ctx.metadata    {get(key), set(key,v), delete(key)} — set/delete are
  //                     staged via the bridge, get reads from the snapshot
  //                     supplied by the orchestrator (committed by previous
  //                     hooks in the chain)
  //   - ctx.update      patches uris/headers/proxy/filename for series hooks
  // The bridge.handleStaged decides whether each call is allowed under the
  // current role + phase (matrix gate) — the worker just proxies.
  const ctxHandle = vm.newObject()
  const taskIdHandle = vm.newString(taskId)
  vm.setProp(ctxHandle, 'taskId', taskIdHandle)
  taskIdHandle.dispose()

  // Copy each ctxPayload field as a top-level ctx property.
  if (ctxPayload) {
    for (const [k, v] of Object.entries(ctxPayload)) {
      if (v === undefined) continue
      const valH = jsValueToVmHandle(vm, v)
      vm.setProp(ctxHandle, k, valH)
      valH.dispose()
    }
  }

  // ctx.metadata — readable via snapshot, writable via staged effects.
  const snapshot = metadataSnapshot ?? {}
  const metadataHandle = vm.newObject()
  const metaGet = vm.newFunction('get', (keyH) => {
    const key = vm.dump(keyH) as string
    const val = (snapshot as Record<string, unknown>)[key]
    return jsValueToVmHandle(vm, val)
  })
  vm.setProp(metadataHandle, 'get', metaGet)
  metaGet.dispose()
  const metaSet = vm.newFunction('set', (keyH, valueH) => {
    const key = vm.dump(keyH) as string
    const value = valueH !== undefined ? vm.dump(valueH) : undefined
    // Fire-and-forget; staged store accepts on host side.
    void callHost('metadata', 'set', [key, value])
    return vm.undefined
  })
  vm.setProp(metadataHandle, 'set', metaSet)
  metaSet.dispose()
  const metaDelete = vm.newFunction('delete', (keyH) => {
    const key = vm.dump(keyH) as string
    void callHost('metadata', 'delete', [key])
    return vm.undefined
  })
  vm.setProp(metadataHandle, 'delete', metaDelete)
  metaDelete.dispose()
  vm.setProp(ctxHandle, 'metadata', metadataHandle)
  metadataHandle.dispose()

  const updateFn = vm.newFunction('update', (patchH) => {
    const patch = patchH !== undefined ? vm.dump(patchH) : undefined
    const deferred = vm.newPromise()
    callHost('ctx', 'update', [patch]).then(
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
  vm.setProp(ctxHandle, 'update', updateFn)
  updateFn.dispose()

  const callResult = vm.callFunction(fnHandle, vm.undefined, ctxHandle)
  ctxHandle.dispose()

  if (callResult.error) {
    const err = vm.dump(callResult.error)
    callResult.error.dispose()
    currentPhase = 'idle'
    const errorCode = vmErrorCode(err)
    send({ type: 'event', event: 'hookExit', ok: false, errorCode })
    return
  }

  // The hook may return a Promise. Use vm.resolvePromise to await it.
  const maybePromise = callResult.value
  const resolved = vm.resolvePromise(maybePromise)
  maybePromise.dispose()

  resolved.then((settled) => {
    vm.runtime.executePendingJobs()
    if (settled.error) {
      const err = vm.dump(settled.error)
      settled.error.dispose()
      currentPhase = 'idle'
      const errorCode = vmErrorCode(err)
      send({ type: 'event', event: 'hookExit', ok: false, errorCode })
    } else {
      settled.value.dispose()
      currentPhase = 'idle'
      send({ type: 'event', event: 'hookExit', ok: true })
    }
  })
  vm.runtime.executePendingJobs()
}

// --- executeCommand handler -----------------------------------------------
//
// Invoked when the host sends a BridgeExecuteCommand event. Dispatches to the
// locally registered command handler, awaits the result (including Promises),
// and sends back a BridgeExecuteCommandResult event.
// Used by test-helpers.ts callPlugin and future Plan C command invocations.

function handleExecuteCommand(
  id: number,
  commandId: string,
  args: unknown
): void {
  const vm = vmRef
  if (!vm) {
    send({
      type: 'event',
      event: 'executeCommandResult',
      id,
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
  const callResult = vm.callFunction(handler, vm.undefined, argsHandle)
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
        ok: true,
        result,
      })
    }
  })
  vm.runtime.executePendingJobs()
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
  // setTimeout / setInterval enforce caps:
  //   - MAX_ACTIVE: hard cap on simultaneously-scheduled timers per plugin
  //   - MAX_DELAY:  clamps absurdly large delays to 30s
  // When the active cap is exceeded we throw an Error from inside the
  // newFunction callback — quickjs-emscripten converts that to a VM-level
  // exception so the plugin sees a thrown error rather than a silent no-op.
  const timers = new Map<number, NodeJS.Timeout>()
  let nextId = 1
  const MAX_DELAY = 30_000
  const MAX_ACTIVE = 100

  const setTimeoutFn = vm.newFunction('setTimeout', (cbHandle, delayHandle) => {
    if (timers.size >= MAX_ACTIVE) {
      throw new Error('timer_quota_exceeded')
    }
    const delay = Math.min(vm.getNumber(delayHandle), MAX_DELAY)
    const id = nextId++
    // Persistent handle survives the synchronous callback return; we
    // dispose it when the timer fires (one-shot) or is cleared.
    const persistent = cbHandle.dup()
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        const res = vm.callFunction(persistent, vm.undefined)
        persistent.dispose()
        if (res.error) {
          res.error.dispose()
        } else {
          res.value.dispose()
        }
      }, delay)
    )
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
    }
    return vm.undefined
  })
  vm.setProp(vm.global, 'clearTimeout', clearTimeoutFn)
  clearTimeoutFn.dispose()

  const intervalCallbacks = new Map<number, ReturnType<typeof setInterval>>()
  const intervalHandleRefs = new Map<number, () => void>()

  const setIntervalFn = vm.newFunction(
    'setInterval',
    (cbHandle, delayHandle) => {
      if (timers.size + intervalCallbacks.size >= MAX_ACTIVE) {
        throw new Error('timer_quota_exceeded')
      }
      const delay = Math.min(vm.getNumber(delayHandle), MAX_DELAY)
      const id = nextId++
      const persistent = cbHandle.dup()
      const interval = setInterval(() => {
        const res = vm.callFunction(persistent, vm.undefined)
        if (res.error) {
          res.error.dispose()
        } else {
          res.value.dispose()
        }
      }, delay)
      intervalCallbacks.set(id, interval)
      intervalHandleRefs.set(id, () => persistent.dispose())
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
    } catch {
      // Swallow — cleanup must not throw from error paths
    }
  }
}

// --- Value marshaling ---------------------------------------------------
//
// jsValueToVmHandle: converts a JS value from host into a QuickJS VM handle.
// Supports: string, number, boolean, null, undefined, Array, plain Object.
// Uint8Array: marshaled as a plain Array of numbers (JSON round-trip).
// This is a Task 20 limitation; Plan G will ship proper typed-array marshaling.

function jsValueToVmHandle(vm: QuickJSContext, v: unknown): QuickJSHandle {
  if (v === null || v === undefined) return vm.null
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
  // commands.execute(id, args): effectful.
  //   Own-namespace (id starts with `${pluginId}.`): dispatch locally to
  //   the stored handler without a bridge round-trip.
  //   Cross-plugin: bridge call.
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

    // Own-namespace: call the local handler directly.
    if (id.startsWith(`${pluginId}.`)) {
      const handler = registeredCommands.get(id)
      if (!handler) {
        const deferred = vm.newPromise()
        const errH = vm.newError(`command not found: ${id}`)
        const codeH = vm.newString('plugin.commands.not_found')
        vm.setProp(errH, 'code', codeH)
        codeH.dispose()
        deferred.reject(errH)
        errH.dispose()
        deferred.settled.then(() => vm.runtime.executePendingJobs())
        return deferred.handle
      }
      const deferred = vm.newPromise()
      const argsHandle = jsValueToVmHandle(vm, args)
      const callResult = vm.callFunction(handler, vm.undefined, argsHandle)
      argsHandle.dispose()
      if (callResult.error) {
        const err = vm.dump(callResult.error)
        callResult.error.dispose()
        const msg = vmErrorMessage(err)
        const errH = vm.newError(msg)
        deferred.reject(errH)
        errH.dispose()
        deferred.settled.then(() => vm.runtime.executePendingJobs())
        return deferred.handle
      }
      // Handler may return a Promise or a plain value.
      const retResolved = vm.resolvePromise(callResult.value)
      callResult.value.dispose()
      retResolved.then((settled) => {
        vm.runtime.executePendingJobs()
        if (settled.error) {
          const errH = settled.error
          deferred.reject(errH)
          errH.dispose()
        } else {
          deferred.resolve(settled.value)
          settled.value.dispose()
        }
        vm.runtime.executePendingJobs()
      })
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

  // ── metadata ───────────────────────────────────────────────────────────
  const metadata = makeEffectfulNs(vm, 'metadata', [
    'get',
    'has',
    'getAll',
    'keys',
    'set',
    'delete',
  ])
  vm.setProp(api, 'metadata', metadata)
  metadata.dispose()

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
