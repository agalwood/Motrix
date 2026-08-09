type Listener = () => void

export const ENGINE_FAILURE_TOAST_ID = 'engine-start-failed'

const listeners = new Set<Listener>()
let pendingRequest = false

export function requestEngineDiagnostics(): void {
  if (listeners.size === 0) pendingRequest = true
  for (const listener of listeners) listener()
}

export function consumeEngineDiagnosticsRequest(): boolean {
  const pending = pendingRequest
  pendingRequest = false
  return pending
}

export function subscribeEngineDiagnostics(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
