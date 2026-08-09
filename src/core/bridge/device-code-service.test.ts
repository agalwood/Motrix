import type { ClientIdentity } from '@shared/protocol/bridge'
import { describe, expect, it, vi } from 'vitest'
import { DeviceCodeService } from './device-code-service'
import type { PairedClient, PairingService } from './pairing-service'

/** Records issueToken calls and hands back deterministic tokens. */
function makeFakePairing() {
  let n = 0
  const calls: Array<{ identity: ClientIdentity; name: string }> = []
  const svc = {
    issueToken: async (identity: ClientIdentity, name: string) => {
      calls.push({ identity, name })
      const token = `tok-${++n}`
      return {
        identity,
        token,
        name,
        pairedAt: 0,
        lastActiveAt: null,
      } as PairedClient
    },
  } as unknown as PairingService
  return { svc, calls }
}

/** A promise you resolve by hand — to hold issueToken mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** A controllable clock so TTL / rate-limit are deterministic. */
function makeClock(start = 1000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('DeviceCodeService.request', () => {
  it('returns a requestId, a human userCode, and an expiry', () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 300_000 })

    const r = dc.request('Motrix CLI', '1.0.0')
    expect(r.requestId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(r.requestId.length).toBeGreaterThanOrEqual(43)
    expect(r.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(r.expiresAt).toBe(1000 + 300_000)
  })

  it('mints distinct requestId + userCode per request', () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now })
    const a = dc.request('A', '1')
    const b = dc.request('B', '1')
    expect(a.requestId).not.toBe(b.requestId)
    expect(a.userCode).not.toBe(b.userCode)
  })
})

describe('DeviceCodeService.poll', () => {
  it('returns expired for an unknown requestId (no existence leak)', () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    expect(dc.poll('nope')).toEqual({ status: 'expired' })
  })

  it('returns pending right after request', () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')
    expect(dc.poll(requestId)).toEqual({ status: 'pending' })
  })

  it('returns approved + token after approve', async () => {
    const { svc, calls } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('Motrix CLI', '1.0.0')

    await dc.approve(requestId)

    const res = dc.poll(requestId)
    expect(res.status).toBe('approved')
    expect(res.token).toBe('tok-1')
    // issueToken was called with a cli identity + the client name
    expect(calls).toHaveLength(1)
    expect(calls[0].identity.kind).toBe('cli')
    expect(calls[0].name).toBe('Motrix CLI')
    if (calls[0].identity.kind === 'cli') {
      expect(typeof calls[0].identity.id).toBe('string')
      expect(calls[0].identity.id.length).toBeGreaterThan(0)
    }
  })

  it('returns denied after deny', () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')
    dc.deny(requestId)
    expect(dc.poll(requestId)).toEqual({ status: 'denied' })
  })
})

describe('DeviceCodeService expiry', () => {
  it('flips a pending request to expired past its TTL', () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    const { requestId } = dc.request('A', '1')
    clock.advance(1001)
    expect(dc.poll(requestId)).toEqual({ status: 'expired' })
  })

  it('rejects approve on an expired request', async () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    const { requestId } = dc.request('A', '1')
    clock.advance(1001)
    await expect(dc.approve(requestId)).rejects.toThrow()
  })

  it('does not expire an already-approved request', async () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    const { requestId } = dc.request('A', '1')
    await dc.approve(requestId)
    clock.advance(10_000)
    const res = dc.poll(requestId)
    expect(res.status).toBe('approved')
    expect(res.token).toBe('tok-1')
  })

  it('delivers the approved token only once — a replayed poll gets nothing', async () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')
    await dc.approve(requestId)
    const first = dc.poll(requestId)
    expect(first).toEqual({ status: 'approved', token: 'tok-1' })
    // A leaked/replayed requestId cannot re-collect the token.
    expect(dc.poll(requestId)).toEqual({ status: 'expired' })
  })
})

describe('DeviceCodeService approve guards', () => {
  it('rejects approve on an unknown requestId', async () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    await expect(dc.approve('nope')).rejects.toThrow()
  })

  it('rejects approve after deny (not pending)', async () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')
    dc.deny(requestId)
    await expect(dc.approve(requestId)).rejects.toThrow()
  })

  it('rejects a second approve (no double token mint)', async () => {
    const { svc, calls } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')
    await dc.approve(requestId)
    await expect(dc.approve(requestId)).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
})

