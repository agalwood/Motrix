import { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type { PairDialogRequest } from '@core/bridge/mbp1/pair-session'
import { pairRequestKey } from '@shared/protocol/bridge'
import { describe, expect, it, vi } from 'vitest'
import { PairingDialogController } from './pairing-dialog-controller'

const REQ: PairDialogRequest = {
  browser: 'chromium',
  claimedExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  identity: 'official',
  code: '1234-5678',
  pairingNonce: 'nonce-1',
  verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}

function makeController() {
  const bus = new BridgeEventBus()
  const requested: unknown[] = []
  const settled: unknown[] = []
  const expired: unknown[] = []
  bus.on('PairRequested', (p) => requested.push(p))
  bus.on('PairRequestSettled', (p) => settled.push(p))
  bus.on('PairRequestExpired', (p) => expired.push(p))
  const ctrl = new PairingDialogController(bus, () => null)
  return { ctrl, bus, requested, settled, expired }
}

describe('PairingDialogController.queueMbp1Prompt', () => {
  it('emits PairRequested with the code+identity payload and no self-reported name', () => {
    const { ctrl, requested } = makeController()

    ctrl.queueMbp1Prompt(REQ)

    expect(requested).toEqual([
      {
        kind: 'extension',
        pairingNonce: REQ.pairingNonce,
        extensionId: REQ.claimedExtensionId,
        browser: REQ.browser,
        identity: REQ.identity,
        code: REQ.code,
      },
    ])
  })

  it('returns a handle whose dismissed resolves when the session confirms and closes it', async () => {
    const { ctrl } = makeController()
    const handle = ctrl.queueMbp1Prompt(REQ)
    let resolved = false
    void handle.dismissed.then(() => {
      resolved = true
    })

    expect(resolved).toBe(false)
    handle.close()
    await handle.dismissed

    expect(resolved).toBe(true)
  })

  it('close() is idempotent — a second call is a no-op', async () => {
    const { ctrl, expired } = makeController()
    const handle = ctrl.queueMbp1Prompt(REQ)

    handle.close()
    handle.close()
    await handle.dismissed

    expect(expired).toHaveLength(1)
  })

  it('close() emits PairRequestExpired, never PairRequestSettled — a machine-side teardown is not a user denial', async () => {
    const { ctrl, settled, expired } = makeController()
    const handle = ctrl.queueMbp1Prompt(REQ)
    const key = pairRequestKey({
      kind: 'extension',
      pairingNonce: REQ.pairingNonce,
      extensionId: REQ.claimedExtensionId,
      browser: REQ.browser,
    })

    handle.close()
    await handle.dismissed

    expect(expired).toEqual([{ key }])
    expect(settled).toHaveLength(0)
  })

  it('auto-closes after the 120s code lifetime and emits PairRequestExpired', async () => {
    vi.useFakeTimers()
    const { ctrl, expired } = makeController()
    const handle = ctrl.queueMbp1Prompt(REQ)
    let resolved = false
    void handle.dismissed.then(() => {
      resolved = true
    })

    vi.advanceTimersByTime(119_999)
    expect(resolved).toBe(false)
    vi.advanceTimersByTime(2)
    await Promise.resolve()

    expect(resolved).toBe(true)
    expect(expired).toHaveLength(1)
    vi.useRealTimers()
  })

  it('dedups on the verified origin — a second attempt while one is live returns an already-dismissed handle and emits nothing new', () => {
    const { ctrl, requested } = makeController()
    ctrl.queueMbp1Prompt(REQ)

    const second = ctrl.queueMbp1Prompt({ ...REQ, pairingNonce: 'nonce-2' })

    expect(requested).toHaveLength(1)
    return expect(second.dismissed).resolves.toBeUndefined()
  })

  it('never suppresses one extension by another claiming its id — dedup is NOT keyed on claimedExtensionId', () => {
    // Regression: on Firefox the claimed id is self-reported, so keying dedup
    // on it would let an attacker extension suppress a legitimate one simply
    // by claiming the same id. Two different verified origins claiming the
    // SAME id must both get a live prompt.
    const { ctrl, requested } = makeController()
    ctrl.queueMbp1Prompt({
      ...REQ,
      browser: 'firefox',
      verifiedOrigin: 'moz-extension://11111111-1111-1111-1111-111111111111',
    })

    ctrl.queueMbp1Prompt({
      ...REQ,
      browser: 'firefox',
      pairingNonce: 'nonce-2',
      verifiedOrigin: 'moz-extension://22222222-2222-2222-2222-222222222222',
    })

    expect(requested).toHaveLength(2)
  })

  it('clears dedup once the live prompt settles by any outcome, admitting a fresh attempt from the same origin', async () => {
    const { ctrl, requested } = makeController()
    const first = ctrl.queueMbp1Prompt(REQ)

    first.close()
    await first.dismissed

    const second = ctrl.queueMbp1Prompt({ ...REQ, pairingNonce: 'nonce-2' })

    expect(requested).toHaveLength(2)
    expect(second.dismissed).not.toBe(first.dismissed)
  })
})

describe('PairingDialogController.settle', () => {
  it('resolves the pending handle (dismiss), removes it from pending, and emits PairRequestExpired', async () => {
    const { ctrl, expired } = makeController()
    const handle = ctrl.queueMbp1Prompt(REQ)
    let resolved = false
    void handle.dismissed.then(() => {
      resolved = true
    })

    const result = ctrl.settle({
      kind: 'extension',
      pairingNonce: REQ.pairingNonce,
      extensionId: REQ.claimedExtensionId,
      browser: REQ.browser,
    })

    expect(result).toEqual({ ok: true })
    await handle.dismissed
    expect(resolved).toBe(true)
    expect(expired).toHaveLength(1)
    expect(ctrl.listPending()).toEqual([])
  })

  it('returns unavailable for an unknown key and emits nothing', () => {
    const { ctrl, expired } = makeController()

    const result = ctrl.settle({
      kind: 'extension',
      pairingNonce: 'never-requested',
      extensionId: REQ.claimedExtensionId,
      browser: REQ.browser,
    })

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(expired).toHaveLength(0)
  })

  it('duplicate settle is a no-op returning unavailable', () => {
    const { ctrl } = makeController()
    ctrl.queueMbp1Prompt(REQ)
    const params = {
      kind: 'extension' as const,
      pairingNonce: REQ.pairingNonce,
      extensionId: REQ.claimedExtensionId,
      browser: REQ.browser,
    }

    const first = ctrl.settle(params)
    const second = ctrl.settle(params)

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('re-admits the origin so a re-pair attempt after a user dismiss is not silently suppressed', () => {
    const { ctrl, requested } = makeController()
    ctrl.queueMbp1Prompt(REQ)
    ctrl.settle({
      kind: 'extension',
      pairingNonce: REQ.pairingNonce,
      extensionId: REQ.claimedExtensionId,
      browser: REQ.browser,
    })

    ctrl.queueMbp1Prompt({ ...REQ, pairingNonce: 'nonce-2' })

    expect(requested).toHaveLength(2)
  })
})

describe('PairingDialogController.listPending', () => {
  it('reflects add/settle, carrying the pairing code and identity', () => {
    vi.useFakeTimers()
    const { ctrl } = makeController()

    expect(ctrl.listPending()).toEqual([])

    ctrl.queueMbp1Prompt(REQ)
    const list = ctrl.listPending()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      kind: 'extension',
      pairingNonce: REQ.pairingNonce,
      extensionId: REQ.claimedExtensionId,
      browser: REQ.browser,
      identity: REQ.identity,
      code: REQ.code,
    })
    expect(list[0]?.createdAt).toBeTypeOf('number')
    expect(list[0]?.expiresAt).toBe((list[0]?.createdAt ?? 0) + 120_000)

    ctrl.settle({
      kind: 'extension',
      pairingNonce: REQ.pairingNonce,
      extensionId: REQ.claimedExtensionId,
      browser: REQ.browser,
    })
    expect(ctrl.listPending()).toEqual([])
    vi.useRealTimers()
  })
})

describe('PairingDialogController.dispose', () => {
  it('settles every pending dismissed and emits PairRequestExpired per entry, so a blocked session cannot await forever across a restart', async () => {
    const { ctrl, expired } = makeController()
    const other: PairDialogRequest = {
      ...REQ,
      claimedExtensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pairingNonce: 'nonce-2',
      verifiedOrigin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }
    const h1 = ctrl.queueMbp1Prompt(REQ)
    const h2 = ctrl.queueMbp1Prompt(other)

    ctrl.dispose()

    await Promise.all([h1.dismissed, h2.dismissed])
    expect(expired).toHaveLength(2)
    expect(ctrl.listPending()).toEqual([])
  })

  it('dispose() is safe with no pending prompts', () => {
    const { ctrl } = makeController()
    expect(() => ctrl.dispose()).not.toThrow()
  })
})
