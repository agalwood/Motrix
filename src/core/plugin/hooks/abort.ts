// A deadline belongs to one invocation, including its wait for admission.
// Only the bridge listener attached to that invocation may notify its worker.
// Dispose on completion without aborting the shared plugin's next invocation.

export interface HookAbortBudget {
  signal: AbortSignal
  abort(reason: string): void
  dispose(): void
}

export function newHookAbort(timeoutMs: number): HookAbortBudget {
  const ctrl = new AbortController()
  let disposed = false
  const timer = setTimeout(() => abort('timeout'), timeoutMs)

  function abort(reason: string): void {
    if (disposed) return
    clearTimeout(timer)
    ctrl.abort(reason)
  }

  return {
    signal: ctrl.signal,
    abort,
    dispose(): void {
      disposed = true
      clearTimeout(timer)
    },
  }
}
