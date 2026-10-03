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
    const action = await screen.findByRole('button', { name: 'Import 1' })
    expect(
      screen.queryByRole('textbox', { name: 'Search downloads' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Choose which Motrix v1 downloads to import. They won’t start automatically.'
      )
    ).toBeVisible()
    fireEvent.click(action)
    await screen.findByText('Imported 1')
    expect(transport.invoke).toHaveBeenCalledWith(Commands.CommitLegacyImport, {
      previewId,
      itemIds: [items[0].itemId],
    })
    expect(
      screen.getByText('View details').closest('details')
    ).not.toHaveAttribute('open')
  })

  it('disables empty selection and running-source commits', async () => {
    render(<LegacyImportDialog open onClose={vi.fn()} />)
    const checkbox = await screen.findByRole('checkbox', {
      name: 'archive.zip',
    })
    fireEvent.click(checkbox)
    expect(screen.getByRole('button', { name: 'Import 0' })).toBeDisabled()
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CommitLegacyImport,
      expect.anything()
    )
  })

  it.each([
    {
      stage: 'completed',
      outcome: 'skipped',
      reason: 'already-imported',
      title: 'No new downloads',
      description: 'Open the details to see why each task was skipped.',
      status: 'Skipped',
      canRetry: false,
    },
    {
      stage: 'cancelled',
      outcome: 'unprocessed',
      reason: 'stopped',
      title: 'Migration stopped',
      description:
        'Downloads already imported are kept. You can import the rest when you’re ready.',
      status: 'Not imported',
      canRetry: true,
    },
    {
      stage: 'failed',
      outcome: 'failed',
      reason: 'commit-failed',
      title: 'Some downloads still need importing',
      description:
        'Downloads already imported are kept. Review the details and try importing the rest again.',
      status: 'Failed',
      canRetry: true,
    },
  ])(
    'explains $stage / $outcome without claiming migration completed',
    async (result) => {
      vi.mocked(transport.invoke).mockImplementation(async (channel) => {
        if (channel === Queries.DiscoverLegacyImport)
          return [{ sourceHandle, name: 'Motrix' }]
        if (channel === Queries.ScanLegacyImport) return preview
        if (channel === Commands.CommitLegacyImport)
          return {
            ...report,
            stage: result.stage,
            imported: 0,
            items: [
              {
                ...items[0],
                reason: result.reason,
                outcome: result.outcome,
                taskId: null,
              },
            ],
          }
        return { ok: true }
      })
      render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Import 1' }))
      expect(
        await screen.findByRole('heading', { name: result.title })
      ).toBeVisible()
      expect(
        screen.queryByRole('heading', { name: 'Migration complete' })
      ).not.toBeInTheDocument()
      expect(screen.getByText(result.description)).toBeVisible()
      expect(
        Boolean(screen.queryByRole('button', { name: 'Import remaining' }))
      ).toBe(result.canRetry)
      fireEvent.click(screen.getByText('View details'))
      expect(
        screen.getByText(result.status, { selector: 'span', exact: true })
      ).toBeVisible()
    }
  )

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
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('checkbox', { name: 'archive.zip' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Import 1' })).toBeEnabled()
  })

  it('skipping an invitation persists dismissal without a commit', async () => {
    const close = vi.fn()
    render(<LegacyImportDialog open invitation onClose={close} />)
    await screen.findByText('Downloads found: 1')
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.DismissLegacyImportInvitation
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CommitLegacyImport,
      expect.anything()
    )
  })

  it('counts a torrent awaiting metadata in discovery and keeps its repair reachable', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport)
        return [{ sourceHandle, name: 'Motrix' }]
      if (channel === Queries.ScanLegacyImport)
        return {
          ...preview,
          items: [
            {
              itemId: 'gid:2222222222222222',
              name: 'saved.torrent',
              type: 'bt',
              selectable: false,
              reason: 'metadata-required',
            },
          ],
        }
      return undefined
    })
    render(<LegacyImportDialog open invitation onClose={vi.fn()} />)
    await screen.findByText('Downloads found: 1')
    fireEvent.click(screen.getByRole('button', { name: 'Choose downloads' }))
    expect(screen.getByRole('button', { name: 'Import 0' })).toBeDisabled()
    fireEvent.click(screen.getByText('Skipped: 1'))
    expect(
      screen.getByRole('button', { name: 'Choose torrent…' })
    ).toBeEnabled()
  })

  it('authorizes a skipped torrent in place, preserves deselected downloads and selects the repaired item', async () => {
    const bt = {
      itemId: 'gid:2222222222222222',
      name: 'saved.torrent',
      type: 'bt',
      selectable: false,
      reason: 'metadata-required',
    }
    const refreshedId = '44444444-4444-4444-8444-444444444444'
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport)
        return [{ sourceHandle, name: 'Motrix' }]
      if (channel === Queries.ScanLegacyImport)
        return { ...preview, items: [...items, bt] }
      if (channel === Commands.PickLegacyTorrentMetadata)
        return {
          ...preview,
          previewId: refreshedId,
          items: [
            ...items,
            {
              ...bt,
              name: 'fixture-bundle',
              selectable: true,
              reason: 'verification-required',
            },
          ],
        }
      if (channel === Commands.CommitLegacyImport) return report
      return undefined
    })
    render(<LegacyImportDialog open onClose={vi.fn()} />)
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'archive.zip' })
    )
    fireEvent.click(screen.getByText('Skipped: 1'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose torrent…' }))
    const repaired = await screen.findByRole('checkbox', {
      name: 'fixture-bundle',
    })
    expect(repaired).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'archive.zip' })
    ).not.toBeChecked()
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.PickLegacyTorrentMetadata,
      { previewId, itemId: bt.itemId }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.CommitLegacyImport,
        { previewId: refreshedId, itemIds: [bt.itemId] }
      )
    )
  })

  it('retains the current selection and preview when torrent selection is cancelled', async () => {
    const bt = {
      itemId: 'gid:2222222222222222',
      name: 'saved.torrent',
      type: 'bt',
      selectable: false,
      reason: 'metadata-required',
    }
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport)
        return [{ sourceHandle, name: 'Motrix' }]
      if (channel === Queries.ScanLegacyImport)
        return { ...preview, items: [...items, bt] }
      if (channel === Commands.PickLegacyTorrentMetadata) return null
      if (channel === Commands.CommitLegacyImport) return report
      return undefined
    })
    render(<LegacyImportDialog open onClose={vi.fn()} />)
    await screen.findByRole('checkbox', { name: 'archive.zip' })
    fireEvent.click(screen.getByText('Skipped: 1'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose torrent…' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import 1' })).toBeEnabled()
    )
    expect(screen.getByRole('checkbox', { name: 'archive.zip' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.CommitLegacyImport,
        { previewId, itemIds: [items[0].itemId] }
      )
    )
  })
})
