/**
 * Operator-auth client for the server (web) build (Spec 9). The web UI is the
 * operator control plane; it authenticates to `/rpc` with the machine-owner
 * operator token, exchanged once for an httpOnly session cookie the browser
 * then sends automatically. These helpers talk to the `/rpc/auth/*` endpoints
 * directly (not through the RPC command/query transport). Desktop never calls
 * them (it uses IPC).
 */

const base = globalThis.location?.origin ?? ''

export async function getOperatorStatus(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/rpc/auth/status`, {
      credentials: 'same-origin',
    })
    if (!res.ok) return false
    const body = (await res.json()) as { authed?: boolean }
    return body.authed === true
  } catch {
    return false
  }
}

/** Exchange the machine-owner token for a session cookie. Returns true on
 *  success; the cookie is set httpOnly by the server (never seen by JS). */
export async function operatorLogin(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/rpc/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    })
    return res.ok
  } catch {
    return false
  }
}
