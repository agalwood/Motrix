import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
}))

import { UninstallSection } from './uninstall-section'

describe('UninstallSection', () => {
  it('renders nothing when hidden', () => {
    const { container } = render(
      <UninstallSection pluginId="p" pluginName="P" hidden={true} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders only the Uninstall icon button', () => {
    render(<UninstallSection pluginId="p.x" pluginName="X" hidden={false} />)
    expect(screen.queryByText('Remove plugin')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Uninstall' })
    ).toBeInTheDocument()
  })

  it('shows AlertDialog confirm with plugin name interpolated', () => {
    render(<UninstallSection pluginId="p.x" pluginName="X" hidden={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    expect(screen.getByText('Uninstall X?')).toBeInTheDocument()
  })

  it('confirm invokes UninstallPlugin command', async () => {
    render(<UninstallSection pluginId="p.x" pluginName="X" hidden={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    const confirmBtns = screen.getAllByRole('button', { name: 'Uninstall' })
    fireEvent.click(confirmBtns[confirmBtns.length - 1])
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('command:uninstallPlugin', {
        pluginId: 'p.x',
      })
    )
  })
})
