import { describeUrlForLog, log } from '@/background/log'

export interface ProbeDeps {
  fetch: typeof fetch
  /** Budget for the whole probe, HEAD and fallback together. */
  timeoutMs?: number
  now?: () => number
}

export interface ProbeResult {
  /** Content-Length (or the Content-Range total), or null when unknown. */
  sizeBytes: number | null
  /** Raw Content-Type header of the probed response, or null when unknown. */
  contentType: string | null
}

function parseLen(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Rehearse the request Motrix would make: one HEAD, falling back to a 1-byte
 * ranged GET when HEAD is unsupported or carries no length. Reports both the
 * size (for the config's minSizeMB rules) and the Content-Type (for the
 * replay-fidelity check in `replayFidelity.ts`).
 */
export async function probeTarget(
  url: string,
  deps: ProbeDeps
): Promise<ProbeResult> {
  const timeout = deps.timeoutMs ?? 3000
  const now = deps.now ?? Date.now
  // Firefox's background is a Window, whose fetch checks its receiver. Calling
  // deps.fetch(...) supplies ProbeDeps as `this` and rejects before networking.
  // Bind to the actual global instead of the dependency container.
  const fetchImpl = deps.fetch.bind(globalThis)
  // One deadline for both requests: the takeover hold budgets the probe at
  // 3 s in total, so the fallback only gets what the HEAD left over.
  const deadline = now() + timeout
  let contentType: string | null = null
  let headOutcome = 'no-length'
  const finish = (sizeBytes: number | null, outcome: string): ProbeResult => {
    log.debug(
      '[takeover] probe outcome=',
      outcome,
      'head=',
      headOutcome,
      'elapsedMs=',
      Math.max(0, timeout - (deadline - now())),
      'sizeBytes=',
      sizeBytes,
      'url=',
      describeUrlForLog(url)
    )
    return { sizeBytes, contentType }
  }
  try {
    const head = await fetchImpl(url, {
      method: 'HEAD',
      credentials: 'include',
      signal: AbortSignal.timeout(timeout),
    })
    if (head.ok) {
      contentType = head.headers.get('content-type')
      const len = parseLen(head.headers.get('content-length'))
      if (len !== null) {
        headOutcome = 'length'
        return finish(len, 'head-length')
      }
    } else {
      headOutcome = `http-${head.status}`
    }
  } catch {
    // A transport failure before the deadline need not mean GET is broken.
    // Keep the original shared budget; a timed-out HEAD gets no extra time.
    headOutcome = 'request-failed'
  }
  // HEAD unavailable or no length: try a 1-byte ranged GET.
  const remaining = deadline - now()
  if (remaining <= 0) return finish(null, 'budget-exhausted')
  try {
    const ranged = await fetchImpl(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(remaining),
    })
    try {
      if (!ranged.ok) return finish(null, `range-http-${ranged.status}`)
      contentType = ranged.headers.get('content-type') ?? contentType
      // A 206 Content-Length describes just the requested slice. A server
      // that ignores Range returns 200, whose Content-Length is the full size.
      const length =
        ranged.status === 206
          ? (ranged.headers.get('content-range')?.split('/')[1] ?? null)
          : ranged.headers.get('content-length')
      const sizeBytes = parseLen(length)
      return finish(
        sizeBytes,
        sizeBytes === null ? 'range-no-length' : 'range-length'
      )
    } finally {
      // Only the headers are needed, especially if Range was ignored and
      // the server started sending the whole file.
      await ranged.body?.cancel().catch(() => {})
    }
  } catch {
    return finish(
      null,
      now() >= deadline ? 'budget-exhausted' : 'range-request-failed'
    )
  }
}
