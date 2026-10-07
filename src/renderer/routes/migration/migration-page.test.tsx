import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MigrationPage } from './migration-page'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), platform: 'darwin' },
}))
const sourceHandle = '11111111-1111-4111-8111-111111111111'
const previewId = '22222222-2222-4222-8222-222222222222'
const runId = '33333333-3333-4333-8333-333333333333'
const items = [
  {
    itemId: 'one',
    name: 'one.zip',
    type: 'http',
    selectable: true,
    reason: 'fresh-download-required',
  },
  {
    itemId: 'two',
    name: 'two.zip',
    type: 'http',
    selectable: true,
    reason: 'fresh-download-required',
  },
]
const preview = {
  previewId,
  sourceHandle,
  sourceName: 'Motrix',
  items,
  running: false,
  checkpointImportAvailable: false,
  expiresAt: Date.now() + 100000,
}
const finished = {
  runId,
  stage: 'completed',
  processed: 1,
  total: 1,
  imported: 1,
  backupCreated: true,
  items: [{ ...items[0], outcome: 'imported', taskId: 'new' }],
}
function Host() {
  const location = useLocation()
  const navigate = useNavigate()
  const active = location.pathname === '/migration'
  return (
    <>
      <button type="button" onClick={() => navigate('/downloads/all')}>
        Go downloads
      </button>
      <button type="button" onClick={() => navigate('/migration')}>
        Go migration
      </button>
      <p data-testid="route">{location.pathname}</p>
      <div hidden={!active} className="h-full">
        <MigrationPage active={active} />
      </div>
    </>
  )
}
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.mocked(transport.invoke)
    .mockReset()
    .mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport)
        return [{ sourceHandle, name: 'Motrix' }]
      if (channel === Queries.ScanLegacyImport) return preview
      if (
        channel === Commands.CommitLegacyImport ||
        channel === Queries.GetLegacyImportRun
      )
        return finished
      return { ok: true }
    })
})
describe('retained migration page', () => {
  it('retains invitation and individual choices across navigation, then persists explicit skip', async () => {
    render(
      <MemoryRouter initialEntries={['/migration?invitation=1']}>
        <Host />
      </MemoryRouter>
    )
    await screen.findByText('Downloads found: 2')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'two.zip' }))
    fireEvent.click(screen.getByText('Go downloads'))
    fireEvent.click(screen.getByText('Go migration'))
    expect(screen.getByRole('checkbox', { name: 'two.zip' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Migrate 1 task' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.DismissLegacyImportInvitation
      )
    )
    fireEvent.click(screen.getByText('Go migration'))
    expect(
      screen.queryByRole('button', { name: 'Continue' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to source' })).toBeVisible()
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([c]) => c === Queries.DiscoverLegacyImport)
    ).toHaveLength(1)
  })
  it('keeps one running import and its result while away; explicit finish starts a fresh deduplicated preview on return', async () => {
    let complete!: (value: typeof finished) => void
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport)
        return [{ sourceHandle, name: 'Motrix' }]
      if (channel === Queries.ScanLegacyImport) return preview
      if (channel === Commands.CommitLegacyImport)
        return new Promise((resolve) => {
          complete = resolve
        })
      return { ok: true }
    })
    render(
      <MemoryRouter initialEntries={['/migration']}>
        <Host />
      </MemoryRouter>
    )
    await screen.findByText('Downloads found: 2')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'two.zip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Migrate 1 task' }))
    fireEvent.click(screen.getByText('Go downloads'))
    fireEvent.click(screen.getByText('Go migration'))
    expect(screen.getByRole('progressbar')).toBeVisible()
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([c]) => c === Commands.CommitLegacyImport)
    ).toHaveLength(1)
    await act(async () => complete(finished))
    await screen.findByText('Imported 1')
    fireEvent.click(screen.getByText('Go downloads'))
    fireEvent.click(screen.getByText('Go migration'))
    expect(screen.getByText('Imported 1')).toBeVisible()
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport)
        return [{ sourceHandle, name: 'Motrix' }]
      if (channel === Queries.ScanLegacyImport)
        return {
          ...preview,
          items: [
            { ...items[0], selectable: false, reason: 'already-imported' },
            items[1],
          ],
        }
      return { ok: true }
    })
    fireEvent.click(screen.getByRole('button', { name: 'View downloads' }))
    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/downloads/all')
    )
    fireEvent.click(screen.getByText('Go migration'))
    expect(
      await screen.findByRole('button', { name: 'Continue' })
    ).toBeVisible()
    await screen.findByText('Downloads found: 2')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('button', { name: 'Migrate 1 task' })).toBeVisible()
    expect(screen.queryByText('Imported 1')).not.toBeInTheDocument()
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([c]) => c === Queries.DiscoverLegacyImport)
    ).toHaveLength(2)
  })
})
