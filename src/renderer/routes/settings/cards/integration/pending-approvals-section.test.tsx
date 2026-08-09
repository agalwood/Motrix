import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingApprovalsSection } from './pending-approvals-section'
import { usePendingPairRequests } from './use-bridge'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

const LIST = 'bridge:listPendingPairRequests'

function pending() {
  return [
    {
      kind: 'cli',
      requestId: 'r1',
      userCode: 'WXYZ-2345',
      clientName: 'Motrix CLI',
      clientVersion: '1.0.0',
      createdAt: 0,
      expiresAt: Date.now() + 300_000,
    },
  ]
}

function mixedPending() {
  return [
    ...pending(),
    {
      kind: 'extension',
      pairingNonce: 'nonce1',
      extensionId: 'abcdefabcdefabcdefabcdefabcdefab',
      extensionName: 'Motrix Extension',
      extensionVersion: '2.0.0',
      browser: 'chromium',
      createdAt: 0,
      expiresAt: Date.now() + 300_000,
    },
  ]
}

describe('<PendingApprovalsSection>', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockImplementation(async (ch: string) => {
      if (ch === LIST) return pending()
      return { ok: true }
    })
  })
  afterEach(() => vi.clearAllMocks())

  it('lists pending requests from the query', async () => {
    render(<PendingApprovalsSection />)
    expect(await screen.findByText('Motrix CLI · 1.0.0')).toBeInTheDocument()
    expect(screen.getByText(/WXYZ-2345/)).toBeInTheDocument()
  })

  it('renders only the cli row when the list also contains an extension entry', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (ch: string) =>
      ch === LIST ? mixedPending() : { ok: true }
    )
    render(<PendingApprovalsSection />)
    expect(await screen.findByText('Motrix CLI · 1.0.0')).toBeInTheDocument()
    expect(screen.queryByText(/Motrix Extension/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /approve/i })).toHaveLength(1)
  })

  it('shows an empty state when nothing is pending', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (ch: string) =>
      ch === LIST ? [] : { ok: true }
    )
    render(<PendingApprovalsSection />)
    expect(await screen.findByText(/no pending/i)).toBeInTheDocument()
  })

  it('approve invokes ResolvePair(allow) then refetches', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PendingApprovalsSection />)
    const btn = await screen.findByRole('button', { name: /approve/i })
    await user.click(btn)
    expect(transport.invoke).toHaveBeenCalledWith('bridge:resolvePair', {
      kind: 'cli',
      requestId: 'r1',
      decision: 'allow',
    })
    await waitFor(() =>
      expect(
        vi
          .mocked(transport.invoke)
          .mock.calls.filter((c) => (c[0] as string) === LIST).length
      ).toBeGreaterThanOrEqual(2)
    )
  })

  it('does not subscribe to bridge:paired (it never changes the pending set)', async () => {
    render(<PendingApprovalsSection />)
    await screen.findByText('Motrix CLI · 1.0.0')
    const sub = vi
      .mocked(transport.on)
      .mock.calls.find((c) => (c[0] as string) === 'bridge:paired')
    expect(sub).toBeUndefined()
  })

  it.each(['bridge:pairRequestSettled', 'bridge:pairRequestExpired'])(
    're-queries when a %s event fires',
    async (channel) => {
      render(<PendingApprovalsSection />)
      await screen.findByText('Motrix CLI · 1.0.0')
      const sub = vi
        .mocked(transport.on)
        .mock.calls.find((c) => (c[0] as string) === channel)
      expect(sub).toBeTruthy()
      const before = vi
        .mocked(transport.invoke)
        .mock.calls.filter((c) => (c[0] as string) === LIST).length
      ;(sub?.[1] as () => void)?.()
      await waitFor(() =>
        expect(
          vi
            .mocked(transport.invoke)
            .mock.calls.filter((c) => (c[0] as string) === LIST).length
        ).toBeGreaterThan(before)
      )
    }
  )

  it('re-queries on a visible-state visibilitychange (refetchOnVisibility pinned in use-bridge.ts)', async () => {
    render(<PendingApprovalsSection />)
    await screen.findByText('Motrix CLI · 1.0.0')
    const before = vi
      .mocked(transport.invoke)
      .mock.calls.filter((c) => (c[0] as string) === LIST).length

    // jsdom defaults document.visibilityState to 'visible', so this
    // dispatch is the visible-state case the mirror's F6 gating allows.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() =>
      expect(
        vi
          .mocked(transport.invoke)
          .mock.calls.filter((c) => (c[0] as string) === LIST).length
      ).toBeGreaterThan(before)
    )
  })
})

describe('usePendingPairRequests generation guard (Fix 8)', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
  })
  afterEach(() => vi.clearAllMocks())

  it('a stale refresh that resolves after a newer one must not resurrect its response', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    let resolveSecond: (v: unknown) => void = () => {}
    let call = 0
    vi.mocked(transport.invoke).mockImplementation((ch: string) => {
      if (ch !== LIST) return Promise.resolve({ ok: true })
      call++
      if (call === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return new Promise((resolve) => {
        resolveSecond = resolve
      })
    })

    const { result } = renderHook(() => usePendingPairRequests())
    // The mount-triggered refresh is the FIRST-issued call.
    await waitFor(() => expect(call).toBe(1))

    // Issue a second, overlapping refresh (e.g. a live PairRequested event)
    // while the first is still in flight.
    const onPairRequested = vi
      .mocked(transport.on)
      .mock.calls.find(
        (c) => (c[0] as string) === 'bridge:pairRequested'
      )?.[1] as () => void
    onPairRequested()
    await waitFor(() => expect(call).toBe(2))

    const FRESH = {
      kind: 'cli',
      requestId: 'fresh',
      userCode: 'AAAA-1111',
      clientName: 'Motrix CLI',
      clientVersion: '1.0.0',
      createdAt: 0,
      expiresAt: Date.now() + 300_000,
    }
    const STALE = {
      kind: 'cli',
      requestId: 'stale',
      userCode: 'BBBB-2222',
      clientName: 'Motrix CLI',
      clientVersion: '1.0.0',
      createdAt: 0,
      expiresAt: Date.now() + 300_000,
    }

    // The SECOND-issued call resolves first with the fresh data.
    await act(async () => {
      resolveSecond([FRESH])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.items.map((it) => it.requestId)).toEqual(['fresh'])

    // The FIRST-issued call resolves LAST — its (now stale) response must
    // not overwrite the newer state.
    await act(async () => {
      resolveFirst([STALE])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.items.map((it) => it.requestId)).toEqual(['fresh'])
  })
})

describe('usePendingPairRequests retry (Task 10)', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('retries once after a rejected refresh and renders the row once the retry resolves', async () => {
    vi.useFakeTimers()
    let call = 0
    vi.mocked(transport.invoke).mockImplementation(async (ch: string) => {
      if (ch !== LIST) return { ok: true }
      call += 1
      if (call === 1) throw new Error('transient IPC failure')
      return pending()
    })

    render(<PendingApprovalsSection />)

    // First attempt rejects: today this is an unhandled rejection and the
    // list stays empty forever. No crash, row not rendered yet.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByText('Motrix CLI · 1.0.0')).not.toBeInTheDocument()
    expect(call).toBe(1)

    // The bounded retry fires 500ms later and resolves with the cli row.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(call).toBe(2)
    expect(screen.getByText('Motrix CLI · 1.0.0')).toBeInTheDocument()
  })
})
