import type { PairDialogRequest } from '@core/bridge/mbp1/pair-session'
import type { PairingPromptTimeSource } from '@core/bridge/pairing-prompt-controller'
import { pairRequestKey } from '@shared/protocol/bridge'
import { describe, expect, it, vi } from 'vitest'
import { BridgeEventBus } from '../../core/bridge/bridge-event-bus'
import { ServerExtensionPairingPromptAdapter } from './extension-pairing-prompt-adapter'

const REQUEST: PairDialogRequest = {
  browser: 'chromium',
  verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  claimedExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  identity: 'official',
  pairingNonce: 'nonce-a',
  code: 'ABCD-EFGH',
}

function fakeTime(start = 1_700_000_000_000): {
  source: PairingPromptTimeSource
  advance(ms: number): void
} {
  let now = start
  let scheduled: (() => void) | null = null
  return {
    source: {
      now: () => now,
      schedule: (callback) => {
        scheduled = callback
        return () => {
          scheduled = null
        }
      },
    },
    advance(ms) {
      now += ms
      const callback = scheduled
      scheduled = null
      callback?.()
    },
  }
}

describe('ServerExtensionPairingPromptAdapter', () => {
  it('publishes the code synchronously and exposes the same pending snapshot', async () => {
    const bus = new BridgeEventBus()
    const requested = vi.fn()
    bus.on('PairRequested', requested)
    const adapter = new ServerExtensionPairingPromptAdapter(bus, {
      publicAuthority: 'motrix.example',
    })

    const queued = adapter.queueMbp1Prompt(REQUEST)
    expect(queued.ok).toBe(true)
    if (!queued.ok) return
    await expect(queued.handle.published).resolves.toBe('delivered')
    expect(requested).toHaveBeenCalledExactlyOnceWith({
      kind: 'extension',
      pairingNonce: 'nonce-a',
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      browser: 'chromium',
      identity: 'official',
      code: 'ABCD-EFGH',
      verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      originHost: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      claimedExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      attestationClass: 'official',
      publicAuthority: 'motrix.example',
    })
    expect(adapter.listPending()).toEqual([
      expect.objectContaining({
        code: 'ABCD-EFGH',
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
      }),
    ])

    await adapter.dispose()
  })

  it('maps an operator dismissal to one code-free denied terminal event', async () => {
    const bus = new BridgeEventBus()
    const settled = vi.fn()
    bus.on('PairRequestSettled', settled)
    const adapter = new ServerExtensionPairingPromptAdapter(bus)
    const queued = adapter.queueMbp1Prompt(REQUEST)
    expect(queued.ok).toBe(true)
    if (!queued.ok) return

    expect(
      adapter.settle({
        kind: 'extension',
        browser: REQUEST.browser,
        extensionId: REQUEST.claimedExtensionId,
        pairingNonce: REQUEST.pairingNonce,
      })
    ).toEqual({ ok: true })
    await expect(queued.handle.terminal).resolves.toBe('denied')
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      key: pairRequestKey({
        kind: 'extension',
        browser: REQUEST.browser,
        extensionId: REQUEST.claimedExtensionId,
        pairingNonce: REQUEST.pairingNonce,
      }),
      outcome: 'denied',
    })
    expect(JSON.stringify(settled.mock.calls)).not.toContain(REQUEST.code)
    expect(adapter.listPending()).toEqual([])
    expect(
      adapter.settle({
        kind: 'extension',
        browser: REQUEST.browser,
        extensionId: REQUEST.claimedExtensionId,
        pairingNonce: REQUEST.pairingNonce,
      })
    ).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('expires without placing the code in the terminal event', async () => {
    const clock = fakeTime()
    const bus = new BridgeEventBus()
    const expired = vi.fn()
    bus.on('PairRequestExpired', expired)
    const adapter = new ServerExtensionPairingPromptAdapter(bus, {
      ttlMs: 1_000,
      timeSource: clock.source,
    })
    const queued = adapter.queueMbp1Prompt(REQUEST)
    expect(queued.ok).toBe(true)
    if (!queued.ok) return

    clock.advance(1_000)
    await expect(queued.handle.terminal).resolves.toBe('expired')
    expect(expired).toHaveBeenCalledOnce()
    expect(JSON.stringify(expired.mock.calls)).not.toContain(REQUEST.code)
    expect(adapter.listPending()).toEqual([])
  })

  it('classifies a throwing operator publisher as failed', async () => {
    const bus = new BridgeEventBus()
    bus.on('PairRequested', () => {
      throw new Error('secret delivery path')
    })
    const adapter = new ServerExtensionPairingPromptAdapter(bus)
    const queued = adapter.queueMbp1Prompt(REQUEST)
    expect(queued.ok).toBe(true)
    if (!queued.ok) return

    await expect(queued.handle.published).resolves.toBe('failed')
    expect(adapter.listPending()).toHaveLength(1)
    await adapter.dispose()
    await expect(queued.handle.terminal).resolves.toBe('aborted')
  })
})
