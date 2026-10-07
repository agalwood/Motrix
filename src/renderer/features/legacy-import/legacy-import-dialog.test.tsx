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
    saveDir: '/Users/example/Downloads/Project files',
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

async function continueFromSource() {
  const button = await screen.findByRole('button', {
    name: 'Continue',
  })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  for (const group of document.querySelectorAll<HTMLButtonElement>(
    '[data-import-group] button[aria-expanded="false"]'
  ))
    fireEvent.click(group)
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

  it('starts at source for manual entry and preserves deselection when returning to the same source', async () => {
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    expect(
      await screen.findByRole('heading', {
        name: 'Where would you like to migrate from?',
      })
    ).toBeVisible()
    await screen.findByText('Downloads found: 1')
    expect(
      screen.queryByRole('checkbox', { name: 'archive.zip' })
    ).not.toBeInTheDocument()
    await continueFromSource()
    fireEvent.click(screen.getByRole('checkbox', { name: 'archive.zip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to source' }))
    fireEvent.click(screen.getByRole('button', { name: 'Motrix' }))
    await continueFromSource()
    expect(
      screen.getByRole('checkbox', { name: 'archive.zip' })
    ).not.toBeChecked()
    expect(
      screen.getByRole('button', { name: 'Migrate 0 tasks' })
    ).toBeDisabled()
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([channel]) => channel === Queries.ScanLegacyImport)
    ).toHaveLength(1)
  })

  it('invalidates the old preview on source change, exposes scan retry, and selects only the new source tasks', async () => {
    const other = {
      sourceHandle: '55555555-5555-4555-8555-555555555555',
      name: 'Backup',
    }
    let backupScans = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel, payload) => {
      if (channel === Queries.DiscoverLegacyImport)
        return [{ sourceHandle, name: 'Motrix' }, other]
      if (channel === Queries.ScanLegacyImport) {
        if (
          (payload as { sourceHandle: string }).sourceHandle ===
          other.sourceHandle
        ) {
          if (++backupScans === 1)
            throw new Error('legacyImport.errors.invalidSource')
          return {
            ...preview,
            sourceHandle: other.sourceHandle,
            sourceName: other.name,
            items: [{ ...items[0], itemId: 'backup-task', name: 'backup.zip' }],
          }
        }
        return preview
      }
      return undefined
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await continueFromSource()
    fireEvent.click(screen.getByRole('checkbox', { name: 'archive.zip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to source' }))
    fireEvent.click(screen.getByRole('button', { name: 'Backup' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: /Migrate/ })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await continueFromSource()
    expect(screen.getByRole('checkbox', { name: 'backup.zip' })).toBeChecked()
    expect(
      screen.queryByRole('checkbox', { name: 'archive.zip' })
    ).not.toBeInTheDocument()
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.CommitLegacyImport,
      expect.anything()
    )
  })

  it('shows folder fallback when discovery has no source and uses the authorized picked source', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) return []
      if (channel === Commands.PickLegacyImportSource)
        return { sourceHandle, name: 'Picked folder' }
      if (channel === Queries.ScanLegacyImport)
        return { ...preview, sourceName: 'Picked folder' }
      return undefined
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await screen.findByText(
      'No Motrix v1 data was found on this computer. Choose its data folder to continue.'
    )
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await continueFromSource()
    expect(screen.getByRole('checkbox', { name: 'archive.zip' })).toBeChecked()
    expect(transport.invoke).toHaveBeenCalledWith(Queries.ScanLegacyImport, {
      sourceHandle,
    })
  })

  it('explains an empty source and keeps migration disabled', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport)
        return [{ sourceHandle, name: 'Motrix' }]
      if (channel === Queries.ScanLegacyImport) return { ...preview, items: [] }
      return undefined
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await screen.findByText('There are no tasks to migrate from this folder.')
    await continueFromSource()
    expect(
      screen.getByRole('button', { name: 'Migrate 0 tasks' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back to source' })).toBeEnabled()
  })

  it('imports selection directly, preserves the paused-state explanation and exposes details on demand', async () => {
    render(<LegacyImportDialog open onClose={vi.fn()} />)
    await continueFromSource()
    const action = await screen.findByRole('button', { name: 'Migrate 1 task' })
    expect(
      screen.queryByRole('textbox', { name: 'Search downloads' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('Imported tasks will stay paused.')).toBeVisible()
    fireEvent.click(action)
    await screen.findByText('Imported 1')
    expect(transport.invoke).toHaveBeenCalledWith(Commands.CommitLegacyImport, {
      previewId,
      itemIds: [items[0].itemId],
    })
    expect(
      screen.getByRole('button', { name: 'View details' })
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the original download path and task type visible through import', async () => {
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await continueFromSource()
    await screen.findByRole('checkbox', { name: 'archive.zip' })
    expect(screen.getByTitle(items[0].saveDir)).toBeVisible()
    expect(
      screen.getByText('Link', { selector: '[data-slot="badge"]' })
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Migrate 1 task' }))
    await screen.findByText('Imported 1')
    fireEvent.click(screen.getByText('View details'))
    expect(screen.getByTitle(items[0].saveDir)).toBeVisible()
    expect(transport.invoke).toHaveBeenCalledWith(Commands.CommitLegacyImport, {
      previewId,
      itemIds: [items[0].itemId],
    })
  })

  it('disables empty selection and running-source commits', async () => {
    render(<LegacyImportDialog open onClose={vi.fn()} />)
    await continueFromSource()
    const checkbox = await screen.findByRole('checkbox', {
      name: 'archive.zip',
    })
    fireEvent.click(checkbox)
    expect(
      screen.getByRole('button', { name: 'Migrate 0 tasks' })
    ).toBeDisabled()
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
      title: 'Migration is incomplete',
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
      await continueFromSource()
      fireEvent.click(
        await screen.findByRole('button', { name: 'Migrate 1 task' })
      )
      expect(
        await screen.findByRole('heading', { name: result.title })
      ).toBeVisible()
      expect(
        screen.queryByRole('heading', { name: 'Migration complete' })
      ).not.toBeInTheDocument()
      expect(screen.getByText(result.description)).toBeVisible()
      expect(
        Boolean(screen.queryByRole('button', { name: 'Migrate remaining' }))
      ).toBe(result.canRetry)
      fireEvent.click(screen.getByText('View details'))
      expect(
        screen.getByText(result.status, { selector: 'span' })
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
    await continueFromSource()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Migrate 1 task' })
    )
    await screen.findByRole('alert')
    expect(screen.getByRole('checkbox', { name: 'archive.zip' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Migrate 1 task' })).toBeEnabled()
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
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(
      screen.getByRole('button', { name: 'Migrate 0 tasks' })
    ).toBeDisabled()
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
    await continueFromSource()
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'archive.zip' })
    )
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
    fireEvent.click(screen.getByRole('button', { name: 'Migrate 1 task' }))
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
    await continueFromSource()
    await screen.findByRole('checkbox', { name: 'archive.zip' })
    fireEvent.click(screen.getByRole('button', { name: 'Choose torrent…' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Migrate 1 task' })
      ).toBeEnabled()
    )
    expect(screen.getByRole('checkbox', { name: 'archive.zip' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Migrate 1 task' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.CommitLegacyImport,
        { previewId, itemIds: [items[0].itemId] }
      )
    )
  })
})
