// src/core/plugin/hooks/abort.ts
// Host-owned AbortController for a single hook invocation (I37).
//
// Lifecycle:
//   1. newHookAbort() arms a deadline timer (timeoutMs).
//   2. On timeout OR explicit abort(), the AbortController fires.
//   3. The abort listener notifies the bridge (worker receives 'abort' event).
//   4. terminate() aborts first, then waits a 1-second grace period before
//      calling worker.terminate() as a backstop for hung workers.

import type { Worker } from 'node:worker_threads'
import type { CapabilityBridge } from '../host/capability-bridge'

export interface HookAbortBudget {
  signal: AbortSignal
  abort(reason: string): void
  terminate(): Promise<void>
}

export function newHookAbort(
  bridge: CapabilityBridge,
  worker: Worker,
  timeoutMs: number
): HookAbortBudget {
  const ctrl = new AbortController()

  // Arm the deadline timer; cleared if abort fires before it expires.
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs)

  ctrl.signal.addEventListener('abort', () => {
    clearTimeout(timer)
    bridge.notifyAbort()
  })

  return {
    signal: ctrl.signal,

    abort(reason: string): void {
      ctrl.abort(reason)
    },

    async terminate(): Promise<void> {
      ctrl.abort('terminate')
      // Grace period: give in-flight ops up to 1 s to clean up after abort.
      await new Promise<void>((r) => setTimeout(r, 1_000))
      await worker.terminate()
    },
  }
}
