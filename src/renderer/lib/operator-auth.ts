import {
  type OperatorStatus,
  operatorStatusSchema,
} from '@shared/schemas/operator-auth'
import { create } from 'zustand'

const base = globalThis.location?.origin ?? ''
type SessionState =
  | 'checking'
  | 'authenticated'
  | 'locked'
  | 'unavailable'
  | 'logging-out'
interface OperatorSession {
  state: SessionState
  status: OperatorStatus | null
  epoch: number
}
export const useOperatorSession = create<OperatorSession>(() => ({
  state: 'checking',
  status: null,
  epoch: 0,
}))
const resetters = new Set<() => void>()
export function onOperatorSessionLost(reset: () => void): () => void {
  resetters.add(reset)
  return () => {
    resetters.delete(reset)
  }
}
let statusRequest = 0
let hints: BroadcastChannel | null = null

function locked(): void {
  useOperatorSession.setState((s) => ({
    state: 'locked',
    status: null,
    epoch: s.epoch + 1,
  }))
  for (const reset of resetters) {
    try {
      reset()
    } catch {
      /* One cache must not prevent other session cleanup. */
    }
  }
}

/** Responses are scoped to the login generation; a late 401 cannot evict a new login. */
export async function refreshOperatorSession(
  expectedEpoch = useOperatorSession.getState().epoch
): Promise<void> {
  if (
    expectedEpoch !== useOperatorSession.getState().epoch ||
    useOperatorSession.getState().state === 'logging-out'
  )
    return
  const request = ++statusRequest
  try {
    const res = await fetch(`${base}/rpc/auth/status`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`auth status ${res.status}`)
    const status = operatorStatusSchema.parse(await res.json())
    if (
      request !== statusRequest ||
      expectedEpoch !== useOperatorSession.getState().epoch
    )
      return
    if (!status.authed) locked()
    else useOperatorSession.setState({ state: 'authenticated', status })
  } catch {
    if (
      request !== statusRequest ||
      expectedEpoch !== useOperatorSession.getState().epoch
    )
      return
    // An unavailable server is not evidence that its cookie has been revoked.
    if (!useOperatorSession.getState().status?.authed)
      useOperatorSession.setState({ state: 'unavailable' })
  }
}

export function watchOperatorSession(): () => void {
  const check = () => {
    if (document.visibilityState === 'visible') void refreshOperatorSession()
  }
  if (typeof BroadcastChannel !== 'undefined') {
    hints = new BroadcastChannel('motrix-operator-session')
    hints.onmessage = () => {
      void refreshOperatorSession()
    }
  }
  window.addEventListener('focus', check)
  document.addEventListener('visibilitychange', check)
  return () => {
    hints?.close()
    hints = null
    window.removeEventListener('focus', check)
    document.removeEventListener('visibilitychange', check)
  }
}

export async function getOperatorStatus(): Promise<boolean> {
  await refreshOperatorSession()
  return useOperatorSession.getState().state === 'authenticated'
}

export async function operatorLogin(token: string): Promise<boolean> {
  const epoch = useOperatorSession.getState().epoch + 1
  statusRequest += 1
  useOperatorSession.setState({ epoch })
  try {
    const res = await fetch(`${base}/rpc/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    })
    if (!res.ok || epoch !== useOperatorSession.getState().epoch) return false
    await refreshOperatorSession(epoch)
    hints?.postMessage('changed')
    return useOperatorSession.getState().state === 'authenticated'
  } catch {
    return false
  }
}

export async function operatorLogout(): Promise<void> {
  const previous = useOperatorSession.getState()
  if (!previous.status?.canLogout || previous.state !== 'authenticated') return
  statusRequest += 1
  useOperatorSession.setState({
    state: 'logging-out',
    epoch: previous.epoch + 1,
  })
  try {
    const res = await fetch(`${base}/rpc/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (!res.ok && res.status !== 401) throw new Error(`logout ${res.status}`)
    locked()
    hints?.postMessage('changed')
  } catch (error) {
    useOperatorSession.setState({ state: 'authenticated' })
    // Do not retry a mutation. A status check resolves an ambiguous response.
    void refreshOperatorSession()
    throw error
  }
}