describe('DeviceCodeService stable device identity', () => {
  // A valid client handle: base64url, length within [16, 64].
  const HANDLE = 'ZGV2aWNlLWhhbmRsZS0xMjM0'

  it('uses a provided deviceId as the cli identity id', async () => {
    const { svc, calls } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('CLI', '1.0.0', HANDLE)
    await dc.approve(requestId)
    expect(calls[0].identity).toEqual({ kind: 'cli', id: HANDLE })
  })

  it('keeps one identity across re-requests with the same deviceId (so re-pair rotates)', async () => {
    const { svc, calls } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    await dc.approve(dc.request('CLI', '1', HANDLE).requestId)
    await dc.approve(dc.request('CLI', '1', HANDLE).requestId)
    expect(calls).toHaveLength(2)
    expect(calls[1].identity).toEqual(calls[0].identity)
    expect(calls[1].identity).toEqual({ kind: 'cli', id: HANDLE })
  })

  it('never adopts a reserved/too-short deviceId (e.g. "local") — mints instead', async () => {
    const { svc, calls } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    await dc.approve(dc.request('CLI', '1', 'local').requestId)
    const id = calls[0].identity
    expect(id.kind).toBe('cli')
    if (id.kind === 'cli') {
      expect(id.id).not.toBe('local')
      expect(id.id.length).toBeGreaterThanOrEqual(16)
    }
  })

  it('rejects a non-base64url deviceId and mints instead', async () => {
    const { svc, calls } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const bad = '!!!!!!!!!!!!!!!!!!!!' // 20 chars, invalid charset
    await dc.approve(dc.request('CLI', '1', bad).requestId)
    const id = calls[0].identity
    if (id.kind === 'cli') expect(id.id).not.toBe(bad)
  })

  it('mints a random id when no deviceId is provided (legacy callers)', async () => {
    const { svc, calls } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    await dc.approve(dc.request('CLI', '1').requestId)
    const id = calls[0].identity
    expect(id.kind).toBe('cli')
    if (id.kind === 'cli') expect(id.id.length).toBeGreaterThanOrEqual(16)
  })
})

describe('DeviceCodeService rate limit', () => {
  it('rejects requests over the window limit, then recovers after the window', () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, {
      now: clock.now,
      rateLimitMax: 3,
      rateLimitWindowMs: 60_000,
    })
    dc.request('A', '1')
    dc.request('B', '1')
    dc.request('C', '1')
    expect(() => dc.request('D', '1')).toThrow()
    // After the window slides, requests are allowed again.
    clock.advance(60_001)
    expect(() => dc.request('E', '1')).not.toThrow()
  })
})

describe('DeviceCodeService.listPending', () => {
  it('returns an empty array when nothing is pending', () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    expect(dc.listPending()).toEqual([])
  })

  it('returns token-free DTOs (with timestamps) for pending requests', () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 300_000 })
    const { requestId } = dc.request(
      'Motrix CLI',
      '1.0.0',
      'ZGV2aWNlLWhhbmRsZS0xMjM0'
    )
    const list = dc.listPending()
    expect(list).toEqual([
      {
        kind: 'cli',
        requestId,
        userCode: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
        clientName: 'Motrix CLI',
        clientVersion: '1.0.0',
        createdAt: 1000,
        expiresAt: 1000 + 300_000,
      },
    ])
    expect(list[0]).not.toHaveProperty('token')
    expect(list[0]).not.toHaveProperty('deviceId')
  })

  it('excludes expired requests even when pruneExpired has not run', () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    dc.request('A', '1')
    clock.advance(1001)
    // No further request() → pruneExpired never ran; effectiveStatus must still
    // exclude the lapsed entry.
    expect(dc.listPending()).toEqual([])
  })

  it('excludes approved and denied requests', async () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const a = dc.request('A', '1')
    const b = dc.request('B', '1')
    await dc.approve(a.requestId)
    dc.deny(b.requestId)
    expect(dc.listPending()).toEqual([])
  })
})

