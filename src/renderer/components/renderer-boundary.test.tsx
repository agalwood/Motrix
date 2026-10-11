import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RendererBoundary } from './renderer-boundary'

afterEach(() => {
  vi.restoreAllMocks()
  document.getElementById('renderer-recovery')?.remove()
})
describe('RendererBoundary', () => {
  it('keeps a DOM recovery surface outside a failed React/provider tree', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const invoke = vi.fn().mockRejectedValue(new Error('Preload unavailable'))
    Object.defineProperty(window, 'motrix', {
      configurable: true,
      value: { invoke, platform: 'darwin' },
    })
    function FailedProvider(): never {
      throw new Error('provider failed')
    }
    const rendered = render(
      <RendererBoundary>
        <FailedProvider />
      </RendererBoundary>
    )
    expect(rendered.container).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toBeVisible()
    const recover = screen.getByRole('button', { name: 'Recover interface' })
    fireEvent.click(recover)
    await waitFor(() => expect(recover).toBeEnabled())
    expect(screen.getByText(/Recovery is unavailable/)).toBeVisible()
    // Unmounting the failed tree cannot remove the independent recovery UI.
    rendered.unmount()
    expect(screen.getByRole('alert')).toBeVisible()
    Reflect.deleteProperty(window, 'motrix')
  })
})
