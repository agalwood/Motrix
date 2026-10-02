import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyImportDialog } from './legacy-import-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), platform: 'darwin' },
}))
const sourceHandle = '11111111-1111-4111-8111-111111111111'
const previewId = '22222222-2222-4222-8222-222222222222'
const runId = '33333333-3333-4333-8333-333333333333'
const items = [
  {
    itemId: 'gid:1111111111111111',
    name: 'archive.zip',
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
const report = {
  runId,
  stage: 'completed',
  processed: 1,
  total: 1,
  imported: 1,
  backupCreated: true,
  items: items.map((item) => ({
    ...item,
    outcome: 'imported',
    taskId: 'new-task',
  })),
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('legacy import dialog', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
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
          return report
        return { ok: true }
      })
  })

  it('imports selection directly, preserves the paused-state explanation and exposes details on demand', async () => {
    render(<LegacyImportDialog open onClose={vi.fn()} />)
    const action = await screen.findByRole('button', { name: 'Import 1 items' })
    expect(
      screen.queryByRole('textbox', { name: 'Search downloads' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Choose old downloads. Imported tasks stay paused.')
    ).toBeVisible()
    fireEvent.click(action)
    await screen.findByText('Imported 1')
    expect(transport.invoke).toHaveBeenCalledWith(Commands.CommitLegacyImport, {
      previewId,
      itemIds: [items[0].itemId],
    })
    expect(
      screen.getByText('Attention and details').closest('details')
    ).not.toHaveAttribute('open')
  })

  it('disables empty selection and running-source commits', async () => {
    render(<LegacyImportDialog open onClose={vi.fn()} />)
    const checkbox = await screen.findByRole('checkbox', {
      name: 'archive.zip',
    })
    fireEvent.click(checkbox)
    expect(
      screen.getByRole('button', { name: 'Import 0 items' })
    ).toBeDisabled()
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CommitLegacyImport,
      expect.anything()
    )
  })

  it('keeps a failed preflight on selection with its selected item', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport)
        return [{ sourceHandle, name: 'Motrix' }]
      if (channel === Queries.ScanLegacyImport) return preview
      if (channel === Commands.CommitLegacyImport)
        throw new Error('legacyImport.errors.changedSource')
      return undefined
    })
    render(<LegacyImportDialog open onClose={vi.fn()} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Import 1 items' })
    )
    await screen.findByRole('alert')
    expect(screen.getByRole('checkbox', { name: 'archive.zip' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Import 1 items' })).toBeEnabled()
  })

  it('skipping an invitation persists dismissal without a commit', async () => {
    const close = vi.fn()
    render(<LegacyImportDialog open invitation onClose={close} />)
    await screen.findByText('Found 1 downloads to import')
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.DismissLegacyImportInvitation
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CommitLegacyImport,
      expect.anything()
    )
  })
})
