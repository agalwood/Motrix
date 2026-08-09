import { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import { pairRequestKey } from '@shared/protocol/bridge'
import { describe, expect, it, vi } from 'vitest'
import { PairingDialogController } from './pairing-dialog-controller'

const ARGS = {
  browser: 'chromium' as const,
  extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  extensionName: 'x',
  extensionVersion: '1',
}

function makeController() {
  const bus = new BridgeEventBus()
  const emitted: unknown[] = []
  const settled: unknown[] = []
  const expired: unknown[] = []
  bus.on('PairRequested', (p) => emitted.push(p))
  bus.on('PairRequestSettled', (p) => settled.push(p))
  bus.on('PairRequestExpired', (p) => expired.push(p))
  const ctrl = new PairingDialogController(bus, () => null)
  return { ctrl, bus, emitted, settled, expired }
}

describe('PairingDialogController dedup', () => {
  it('emits PairRequested once for two rapid requests with same browser+id', () => {
    vi.useFakeTimers()
    const { ctrl, emitted } = makeController()
    void ctrl.requestDecision(
      {
        browser: 'chromium',
        extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        extensionName: 'x',
        extensionVersion: '1',
      },
      'nonce-1'
    )
    void ctrl.requestDecision(
      {
        browser: 'chromium',
        extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        extensionName: 'x',
        extensionVersion: '1',
      },
      'nonce-2'
    )
    expect(emitted).toHaveLength(1)
    vi.useRealTimers()
  })

  it('emits again after 60s window expires', () => {
    vi.useFakeTimers()
    const { ctrl, emitted } = makeController()
    void ctrl.requestDecision(
      {
        browser: 'chromium',
        extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        extensionName: 'x',
        extensionVersion: '1',
      },
      'nonce-1'
    )
    vi.advanceTimersByTime(60_001)
    void ctrl.requestDecision(
      {
        browser: 'chromium',
        extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        extensionName: 'x',
        extensionVersion: '1',
      },
      'nonce-2'
    )
    expect(emitted).toHaveLength(2)
    vi.useRealTimers()
  })

  it('clears dedup after an explicit allow so a forget+re-pair within 60s is not silently denied', async () => {
    // Regression: a user who forgets the pair token on the extension side
    // and immediately retriggers /pair was hitting the anti-spam window
    // and getting an automatic deny with no dialog. Once trust has been
    // established by an explicit allow, the dedup must reset.
    const { ctrl, emitted } = makeController()
    const args = {
      browser: 'chromium' as const,
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      extensionName: 'x',
      extensionVersion: '1',
    }
    const first = ctrl.requestDecision(args, 'nonce-1')
    ctrl.settle({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: args.extensionId,
      browser: 'chromium',
      decision: 'allow',
      addToRegistry: false,
    })
    const firstDecision = await first
    expect(firstDecision.decision).toBe('allow')

    // Immediately re-request (well within the 60s window). Should NOT
    // be auto-denied — should emit a fresh PairRequested instead.
    const second = ctrl.requestDecision(args, 'nonce-2')
    ctrl.settle({
      kind: 'extension',
      pairingNonce: 'nonce-2',
      extensionId: args.extensionId,
      browser: 'chromium',
      decision: 'allow',
      addToRegistry: false,
    })
    const secondDecision = await second
    expect(secondDecision.decision).toBe('allow')
    expect(emitted).toHaveLength(2)
  })

  it('keeps dedup after an explicit deny so a denying user is not re-prompted within 60s', async () => {
    // Anti-spam invariant: deny path is what the dedup protects against.
    // Re-requesting within 60s of a deny must still be auto-denied without
    // emitting a new PairRequested event.
    const { ctrl, emitted } = makeController()
    const args = {
      browser: 'chromium' as const,
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      extensionName: 'x',
      extensionVersion: '1',
    }
    const first = ctrl.requestDecision(args, 'nonce-1')
    ctrl.settle({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: args.extensionId,
      browser: 'chromium',
      decision: 'deny',
      addToRegistry: false,
    })
    await first

    // Second request within the dedup window — must be silently denied.
    const second = await ctrl.requestDecision(args, 'nonce-2')
    expect(second.decision).toBe('deny')
    expect(emitted).toHaveLength(1) // no new PairRequested emitted
  })

  it('denies and settles pending prompts during bridge shutdown', async () => {
    const { ctrl } = makeController()
    const pending = ctrl.requestDecision(
      {
        browser: 'chromium',
        extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        extensionName: 'x',
        extensionVersion: '1',
      },
      'nonce-shutdown'
    )

    ctrl.dispose()

    await expect(pending).resolves.toEqual({
      decision: 'deny',
      addToRegistry: false,
    })
  })
})

describe('PairingDialogController pending registry lifecycle', () => {
  it('timeout emits PairRequestExpired with the right key AND still resolves deny', async () => {
    vi.useFakeTimers()
    const { ctrl, expired } = makeController()
    const key = pairRequestKey({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
    })
    const pending = ctrl.requestDecision(ARGS, 'nonce-1')

    vi.advanceTimersByTime(60_001)

    await expect(pending).resolves.toEqual({
      decision: 'deny',
      addToRegistry: false,
    })
    expect(expired).toEqual([{ key }])
    vi.useRealTimers()
  })

  it('explicit allow settle emits PairRequestSettled with outcome allowed', async () => {
    const { ctrl, settled } = makeController()
    const key = pairRequestKey({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
    })
    const pending = ctrl.requestDecision(ARGS, 'nonce-1')

    const result = ctrl.settle({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
      decision: 'allow',
      addToRegistry: false,
    })

    expect(result).toEqual({ ok: true })
    await expect(pending).resolves.toEqual({
      decision: 'allow',
      addToRegistry: false,
    })
    expect(settled).toEqual([{ key, outcome: 'allowed' }])
  })

  it('explicit deny settle emits PairRequestSettled with outcome denied', async () => {
    const { ctrl, settled } = makeController()
    const key = pairRequestKey({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
    })
    const pending = ctrl.requestDecision(ARGS, 'nonce-1')

    const result = ctrl.settle({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
      decision: 'deny',
      addToRegistry: false,
    })

    expect(result).toEqual({ ok: true })
    await expect(pending).resolves.toEqual({
      decision: 'deny',
      addToRegistry: false,
    })
    expect(settled).toEqual([{ key, outcome: 'denied' }])
  })

  it('late settle after timeout returns unavailable and emits nothing', async () => {
    vi.useFakeTimers()
    const { ctrl, settled } = makeController()
    const pending = ctrl.requestDecision(ARGS, 'nonce-1')
    vi.advanceTimersByTime(60_001)
    await pending
    settled.length = 0 // drop the expiry's own settled-count baseline (none expected)

    const result = ctrl.settle({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
      decision: 'allow',
      addToRegistry: false,
    })

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(settled).toHaveLength(0)
    vi.useRealTimers()
  })

  it('settle on an unknown key returns unavailable and emits nothing', () => {
    const { ctrl, settled, expired } = makeController()

    const result = ctrl.settle({
      kind: 'extension',
      pairingNonce: 'never-requested',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
      decision: 'allow',
      addToRegistry: false,
    })

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(settled).toHaveLength(0)
    expect(expired).toHaveLength(0)
  })

  it('duplicate settle is a no-op returning unavailable', async () => {
    const { ctrl, settled } = makeController()
    const pending = ctrl.requestDecision(ARGS, 'nonce-1')

    const first = ctrl.settle({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
      decision: 'allow',
      addToRegistry: false,
    })
    const second = ctrl.settle({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
      decision: 'allow',
      addToRegistry: false,
    })

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: false, reason: 'unavailable' })
    expect(settled).toHaveLength(1)
    await pending
  })

  it('listPending() reflects add/settle/expire', async () => {
    vi.useFakeTimers()
    const { ctrl } = makeController()

    expect(ctrl.listPending()).toEqual([])

    const pending1 = ctrl.requestDecision(ARGS, 'nonce-1')
    const list1 = ctrl.listPending()
    expect(list1).toHaveLength(1)
    expect(list1[0]).toMatchObject({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      extensionName: ARGS.extensionName,
      extensionVersion: ARGS.extensionVersion,
      browser: ARGS.browser,
    })
    expect(list1[0]?.createdAt).toBeTypeOf('number')
    expect(list1[0]?.expiresAt).toBe((list1[0]?.createdAt ?? 0) + 60_000)

    ctrl.settle({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
      decision: 'allow',
      addToRegistry: false,
    })
    await pending1
    expect(ctrl.listPending()).toEqual([])

    // A second, distinct extension so the dedup window on the same id doesn't
    // suppress this entry.
    const otherArgs = {
      ...ARGS,
      extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }
    const pending2 = ctrl.requestDecision(otherArgs, 'nonce-2')
    expect(ctrl.listPending()).toHaveLength(1)

    vi.advanceTimersByTime(60_001)
    await pending2
    expect(ctrl.listPending()).toEqual([])
    vi.useRealTimers()
  })

  it('dispose() sweep emits PairRequestExpired per remaining entry', async () => {
    const { ctrl, expired } = makeController()
    const otherArgs = {
      ...ARGS,
      extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }
    const key1 = pairRequestKey({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: ARGS.extensionId,
      browser: ARGS.browser,
    })
    const key2 = pairRequestKey({
      kind: 'extension',
      pairingNonce: 'nonce-2',
      extensionId: otherArgs.extensionId,
      browser: otherArgs.browser,
    })
    const pending1 = ctrl.requestDecision(ARGS, 'nonce-1')
    const pending2 = ctrl.requestDecision(otherArgs, 'nonce-2')

    ctrl.dispose()

    await Promise.all([pending1, pending2])
    expect(expired).toHaveLength(2)
    expect(expired.map((e) => (e as { key: string }).key).sort()).toEqual(
      [key1, key2].sort()
    )
    expect(ctrl.listPending()).toEqual([])
  })
})
