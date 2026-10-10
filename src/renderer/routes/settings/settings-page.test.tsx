import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('opens a dialog when the URL contains a valid cardId', () => {
    render(wrap('/settings/general'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('opens a card from the grid and returns to the grid on Cancel', async () => {
    const user = userEvent.setup()
    render(wrap('/settings'))

    await user.click(screen.getByRole('button', { name: /General/ }))
    expect(await screen.findByRole('dialog', { name: 'General' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: /General/ })).toBeVisible()
  })

  it('does not open a dialog for unknown cardId', () => {
    render(wrap('/settings/unknown'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
