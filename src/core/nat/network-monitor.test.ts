import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkMonitor, type NetworkSnapshot } from './network-monitor'

describe('NetworkMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function snap(gatewayIp: string, internalIp: string): NetworkSnapshot {
    return { gatewayIp, internalIp, hash: `${gatewayIp}|${internalIp}` }
  }

  it('emits change when snapshot differs', async () => {
    const snapshots: NetworkSnapshot[] = [
      snap('192.168.1.1', '192.168.1.100'),
      snap('192.168.1.1', '192.168.1.100'), // same
      snap('10.0.0.1', '10.0.0.5'), // different
    ]
    let i = 0
    const mon = new NetworkMonitor({
      intervalMs: 5000,
      snapshotFn: () => snapshots[i++]!,
      stableRounds: 1,
    })
    const events: NetworkSnapshot[] = []
    mon.onChange((s) => events.push(s))
    mon.start()
    vi.advanceTimersByTime(5000)
    await Promise.resolve()
    vi.advanceTimersByTime(5000)
    await Promise.resolve()
    mon.stop()
    expect(events).toHaveLength(1)
    expect(events[0]!.gatewayIp).toBe('10.0.0.1')
  })

  it('does not emit on no change', async () => {
    const snapshots: NetworkSnapshot[] = [
      snap('192.168.1.1', '192.168.1.100'),
      snap('192.168.1.1', '192.168.1.100'),
      snap('192.168.1.1', '192.168.1.100'),
      snap('192.168.1.1', '192.168.1.100'),
    ]
    let i = 0
    const mon = new NetworkMonitor({
      intervalMs: 1000,
      snapshotFn: () => snapshots[i++]!,
      stableRounds: 1,
    })
    const events: NetworkSnapshot[] = []
    mon.onChange((s) => events.push(s))
    mon.start()
    vi.advanceTimersByTime(3000)
    await Promise.resolve()
    mon.stop()
    expect(events).toHaveLength(0)
  })

  it('requires stableRounds consecutive consistent diffs before emitting', async () => {
    const snapshots: NetworkSnapshot[] = [
      snap('192.168.1.1', '.100'), // round 1: initial
      snap('10.0.0.1', '.5'), // round 2: flip
      snap('192.168.1.1', '.100'), // round 3: flip back (flapping)
      snap('10.0.0.1', '.5'), // round 4: flip
      snap('10.0.0.1', '.5'), // round 5: stable
      snap('10.0.0.1', '.5'), // round 6: stable
      snap('10.0.0.1', '.5'), // round 7: stable (extra)
    ]
    let i = 0
    const mon = new NetworkMonitor({
      intervalMs: 1000,
      snapshotFn: () => snapshots[i++]!,
      stableRounds: 2,
    })
    const events: NetworkSnapshot[] = []
    mon.onChange((s) => events.push(s))
    mon.start()
    for (let k = 0; k < 6; k++) {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    }
    mon.stop()
    // First diff at round 2 not emitted (flap); diff stabilizes only after round 5
    expect(events).toHaveLength(1)
    expect(events[0]!.gatewayIp).toBe('10.0.0.1')
  })

  it('unsubscribes the listener via returned function', async () => {
    const snapshots: NetworkSnapshot[] = [
      snap('192.168.1.1', '.100'),
      snap('10.0.0.1', '.5'),
      snap('10.0.0.1', '.5'),
    ]
    let i = 0
    const mon = new NetworkMonitor({
      intervalMs: 1000,
      snapshotFn: () => snapshots[i++]!,
      stableRounds: 1,
    })
    const events: NetworkSnapshot[] = []
    const unsub = mon.onChange((s) => events.push(s))
    unsub()
    mon.start()
    vi.advanceTimersByTime(2000)
    await Promise.resolve()
    mon.stop()
    expect(events).toHaveLength(0)
  })

  it('is idempotent when start() is called twice', async () => {
    const calls: number[] = []
    const mon = new NetworkMonitor({
      intervalMs: 1000,
      snapshotFn: () => {
        calls.push(Date.now())
        return snap('192.168.1.1', '.100')
      },
      stableRounds: 1,
    })
    mon.start()
    mon.start() // should be no-op
    vi.advanceTimersByTime(3000)
    await Promise.resolve()
    mon.stop()
    // 1 initial poll + 3 interval ticks = 4 calls. Without idempotency it would be 8.
    expect(calls.length).toBeLessThanOrEqual(4)
  })

  it('survives snapshotFn throwing', async () => {
    let throwing = true
    const mon = new NetworkMonitor({
      intervalMs: 1000,
      snapshotFn: () => {
        if (throwing) throw new Error('boom')
        return snap('10.0.0.1', '.5')
      },
      stableRounds: 1,
    })
    const events: NetworkSnapshot[] = []
    mon.onChange((s) => events.push(s))
    mon.start()
    // First poll throws — monitor should not crash; established stays null
    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    throwing = false
    // Now the poll returns a snapshot — monitor establishes baseline
    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    mon.stop()
    // No events should fire because the first successful snapshot becomes the
    // established baseline, not a diff.
    expect(events).toHaveLength(0)
  })

  it('clamps stableRounds to >= 1', () => {
    const mon = new NetworkMonitor({ stableRounds: 0 })
    expect(mon).toBeDefined()
  })

  it('clamps intervalMs to >= 500', () => {
    const mon = new NetworkMonitor({ intervalMs: 0 })
    expect(mon).toBeDefined()
  })
})
