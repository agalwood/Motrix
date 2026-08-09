import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

// Real card dialogs (e.g. GeneralDialog) call transport.invoke on mount.
// SettingsPage tests do not assert on dialog internals, so a no-op stub
// keeps these tests focused on routing.
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(async () => ({})),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ pickSaveDir: vi.fn() }),
}))

import { SettingsPage } from './settings-page'

function wrap(initialEntry: string) {
  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />}>
          <Route path=":cardId" element={null} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

describe('SettingsPage', () => {
  it('renders the eight card titles', () => {
    render(wrap('/settings'))
    for (const title of [
      'General',
      'Downloads',
      'BitTorrent',
      'Integration',
      'Network',
      'Appearance',
      'Advanced',
      'About',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument()
    }
  })

  it('switches to three columns at the main window minimum width', () => {
    render(wrap('/settings'))
    const grid = screen.getByText('General').closest('button')?.parentElement

    expect(grid).toHaveClass('grid-cols-2')
    expect(grid).toHaveClass('min-[914px]:grid-cols-3')
    expect(grid).not.toHaveClass('grid-cols-3')
  })

  it('uses compact card sizing below the main window minimum width', () => {
    render(wrap('/settings'))
    const generalCard = screen.getByText('General').closest('button')

    expect(generalCard).toHaveClass('min-h-33')
    expect(generalCard).toHaveClass('min-[914px]:min-h-[170px]')
  })

  it('opens a dialog when the URL contains a valid cardId', () => {
    render(wrap('/settings/general'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('does not open a dialog for unknown cardId', () => {
    render(wrap('/settings/unknown'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
