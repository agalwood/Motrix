import { i18n } from '@renderer/lib/i18n'
import { BridgeEvents } from '@shared/protocol/bridge'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  toastAddMock,
  toastCloseMock,
  onMock,
  offMock,
  invokeMock,
  onConnectionChangeMock,
} = vi.hoisted(() => ({
  toastAddMock: vi.fn((opts: { id?: string }) => opts.id ?? 'generated-id'),
  toastCloseMock: vi.fn(),
  onMock: vi.fn(),
  offMock: vi.fn(),
  invokeMock: vi.fn(),
  onConnectionChangeMock: vi.fn((_cb: (event: { state: string }) => void) =>
    vi.fn()
  ),
}))

// Keep the real `pairRequestCopy` (the hook now uses it at add-time for
// the F1 SR-announcement copy — see toast.tsx) while stubbing the
// `toast` manager itself.
vi.mock('@renderer/components/ui/toast', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@renderer/components/ui/toast')>()
  return {
    ...actual,
    toast: { add: toastAddMock, close: toastCloseMock },
  }
})

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    on: onMock,
    off: offMock,
    invoke: invokeMock,
    onConnectionChange: onConnectionChangeMock,
  },
}))

import { usePairRequestPrompts } from './use-pair-request-prompts'

function Host() {
  usePairRequestPrompts()
  return null
}

function findListener(channel: string) {
  const call = onMock.mock.calls.find((c) => c[0] === channel)
  return call?.[1] as (payload: unknown) => void
}

function findAddCall(id: string) {
  const call = toastAddMock.mock.calls.find((c) => c[0].id === id)
  return call?.[0] as {
    id: string
    title?: string
    description?: string
    timeout: number
    priority: string
    data: { pairRequest: Record<string, unknown> }
    onClose: () => void
  }
}

const CLI_A = {
  kind: 'cli',
  requestId: 'A',
  userCode: 'AAAA-1111',
  clientName: 'Motrix CLI',
  clientVersion: '1.0.0',
}

const CLI_B = {
  kind: 'cli',
  requestId: 'B',
  userCode: 'BBBB-2222',
  clientName: 'Motrix CLI',
  clientVersion: '1.0.0',
}

const EXT_A = {
  kind: 'extension',
  pairingNonce: 'n',
  extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  identity: 'official',
  code: '1234-5678',
  browser: 'chromium',
}

function cliPending(requestId: string) {
  return {
    kind: 'cli',
    requestId,
    userCode: 'WXYZ-2345',
    clientName: 'Motrix CLI',
    clientVersion: '1.0.0',
    createdAt: 0,
    expiresAt: Date.now() + 300_000,
  }
}