describe('DeviceCodeService pruneExpired claim guard', () => {
  it('does not sweep a claimed entry mid-mint even past its TTL', async () => {
    const clock = makeClock()
    const gate = deferred<void>()
    const svc = {
      issueToken: async (identity: ClientIdentity, name: string) => {
        await gate.promise
        return {
          identity,
          token: 'tok-1',
          name,
          pairedAt: 0,
          lastActiveAt: null,
        } as PairedClient
      },
    } as unknown as PairingService
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    const { requestId } = dc.request('A', '1')

    const p = dc.approve(requestId)
    // Cross the TTL while the mint is still in flight.
    clock.advance(1001)

    // Another client's request() runs pruneExpired — must not sweep the
    // claimed entry out from under the in-flight mint.
    dc.request('B', '1')
    expect(dc.poll(requestId)).toEqual({ status: 'pending' })

    gate.resolve()
    await p
    expect(dc.poll(requestId)).toEqual({ status: 'approved', token: 'tok-1' })
  })

  it('does not sweep an approved-but-uncollected entry past its TTL', async () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    const { requestId } = dc.request('A', '1')
    await dc.approve(requestId)

    clock.advance(1001)
    // Another client's request() runs pruneExpired — the approved entry is
    // still awaiting pickup and must not be swept.
    dc.request('B', '1')

    const res = dc.poll(requestId)
    expect(res.status).toBe('approved')
    expect(res.token).toBe('tok-1')
  })

  it('keeps a claimed entry that is still inside the pickup grace window', async () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    const { requestId } = dc.request('A', '1')
    await dc.approve(requestId)

    // Past the 1000ms TTL, but still inside the 60s pickup grace.
    clock.advance(1000 + 30_000)
    dc.request('B', '1') // runs pruneExpired

    const res = dc.poll(requestId)
    expect(res.status).toBe('approved')
    expect(res.token).toBe('tok-1')
  })

  it('sweeps a claimed entry once the pickup grace has elapsed — the token is no longer pollable', async () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    const { requestId } = dc.request('A', '1')
    await dc.approve(requestId)

    // Past the 1000ms TTL AND the 60s pickup grace.
    clock.advance(1000 + 60_000 + 1)
    dc.request('B', '1') // runs pruneExpired

    expect(dc.poll(requestId)).toEqual({ status: 'expired' })
  })
})

describe('DeviceCodeService atomic approve', () => {
  it('dedupes concurrent approvals into a single token mint', async () => {
    const gate = deferred<void>()
    let calls = 0
    const svc = {
      issueToken: async (identity: ClientIdentity, name: string) => {
        calls++
        await gate.promise
        return {
          identity,
          token: 'tok-1',
          name,
          pairedAt: 0,
          lastActiveAt: null,
        } as PairedClient
      },
    } as unknown as PairingService
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')

    const p1 = dc.approve(requestId)
    const p2 = dc.approve(requestId)
    // Second approve must NOT start a second mint while the first is in flight.
    expect(calls).toBe(1)

    gate.resolve()
    const [a, b] = await Promise.all([p1, p2])
    expect(calls).toBe(1)
    expect(a).toBe(b) // same PairedClient — deduped
    expect(dc.poll(requestId)).toEqual({ status: 'approved', token: 'tok-1' })
  })

  it('ignores a deny that races an in-flight approve', async () => {
    const gate = deferred<void>()
    const svc = {
      issueToken: async (identity: ClientIdentity, name: string) => {
        await gate.promise
        return {
          identity,
          token: 'tok-1',
          name,
          pairedAt: 0,
          lastActiveAt: null,
        } as PairedClient
      },
    } as unknown as PairingService
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')

    const p = dc.approve(requestId)
    dc.deny(requestId) // must be ignored — approve is mid-mint
    gate.resolve()
    await p
    expect(dc.poll(requestId)).toEqual({ status: 'approved', token: 'tok-1' })
  })
})

