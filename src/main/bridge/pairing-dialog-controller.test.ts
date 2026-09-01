import { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type { PairDialogRequest } from '@core/bridge/mbp1/pair-session'
import type {
  PairingPromptEnqueueResult,
  PairingPromptHandle,
} from '@core/bridge/pairing-prompt-controller'
import { pairRequestKey } from '@shared/protocol/bridge'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairingDialogController } from './pairing-dialog-controller'

const REQ: PairDialogRequest = {
  browser: 'chromium',
  claimedExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  identity: 'official',
  code: '1234-5678',
  pairingNonce: 'nonce-1',
  verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}

function accepted(result: PairingPromptEnqueueResult): PairingPromptHandle {
  if (!result.ok) {
    throw new Error(`expected prompt, got ${result.reason}`)
  }
  return result.handle
}

function request(
  overrides: Partial<PairDialogRequest> = {}
): PairDialogRequest {
  return { ...REQ, ...overrides }
}

function extensionKey(req: PairDialogRequest = REQ): string {
  return pairRequestKey({
    kind: 'extension',
    pairingNonce: req.pairingNonce,
    extensionId: req.claimedExtensionId,
    browser: req.browser,
  })
}

function makeController(
  getMainWindow: () => BrowserWindow | null = () => null
) {
  const bus = new BridgeEventBus()
  const requested: unknown[] = []
  const settled: unknown[] = []
  const expired: unknown[] = []
  bus.on('PairRequested', (payload) => requested.push(payload))
  bus.on('PairRequestSettled', (payload) => settled.push(payload))
  bus.on('PairRequestExpired', (payload) => expired.push(payload))
  const controller = new PairingDialogController(bus, getMainWindow)
  return { controller, bus, requested, settled, expired }
}

