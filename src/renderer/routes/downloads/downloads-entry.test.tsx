import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { MenuNavigationFocus } from '@renderer/features/application-menu/navigation-focus'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { Link, MemoryRouter, Outlet, Route, Routes } from 'react-router'
import { expect, it, vi } from 'vitest'
import { DownloadsEntry, useDownloadsOpeningView } from './downloads-entry'

vi.mock('@renderer/lib/transport', () => ({
  transport: { on: vi.fn(), off: vi.fn(), invoke: vi.fn() },
}))

it('keeps the last confirmed opening view across a failed refresh and adopts the next host change', async () => {
  vi.mocked(transport.invoke).mockResolvedValueOnce({
    app: { downloadsOpeningView: 'completed' },
  })
  const { result } = renderHook(useDownloadsOpeningView)
  await waitFor(() => expect(result.current).toBe('completed'))
  const changed = vi
    .mocked(transport.on)
    .mock.calls.find(
      ([event]) => event === Events.DownloadsOpeningViewChanged
    )![1]
  vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('Disconnected'))
  await act(async () => changed())
  expect(result.current).toBe('completed')
  vi.mocked(transport.invoke).mockResolvedValueOnce({
    app: { downloadsOpeningView: 'error' },
  })
  await act(async () => changed())
  expect(result.current).toBe('error')
})

it('focuses the visible downloads grid after a menu visit through the generic route', async () => {
  render(
    <MemoryRouter>
      <MenuNavigationFocus />
      <main>
        <div hidden>
          <h1>Settings</h1>
        </div>
        <Routes>
          <Route
            path="/"
            element={
              <Link to="/downloads" state={{ menuNavigationFocus: true }}>
                Task list
              </Link>
            }
          />
          <Route element={<Outlet context="error" />}>
            <Route path="/downloads" element={<DownloadsEntry />} />
            <Route
              path="/downloads/error"
              element={<table data-downloads-grid />}
            />
          </Route>
        </Routes>
      </main>
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('link', { name: 'Task list' }))
  await waitFor(() => expect(screen.getByRole('table')).toHaveFocus())
})
