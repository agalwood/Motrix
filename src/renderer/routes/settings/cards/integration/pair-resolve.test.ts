import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: vi.fn(), close: vi.fn() },
}))

import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { resolvePairWithFeedback } from './pair-resolve'

const t = (key: string) => key

describe('resolvePairWithFeedback', () => {
  afterEach(() => vi.clearAllMocks())

  it('invokes ResolvePair with the channel + params', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({ ok: true })
    await resolvePairWithFeedback(
      { kind: 'cli', requestId: 'r1', decision: 'allow' },
      t
    )
    expect(transport.invoke).toHaveBeenCalledWith('bridge:resolvePair', {
      kind: 'cli',
      requestId: 'r1',
      decision: 'allow',
    })
  })

  it('shows feedback when the result is unavailable', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    })
    const r = await resolvePairWithFeedback(
      { kind: 'cli', requestId: 'x', decision: 'allow' },
      t
    )
    expect(r).toEqual({ ok: false, reason: 'unavailable' })
    expect(toast.add).toHaveBeenCalledWith({
      title: 'settings.integration.cli.pairUnavailable',
    })
  })

  it('shows the browser-specific copy when an extension request is unavailable', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      ok: false,
      reason: 'unavailable',
    })
    const r = await resolvePairWithFeedback(
      {
        kind: 'extension',
        pairingNonce: 'n1',
        extensionId: 'ext1',
        browser: 'chromium',
      },
      t
    )
    expect(r).toEqual({ ok: false, reason: 'unavailable' })
    expect(toast.add).toHaveBeenCalledWith({
      title: 'settings.integration.browser.pairUnavailable',
    })
  })

  it('shows no feedback on ok and tolerates an undefined result', async () => {
    vi.mocked(transport.invoke).mockResolvedValue(undefined)
    const r = await resolvePairWithFeedback(
      { kind: 'cli', requestId: 'x', decision: 'deny' },
      t
    )
    expect(r).toEqual({ ok: true })
    expect(toast.add).not.toHaveBeenCalled()
  })
})