describe('DeviceCodeService lifecycle push', () => {
  /** Collects onLifecycle calls into plain arrays for assertion. */
  function makeLifecycle() {
    const settled: Array<{ requestId: string; outcome: 'allowed' | 'denied' }> =
      []
    const expired: Array<{ requestId: string }> = []
    return {
      onLifecycle: {
        settled: (requestId: string, outcome: 'allowed' | 'denied') =>
          settled.push({ requestId, outcome }),
        expired: (requestId: string) => expired.push({ requestId }),
      },
      settled,
      expired,
    }
  }

  it('fires expired exactly once via the TTL timer for a still-pending request', () => {
    vi.useFakeTimers()
    try {
      const { svc } = makeFakePairing()
      const { onLifecycle, settled, expired } = makeLifecycle()
      const dc = new DeviceCodeService(svc, {
        now: makeClock().now,
        ttlMs: 1000,
        onLifecycle,
      })
      const { requestId } = dc.request('A', '1')

      vi.advanceTimersByTime(1000)
      expect(expired).toEqual([{ requestId }])

      // The timer is one-shot — further elapsed time must not re-fire it.
      vi.advanceTimersByTime(60_000)
      expect(expired).toEqual([{ requestId }])
      expect(settled).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('approve fires settled(allowed) and suppresses the later expiry timer', async () => {
    vi.useFakeTimers()
    try {
      const { svc } = makeFakePairing()
      const { onLifecycle, settled, expired } = makeLifecycle()
      const dc = new DeviceCodeService(svc, {
        now: makeClock().now,
        ttlMs: 1000,
        onLifecycle,
      })
      const { requestId } = dc.request('A', '1')

      await dc.approve(requestId)
      expect(settled).toEqual([{ requestId, outcome: 'allowed' }])

      // Past the original TTL, the (suppressed) timer must not also fire expired.
      vi.advanceTimersByTime(60_000)
      expect(settled).toEqual([{ requestId, outcome: 'allowed' }])
      expect(expired).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('deny fires settled(denied) and suppresses the later expiry timer', () => {
    vi.useFakeTimers()
    try {
      const { svc } = makeFakePairing()
      const { onLifecycle, settled, expired } = makeLifecycle()
      const dc = new DeviceCodeService(svc, {
        now: makeClock().now,
        ttlMs: 1000,
        onLifecycle,
      })
      const { requestId } = dc.request('A', '1')

      dc.deny(requestId)
      expect(settled).toEqual([{ requestId, outcome: 'denied' }])

      vi.advanceTimersByTime(60_000)
      expect(settled).toEqual([{ requestId, outcome: 'denied' }])
      expect(expired).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('poll-token delivery clears the timer without firing any further lifecycle event', async () => {
    vi.useFakeTimers()
    try {
      const { svc } = makeFakePairing()
      const { onLifecycle, settled, expired } = makeLifecycle()
      const dc = new DeviceCodeService(svc, {
        now: makeClock().now,
        ttlMs: 1000,
        onLifecycle,
      })
      const { requestId } = dc.request('A', '1')

      await dc.approve(requestId)
      settled.length = 0 // this test is about poll-delivery, not approve's own settle

      const res = dc.poll(requestId)
      expect(res).toEqual({ status: 'approved', token: 'tok-1' })

      vi.advanceTimersByTime(60_000)
      expect(settled).toEqual([])
      expect(expired).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('Fix 6: dispose fires expired once per still-pending request, and its cleared timers never fire again', () => {
    vi.useFakeTimers()
    try {
      const { svc } = makeFakePairing()
      const { onLifecycle, expired } = makeLifecycle()
      const dc = new DeviceCodeService(svc, {
        now: makeClock().now,
        ttlMs: 1000,
        onLifecycle,
      })
      const a = dc.request('A', '1')
      const b = dc.request('B', '1')

      dc.dispose()
      expect(expired.map((e) => e.requestId).sort()).toEqual(
        [a.requestId, b.requestId].sort()
      )
      expect(dc.poll(a.requestId)).toEqual({ status: 'expired' })

      expired.length = 0
      vi.advanceTimersByTime(60_000)
      // The (already-cleared) timers must not double-fire.
      expect(expired).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('Fix 6: dispose does not re-emit for a request that already settled', async () => {
    vi.useFakeTimers()
    try {
      const { svc } = makeFakePairing()
      const { onLifecycle, expired, settled } = makeLifecycle()
      const dc = new DeviceCodeService(svc, {
        now: makeClock().now,
        ttlMs: 1000,
        onLifecycle,
      })
      const approved = dc.request('A', '1')
      const denied = dc.request('B', '1')
      await dc.approve(approved.requestId)
      dc.deny(denied.requestId)
      settled.length = 0 // this test is about dispose, not the settles above

      dc.dispose()

      expect(expired).toEqual([])
      expect(settled).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('Fix 4: a lazy check (listPending) that discovers a lapsed entry before the real timer fires still pushes expired exactly once', () => {
    vi.useFakeTimers()
    try {
      const clock = makeClock()
      const { svc } = makeFakePairing()
      const { onLifecycle, expired } = makeLifecycle()
      const dc = new DeviceCodeService(svc, {
        now: clock.now,
        ttlMs: 1000,
        onLifecycle,
      })
      const { requestId } = dc.request('A', '1')

      // Cross the TTL boundary on the injected clock without letting the
      // real timer's macrotask run yet.
      clock.advance(1001)
      expect(dc.listPending()).toEqual([])
      expect(expired).toEqual([{ requestId }])

      // The real timer eventually fires too — must be a no-op, not a
      // second push.
      vi.advanceTimersByTime(1000)
      expect(expired).toEqual([{ requestId }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('Fix 5: a failed mint re-arms the TTL timer so the request still expires (and stays retry-able until then)', async () => {
    vi.useFakeTimers()
    try {
      const clock = makeClock()
      const svc = {
        issueToken: async () => {
          throw new Error('mint failed')
        },
      } as unknown as PairingService
      const { onLifecycle, expired, settled } = makeLifecycle()
      const dc = new DeviceCodeService(svc, {
        now: clock.now,
        ttlMs: 1000,
        onLifecycle,
      })
      const { requestId } = dc.request('A', '1')

      await expect(dc.approve(requestId)).rejects.toThrow('mint failed')
      // Still pending — a later approve can retry.
      expect(dc.poll(requestId)).toEqual({ status: 'pending' })
      expect(expired).toEqual([])

      vi.advanceTimersByTime(1000)
      expect(expired).toEqual([{ requestId }])
      expect(settled).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('Fix 1: approve claims the terminal transition atomically — a poll racing past TTL mid-mint sees pending, then approved', async () => {
    const clock = makeClock()
    const gate = deferred<void>()
    const svc = {
      issueToken: async (identity: ClientIdentity, name: string) => {
        await gate.promise
        return {
          identity,
          token: 'tok-1',
          name,
          pairedAt: 0,
          lastActiveAt: null,
        } as PairedClient
      },
    } as unknown as PairingService
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    const { requestId } = dc.request('A', '1')

    const p = dc.approve(requestId)
    // Cross the TTL well before the mint resolves.
    clock.advance(1001)
    expect(dc.poll(requestId)).toEqual({ status: 'pending' })
    expect(dc.listPending()).toEqual([expect.objectContaining({ requestId })])

    gate.resolve()
    await p
    expect(dc.poll(requestId)).toEqual({ status: 'approved', token: 'tok-1' })
  })
})

describe('DeviceCodeService.deny return value', () => {
  it('returns true when a pending request is actually denied', () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')
    expect(dc.deny(requestId)).toBe(true)
  })

  it('returns false for an unknown requestId', () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    expect(dc.deny('nope')).toBe(false)
  })

  it('returns false for an already-expired request', () => {
    const clock = makeClock()
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: clock.now, ttlMs: 1000 })
    const { requestId } = dc.request('A', '1')
    clock.advance(1001)
    expect(dc.deny(requestId)).toBe(false)
  })

  it('returns false while an approve is in flight for the same request', async () => {
    const gate = deferred<void>()
    const svc = {
      issueToken: async (identity: ClientIdentity, name: string) => {
        await gate.promise
        return {
          identity,
          token: 'tok-1',
          name,
          pairedAt: 0,
          lastActiveAt: null,
        } as PairedClient
      },
    } as unknown as PairingService
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')

    const p = dc.approve(requestId)
    expect(dc.deny(requestId)).toBe(false)
    gate.resolve()
    await p
  })

  it('returns false on a second (repeat) deny', () => {
    const { svc } = makeFakePairing()
    const dc = new DeviceCodeService(svc, { now: makeClock().now })
    const { requestId } = dc.request('A', '1')
    expect(dc.deny(requestId)).toBe(true)
    expect(dc.deny(requestId)).toBe(false)
  })
})
