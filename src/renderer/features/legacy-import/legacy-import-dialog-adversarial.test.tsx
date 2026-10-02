import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyImportDialog } from './legacy-import-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), platform: 'darwin' },
}))

const source = {
  sourceHandle: '11111111-1111-4111-8111-111111111111',
  name: 'Motrix',
}
const item = {
  itemId: 'record',
  name: 'archive.zip',
  type: 'http',
  selectable: true,
  reason: 'fresh-download-required',
}
const preview = {
  previewId: '22222222-2222-4222-8222-222222222222',
  sourceHandle: source.sourceHandle,
  sourceName: source.name,
  items: [item],
  running: false,
  checkpointImportAvailable: false,
  expiresAt: Date.now() + 100000,
}
const run = {
  runId: '33333333-3333-4333-8333-333333333333',
  stage: 'committing',
  processed: 0,
  total: 1,
  imported: 0,
  backupCreated: true,
  items: [{ ...item, outcome: 'unprocessed', taskId: null }],
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  vi.mocked(transport.invoke)
    .mockReset()
    .mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) return [source]
      if (channel === Queries.ScanLegacyImport) return preview
      if (
        channel === Commands.CommitLegacyImport ||
        channel === Queries.GetLegacyImportRun
      )
        return run
      return { ok: true }
    })
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en-US')
})

describe('legacy import UI adversarial state', () => {
  it('preserves the active run when the user changes language', async () => {
    render(<LegacyImportDialog open onClose={vi.fn()} />)
    expect(
      await screen.findByRole('checkbox', { name: 'Select all' })
    ).toBeChecked()
    fireEvent.click(await screen.findByRole('button', { name: /Import 1/ }))
    await screen.findByRole('progressbar')
    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(
          ([channel]) => channel === Queries.DiscoverLegacyImport
        )
    ).toHaveLength(1)
  })

  it('starts a fresh scan after reopening while the previous scan is unresolved', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    let discoveryCalls = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) {
        if (++discoveryCalls === 1)
          return new Promise((resolve) => {
            resolveFirst = resolve
          })
        return [source]
      }
      if (channel === Queries.ScanLegacyImport) return preview
      return { ok: true }
    })
    const close = vi.fn()
    const view = render(<LegacyImportDialog open onClose={close} />)
    await waitFor(() => expect(discoveryCalls).toBe(1))
    view.rerender(<LegacyImportDialog open={false} onClose={close} />)
    view.rerender(<LegacyImportDialog open onClose={close} />)
    await act(async () => {
      resolveFirst([])
    })
    expect(
      await screen.findByRole('checkbox', { name: 'archive.zip' })
    ).toBeChecked()
    expect(discoveryCalls).toBe(2)
  })
})