async function queue(
  controller: PairingDialogController,
  req: PairDialogRequest = REQ
): Promise<PairingPromptHandle> {
  const handle = accepted(controller.queueMbp1Prompt(req))
  await expect(handle.published).resolves.toBe('delivered')
  return handle
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PairingDialogController shell projection', () => {
  it('publishes the existing renderer payload and focuses a restored window', async () => {
    const window = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      focus: vi.fn(),
    } as unknown as BrowserWindow
    const { controller, requested } = makeController(() => window)

    await queue(controller)

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
    expect(window.isMinimized()).toBe(true)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('keeps an emitted code delivered when Electron focus operations fail', async () => {
    const window = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(() => {
        throw new Error('window restore unavailable')
      }),
      focus: vi.fn(() => {
        throw new Error('window focus unavailable')
      }),
    } as unknown as BrowserWindow
    const { controller, requested } = makeController(() => window)

    const handle = accepted(controller.queueMbp1Prompt(REQ))

    await expect(handle.published).resolves.toBe('delivered')
    expect(requested).toHaveLength(1)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('projects only the code-bearing prompt and snapshot channels', async () => {
    const { controller, settled, expired } = makeController()
    const handle = await queue(controller)

    expect(controller.listPending()).toEqual([
      expect.objectContaining({
        kind: 'extension',
        pairingNonce: REQ.pairingNonce,
        extensionId: REQ.claimedExtensionId,
        browser: REQ.browser,
        identity: REQ.identity,
        code: REQ.code,
      }),
    ])

    handle.settle('aborted')
    await handle.terminal
    await Promise.resolve()

    expect(controller.listPending()).toEqual([])
    expect(JSON.stringify([...settled, ...expired])).not.toContain(REQ.code)
  })
})

describe('PairingDialogController terminal mapping', () => {
  it('maps a real operator dismiss to denied exactly once', async () => {
    const { controller, settled, expired } = makeController()
    const handle = await queue(controller)
    const params = {
      kind: 'extension' as const,
      pairingNonce: REQ.pairingNonce,
      extensionId: REQ.claimedExtensionId,
      browser: REQ.browser,
    }

    expect(controller.settle(params)).toEqual({ ok: true })
    expect(controller.settle(params)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    await expect(handle.terminal).resolves.toBe('denied')
    await Promise.resolve()

    expect(settled).toEqual([{ key: extensionKey(), outcome: 'denied' }])
    expect(expired).toEqual([])
  })

  it.each([
    ['paired', 'allowed'],
    ['aborted', 'aborted'],
  ] as const)(
    'maps a session-owned %s outcome to renderer %s',
    async (outcome, rendererOutcome) => {
      const { controller, settled, expired } = makeController()
      const handle = await queue(controller)

      expect(handle.settle(outcome)).toEqual({ ok: true, outcome })
      await expect(handle.terminal).resolves.toBe(outcome)
      await Promise.resolve()

      expect(settled).toEqual([
        { key: extensionKey(), outcome: rendererOutcome },
      ])
      expect(expired).toEqual([])
    }
  )

  it('maps the core TTL to expiry and makes a late operator action unavailable', async () => {
    vi.useFakeTimers()
    const { controller, settled, expired } = makeController()
    const handle = await queue(controller)

    await vi.advanceTimersByTimeAsync(120_000)

    await expect(handle.terminal).resolves.toBe('expired')
    expect(
      controller.settle({
        kind: 'extension',
        pairingNonce: REQ.pairingNonce,
        extensionId: REQ.claimedExtensionId,
        browser: REQ.browser,
      })
    ).toEqual({ ok: false, reason: 'unavailable' })
    expect(settled).toEqual([])
    expect(expired).toEqual([{ key: extensionKey() }])
  })

  it('maps adapter disposal to aborted and drains terminal publication', async () => {
    const { controller, settled, expired } = makeController()
    const handle = await queue(controller)

    await controller.dispose()

    await expect(handle.terminal).resolves.toBe('aborted')
    expect(settled).toEqual([{ key: extensionKey(), outcome: 'aborted' }])
    expect(expired).toEqual([])
    expect(controller.listPending()).toEqual([])
  })

  it('returns unavailable for an unknown request without emitting', () => {
    const { controller, settled, expired } = makeController()

    expect(
      controller.settle({
        kind: 'extension',
        pairingNonce: 'never-requested',
        extensionId: REQ.claimedExtensionId,
        browser: REQ.browser,
      })
    ).toEqual({ ok: false, reason: 'unavailable' })
    expect(settled).toEqual([])
    expect(expired).toEqual([])
  })
})

describe('PairingDialogController admission projection', () => {
  it('delegates verified-Origin dedup to core', async () => {
    const { controller, requested } = makeController()
    await queue(controller)

    expect(
      controller.queueMbp1Prompt(
        request({
          pairingNonce: 'nonce-2',
          claimedExtensionId: 'attacker-self-report',
        })
      )
    ).toEqual({ ok: false, reason: 'duplicate' })
    expect(requested).toHaveLength(1)
  })

  it('does not dedup different verified Firefox origins with the same claim', async () => {
    const { controller, requested } = makeController()
    const first = request({
      browser: 'firefox',
      verifiedOrigin: 'moz-extension://11111111-1111-1111-1111-111111111111',
    })
    const second = request({
      browser: 'firefox',
      pairingNonce: 'nonce-2',
      verifiedOrigin: 'moz-extension://22222222-2222-2222-2222-222222222222',
    })

    await queue(controller, first)
    await queue(controller, second)

    expect(requested).toHaveLength(2)
  })

  it('enforces the core global capacity without publishing a fourth code', async () => {
    const { controller, requested } = makeController()
    for (let index = 0; index < 3; index += 1) {
      const extensionId = `${index}`.repeat(32)
      await queue(
        controller,
        request({
          pairingNonce: `nonce-${index}`,
          claimedExtensionId: extensionId,
          verifiedOrigin: `chrome-extension://${extensionId}`,
        })
      )
    }
    const fourth = request({
      pairingNonce: 'nonce-4',
      claimedExtensionId: 'dddddddddddddddddddddddddddddddd',
      verifiedOrigin: 'chrome-extension://dddddddddddddddddddddddddddddddd',
    })

    expect(controller.queueMbp1Prompt(fourth)).toEqual({
      ok: false,
      reason: 'capacity',
    })
    expect(requested).toHaveLength(3)
  })

  it('re-admits an Origin after the real denial terminal transition', async () => {
    const { controller, requested } = makeController()
    await queue(controller)
    controller.settle({
      kind: 'extension',
      pairingNonce: REQ.pairingNonce,
      extensionId: REQ.claimedExtensionId,
      browser: REQ.browser,
    })

    await queue(controller, request({ pairingNonce: 'nonce-2' }))

    expect(requested).toHaveLength(2)
  })
})

describe('PairingDialogController callback failure containment', () => {
  it('reports failed publication without throwing or stranding the handle', async () => {
    const bus = new BridgeEventBus()
    bus.on('PairRequested', () => {
      throw new Error(`must-not-escape:${REQ.code}`)
    })
    const controller = new PairingDialogController(bus, () => null)
    const handle = accepted(controller.queueMbp1Prompt(REQ))

    await expect(handle.published).resolves.toBe('failed')
    expect(handle.settle('aborted')).toEqual({
      ok: true,
      outcome: 'aborted',
    })
    await expect(handle.terminal).resolves.toBe('aborted')
    await expect(controller.dispose()).resolves.toBeUndefined()
  })

  it('drains disposal even when a terminal renderer callback throws', async () => {
    const bus = new BridgeEventBus()
    bus.on('PairRequestSettled', () => {
      throw new Error('renderer unavailable')
    })
    const controller = new PairingDialogController(bus, () => null)
    const handle = accepted(controller.queueMbp1Prompt(REQ))
    await handle.published

    await expect(controller.dispose()).resolves.toBeUndefined()
    await expect(handle.terminal).resolves.toBe('aborted')
    expect(controller.listPending()).toEqual([])
  })
})