describe('usePairRequestPrompts', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue([])
    toastAddMock.mockClear()
    toastCloseMock.mockReset()
    onMock.mockReset()
    offMock.mockReset()
    onConnectionChangeMock.mockReset().mockImplementation(() => vi.fn())
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('subscribes to PairRequested/Settled/Expired BEFORE invoking the pending snapshot', () => {
    render(<Host />)
    expect(onMock).toHaveBeenCalledWith(
      BridgeEvents.PairRequested,
      expect.any(Function)
    )
    expect(onMock).toHaveBeenCalledWith(
      BridgeEvents.PairRequestSettled,
      expect.any(Function)
    )
    expect(onMock).toHaveBeenCalledWith(
      BridgeEvents.PairRequestExpired,
      expect.any(Function)
    )
    const lastOnOrder = Math.max(...onMock.mock.invocationCallOrder)
    const invokeOrder = invokeMock.mock.invocationCallOrder[0]
    expect(invokeOrder).toBeGreaterThan(lastOnOrder)
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<Host />)
    unmount()
    expect(offMock).toHaveBeenCalledWith(
      BridgeEvents.PairRequested,
      expect.any(Function)
    )
    expect(offMock).toHaveBeenCalledWith(
      BridgeEvents.PairRequestSettled,
      expect.any(Function)
    )
    expect(offMock).toHaveBeenCalledWith(
      BridgeEvents.PairRequestExpired,
      expect.any(Function)
    )
  })

  it('cold start: the pending snapshot synthesizes one prompt', async () => {
    invokeMock.mockResolvedValueOnce([cliPending('REQ1')])
    render(<Host />)
    await waitFor(() => expect(toastAddMock).toHaveBeenCalledTimes(1))
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'cli:REQ1',
        // F1: title/description must ride along in the add() options —
        // Base UI's high-priority alert region announces from these, not
        // from whatever ToastList renders as children.
        title: 'Motrix CLI wants to pair with Motrix',
        description: 'Verification code: WXYZ-2345',
        timeout: 0,
        priority: 'high',
      })
    )
  })

  it('F1: toast.add carries the SR announcement copy for both request kinds', () => {
    render(<Host />)
    findListener(BridgeEvents.PairRequested)(CLI_A)
    expect(findAddCall('cli:A')).toMatchObject({
      title: 'Motrix CLI wants to pair with Motrix',
      description: 'Verification code: AAAA-1111',
    })

    findListener(BridgeEvents.PairRequested)(EXT_A)
    expect(
      findAddCall('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:n')
    ).toMatchObject({
      // MBP1 forbids displaying the self-reported extension name (§5), and
      // the raw id is meaningless in a title — it is the description, shown
      // once; the browser rides in the title instead of a "From …" row.
      title: 'A Chrome / Edge extension wants to connect to Motrix',
      // The full id, comparable against chrome://extensions; only the
      // label is terse.
      description: 'ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
  })

  it('never copies an Extension pairing code to the clipboard while presenting it', () => {
    const writeText = vi.fn()
    const originalClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    try {
      render(<Host />)
      findListener(BridgeEvents.PairRequested)(EXT_A)
      expect(
        findAddCall('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:n')
      ).toBeDefined()
      expect(writeText).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      })
    }
  })

  it('over-limit sanity: 4 pending requests synthesize 4 prompts', async () => {
    invokeMock.mockResolvedValueOnce([
      cliPending('REQ1'),
      cliPending('REQ2'),
      cliPending('REQ3'),
      cliPending('REQ4'),
    ])
    render(<Host />)
    await waitFor(() => expect(toastAddMock).toHaveBeenCalledTimes(4))
  })

  it('reload mid-request: mount -> event fires -> unmount -> remount -> snapshot recovers exactly one live prompt for the same key', async () => {
    // The row is still pending across both mounts — the backend hasn't
    // decided it, only the renderer reloaded.
    invokeMock.mockResolvedValue([cliPending('REQ1')])
    const { unmount } = render(<Host />)
    // The request also arrives live (e.g. it fired before the reload) —
    // present() must dedupe this against the snapshot's identical entry,
    // so this mount still produces exactly one add.
    findListener(BridgeEvents.PairRequested)({
      kind: 'cli',
      requestId: 'REQ1',
      userCode: 'WXYZ-2345',
      clientName: 'Motrix CLI',
      clientVersion: '1.0.0',
    })
    await waitFor(() => expect(toastAddMock).toHaveBeenCalledTimes(1))
    expect(toastAddMock.mock.calls[0][0].id).toBe('cli:REQ1')

    unmount()
    toastAddMock.mockClear()

    render(<Host />)
    await waitFor(() => expect(toastAddMock).toHaveBeenCalledTimes(1))
    expect(toastAddMock.mock.calls[0][0].id).toBe('cli:REQ1')
  })

  it('tombstone race: a Settled event for key K while the snapshot is in flight suppresses the stale snapshot entry', async () => {
    let resolveSnapshot: (value: unknown) => void = () => {}
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )
    render(<Host />)

    // K settles (e.g. approved from the Pending Approvals inbox) before
    // the in-flight snapshot's (now stale) response lands.
    findListener(BridgeEvents.PairRequestSettled)({
      key: 'cli:REQ1',
      outcome: 'allowed',
    })

    await act(async () => {
      resolveSnapshot([cliPending('REQ1')])
      // Flush the microtask chain inside the hook's snapshot IIFE
      // (`await transport.invoke(...)` -> the `for` loop's `present()`).
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(toastAddMock).not.toHaveBeenCalled()
  })

  it('F4: unmounting while the snapshot invoke is in flight suppresses the abandoned add', async () => {
    let resolveSnapshot: (value: unknown) => void = () => {}
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const { unmount } = render(<Host />)

    // Tear the hook down BEFORE the in-flight ListPendingPairRequests
    // resolves — this is the abandoned-run race F4 guards against: without
    // the `cancelled` flag, the resolved snapshot below would still call
    // `present()` -> `toast.add({ id: key, onClose })` from a dead effect
    // instance, upserting a stale `onClose` closure over whatever a live
    // instance (e.g. a remount) might otherwise own for the same key.
    unmount()

    await act(async () => {
      resolveSnapshot([cliPending('REQ1')])
      // Flush the microtask chain inside the hook's snapshot IIFE
      // (`await transport.invoke(...)` -> the `for` loop's `present()`).
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(toastAddMock).not.toHaveBeenCalled()
  })

  it('a t-identity change (e.g. LanguageSync re-asserting the same locale) does not re-prompt or lose settled state', async () => {
    invokeMock.mockResolvedValue([])
    render(<Host />)
    findListener(BridgeEvents.PairRequested)(CLI_A)
    expect(toastAddMock).toHaveBeenCalledTimes(1)

    const data = findAddCall('cli:A').data.pairRequest as {
      onAllow: () => void
    }
    data.onAllow()
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bridge:resolvePair', {
        kind: 'cli',
        requestId: 'A',
        decision: 'allow',
      })
    )

    toastAddMock.mockClear()
    invokeMock.mockClear()

    // react-i18next bumps `t`'s identity on every changeLanguage call
    // (even to the already-current language, which is what
    // LanguageSync does unconditionally on every app start) — the effect
    // must NOT tear down/re-subscribe/re-snapshot on that.
    await act(async () => {
      await i18n.changeLanguage('en-US')
    })
    expect(invokeMock).not.toHaveBeenCalled()
    expect(toastAddMock).not.toHaveBeenCalled()

    // The settled map must also have survived intact: replaying the SAME
    // onAllow closure must still be a no-op, proving it wasn't discarded
    // and rebuilt by an effect re-run.
    data.onAllow()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('backend expiry closes the prompt silently, without sending a deny', () => {
    render(<Host />)
    findListener(BridgeEvents.PairRequested)(CLI_A)
    expect(toastAddMock).toHaveBeenCalledTimes(1)
    invokeMock.mockClear()
    findListener(BridgeEvents.PairRequestExpired)({ key: 'cli:A' })
    expect(toastCloseMock).toHaveBeenCalledWith('cli:A')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it.each(['allowed', 'denied', 'aborted'] as const)(
    'backend %s settle closes the prompt silently, without sending a deny',
    (outcome) => {
      render(<Host />)
      findListener(BridgeEvents.PairRequested)(CLI_A)
      invokeMock.mockClear()
      findListener(BridgeEvents.PairRequestSettled)({
        key: 'cli:A',
        outcome,
      })
      expect(toastCloseMock).toHaveBeenCalledWith('cli:A')
      expect(invokeMock).not.toHaveBeenCalled()
    }
  )

  it('duplicate PairRequested events for one key produce exactly one add', () => {
    render(<Host />)
    const listener = findListener(BridgeEvents.PairRequested)
    listener(CLI_A)
    listener(CLI_A)
    expect(toastAddMock).toHaveBeenCalledTimes(1)
  })

  it('two concurrent requests settle independently by identity', async () => {
    render(<Host />)
    const listener = findListener(BridgeEvents.PairRequested)
    listener(CLI_A)
    listener(CLI_B)

    const dataA = findAddCall('cli:A').data.pairRequest as {
      onAllow: () => void
    }
    dataA.onAllow()

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bridge:resolvePair', {
        kind: 'cli',
        requestId: 'A',
        decision: 'allow',
      })
    )
    expect(invokeMock).not.toHaveBeenCalledWith(
      'bridge:resolvePair',
      expect.objectContaining({ requestId: 'B' })
    )
    expect(toastCloseMock).toHaveBeenCalledWith('cli:A')
    expect(toastCloseMock).not.toHaveBeenCalledWith('cli:B')
  })

  it('dismissal (the toast onClose) routes deny for that key only', async () => {
    render(<Host />)
    const listener = findListener(BridgeEvents.PairRequested)
    listener(CLI_A)
    listener(CLI_B)

    findAddCall('cli:A').onClose()

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bridge:resolvePair', {
        kind: 'cli',
        requestId: 'A',
        decision: 'deny',
      })
    )
    expect(invokeMock).not.toHaveBeenCalledWith(
      'bridge:resolvePair',
      expect.objectContaining({ requestId: 'B' })
    )
  })

  it('extension pair request dismisses via pairingNonce/extensionId/browser — no decision under MBP1', async () => {
    render(<Host />)
    findListener(BridgeEvents.PairRequested)(EXT_A)
    const data = findAddCall('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:n').data
      .pairRequest as { onDeny: () => void }
    // An extension prompt has no onAllow at all (see PairRequestToastData) —
    // Deny is the only decision affordance, and it still sends no `decision`
    // field: approval under MBP1 is proven by typing the code, not a click.
    data.onDeny()
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bridge:resolvePair', {
        kind: 'extension',
        pairingNonce: 'n',
        extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        browser: 'chromium',
      })
    )
  })

  it('cli pair request resolves by requestId (device-code)', async () => {
    render(<Host />)
    findListener(BridgeEvents.PairRequested)(CLI_A)
    const data = findAddCall('cli:A').data.pairRequest as {
      onAllow: () => void
    }
    data.onAllow()
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bridge:resolvePair', {
        kind: 'cli',
        requestId: 'A',
        decision: 'allow',
      })
    )
  })

  it('settled flag prevents double-resolution when onClose follows Allow', async () => {
    render(<Host />)
    findListener(BridgeEvents.PairRequested)(CLI_A)
    const added = findAddCall('cli:A')
    const data = added.data.pairRequest as { onAllow: () => void }
    invokeMock.mockClear() // drop the mount-time ListPendingPairRequests call
    data.onAllow()
    added.onClose()
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
  })

  it('settled flag prevents double-resolution on repeated Deny clicks', async () => {
    render(<Host />)
    findListener(BridgeEvents.PairRequested)(EXT_A)
    const data = findAddCall('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:n').data
      .pairRequest as { onDeny: () => void }
    invokeMock.mockClear() // drop the mount-time ListPendingPairRequests call
    data.onDeny()
    data.onDeny()
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
  })

  it('late settle: an unavailable ResolvePair result surfaces the feedback toast', async () => {
    render(<Host />)
    findListener(BridgeEvents.PairRequested)({
      kind: 'cli',
      requestId: 'gone',
      userCode: 'WXYZ-2345',
      clientName: 'Motrix CLI',
      clientVersion: '1.0.0',
    })
    invokeMock.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    const data = findAddCall('cli:gone').data.pairRequest as {
      onAllow: () => void
    }
    data.onAllow()

    await waitFor(() =>
      expect(toastAddMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title:
            'This pairing request is no longer pending — re-run `motrix pair`.',
        })
      )
    )
  })

  it('Fix 7: a rejected resolvePair keeps the request alive — error toast fires, and a later PairRequested re-presents it', async () => {
    render(<Host />)
    findListener(BridgeEvents.PairRequested)(CLI_A)
    expect(toastAddMock).toHaveBeenCalledTimes(1)

    invokeMock.mockRejectedValueOnce(new Error('network down'))
    const data = findAddCall('cli:A').data.pairRequest as {
      onAllow: () => void
    }
    data.onAllow()

    await waitFor(() =>
      expect(toastAddMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: 'Couldn’t submit your decision — try again.',
        })
      )
    )

    // The backend never actually saw a decision (the transport call itself
    // failed), so the request is still genuinely pending — a later
    // PairRequested for the SAME key must re-present it, not silently no-op.
    toastAddMock.mockClear()
    findListener(BridgeEvents.PairRequested)(CLI_A)
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cli:A' })
    )
  })

  it('Fix 2: re-snapshots when the transport reports connected (web reconnect gap)', async () => {
    render(<Host />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    expect(onConnectionChangeMock).toHaveBeenCalledWith(expect.any(Function))

    // A request created while the socket was reconnecting is only visible
    // to the NEXT snapshot, not the initial one.
    invokeMock.mockResolvedValueOnce([cliPending('REQ1')])
    const connectionListener = onConnectionChangeMock.mock.calls[0][0] as (e: {
      state: string
    }) => void
    connectionListener({ state: 'connected' })

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(toastAddMock).toHaveBeenCalledTimes(1))
    expect(toastAddMock.mock.calls[0][0].id).toBe('cli:REQ1')
  })

  it('Fix 2: a non-connected transition does not trigger a re-snapshot', async () => {
    render(<Host />)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    const connectionListener = onConnectionChangeMock.mock.calls[0][0] as (e: {
      state: string
    }) => void
    connectionListener({ state: 'disconnected' })
    connectionListener({ state: 'connecting' })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('Fix 2: disposes the connection-change subscription on unmount', () => {
    const unsub = vi.fn()
    onConnectionChangeMock.mockReturnValueOnce(unsub)
    const { unmount } = render(<Host />)
    expect(unsub).not.toHaveBeenCalled()
    unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})
