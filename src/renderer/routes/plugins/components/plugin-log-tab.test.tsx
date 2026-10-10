import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Queries } from '@shared/protocol/queries'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PluginLogTab } from './plugin-log-tab'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke, on: vi.fn(), off: vi.fn() },
}))

beforeAll(() => {
  Element.prototype.getAnimations = vi.fn(() => [])
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

describe('PluginLogTab', () => {
  it('copies sanitized entries while keeping verbose local output intact', async () => {
    const raw = 'https://example.com/file?id=private-id&sig=private-signature'
    const entry = { ts: 1000, level: 'info', msg: `GET ${raw}`, uris: [raw] }
    invoke.mockImplementation(async (channel) =>
      channel === Queries.GetPluginLogState
        ? { verbose: true, expiresAt: Date.now() + 60_000 }
        : [entry]
    )
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { unmount } = render(<PluginLogTab pluginId="alice.demo" />)
    await screen.findByText(`GET ${raw}`)
    expect(screen.getByRole('switch')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Copy redacted logs' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const copied = writeText.mock.calls[0][0] as string
    expect(JSON.parse(copied)[0]).toMatchObject({
      ts: 1000,
      level: 'info',
      uris: ['https://example.com/file?id=[redacted]&sig=[redacted]'],
    })
    expect(copied).not.toContain('private-id')
    expect(copied).not.toContain('private-signature')
    expect(screen.getByText(`GET ${raw}`)).toBeInTheDocument()
    expect(entry.uris).toEqual([raw])
    unmount()
  })
})
