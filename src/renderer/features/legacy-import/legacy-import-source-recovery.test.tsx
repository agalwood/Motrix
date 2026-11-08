import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyImportDialog } from './legacy-import-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), platform: 'darwin' },
}))
const source = {
  sourceHandle: '11111111-1111-4111-8111-111111111111',
  name: 'Motrix',
  dataPath: '/Users/example/Library/Application Support/Motrix',
}
const preview = {
  previewId: '22222222-2222-4222-8222-222222222222',
  sourceHandle: source.sourceHandle,
  sourceName: source.name,
  items: [],
  running: false,
  checkpointImportAvailable: false,
  expiresAt: Date.now() + 100000,
}
const calls = (channel: string) =>
  vi.mocked(transport.invoke).mock.calls.filter(([name]) => name === channel)
    .length
async function continueFromSource() {
  const button = await screen.findByRole('button', { name: 'Continue' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
}

beforeEach(() => vi.mocked(transport.invoke).mockReset())

describe('migration source recovery', () => {
  it('does not announce a scan while the native folder picker is open', async () => {
    let closePicker!: (result: null) => void
    let finishScan!: (result: typeof preview) => void
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) return [source]
      if (channel === Commands.PickLegacyImportSource)
        return new Promise((resolve) => {
          closePicker = resolve
        })
      if (channel === Queries.ScanLegacyImport)
        return new Promise((resolve) => {
          finishScan = resolve
        })
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await screen.findByRole('radio', { name: source.dataPath })
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose another location…' })
    )
    expect(calls(Commands.PickLegacyImportSource)).toBe(1)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(calls(Queries.ScanLegacyImport)).toBe(0)
    await act(async () => closePicker(null))
    await continueFromSource()
    expect(screen.getByRole('status')).toHaveTextContent('Reading downloads…')
    await act(async () => finishScan(preview))
    await screen.findByRole('heading', { name: 'Choose what to migrate' })
  })

  it.each([
    'invalidSource',
    'unsafeSource',
    'changedSource',
    'sourceNotAuthorized',
  ])(
    'offers folder selection for %s and preserves recovery when the picker is cancelled or fails',
    async (code) => {
      let scans = 0
      let picks = 0
      vi.mocked(transport.invoke).mockImplementation(async (channel) => {
        if (channel === Queries.DiscoverLegacyImport) return [source]
        if (channel === Queries.ScanLegacyImport) {
          if (++scans === 1) throw new Error(`legacyImport.errors.${code}`)
          return preview
        }
        if (channel === Commands.PickLegacyImportSource) {
          if (++picks === 1) return null
          if (picks === 2) throw new Error('legacyImport.invalidSource')
          return source
        }
      })
      render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
      await continueFromSource()
      const notice = await screen.findByRole('alert')
      expect(notice).toHaveTextContent(
        'Unable to read downloads from this location'
      )
      expect(
        screen.getByRole('radio', { name: source.dataPath })
      ).toHaveAttribute('aria-describedby', notice.id)
      expect(
        screen.getByRole('radio', { name: source.dataPath })
      ).toHaveAttribute('aria-disabled', 'true')
      expect(
        screen.queryByRole('button', { name: 'Check again' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Continue' })
      ).not.toBeInTheDocument()
      const choose = screen.getByRole('button', {
        name: 'Choose another location…',
      })
      fireEvent.click(choose)
      await waitFor(() => expect(choose).toBeEnabled())
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Unable to read downloads from this location'
      )
      fireEvent.click(choose)
      await screen.findByText('Unable to use the selected folder')
      expect(
        screen.queryByRole('button', { name: 'Continue' })
      ).not.toBeInTheDocument()
      expect(scans).toBe(1)
      fireEvent.click(choose)
      await continueFromSource()
      await screen.findByRole('heading', { name: 'Choose what to migrate' })
      expect(scans).toBe(2)
      expect(calls(Commands.CommitLegacyImport)).toBe(0)
    }
  )

  it('retains a rejected native path as a disabled row until that folder is successfully selected again', async () => {
    const dataPath = '/Volumes/Backup/Motrix'
    const repaired = {
      ...source,
      dataPath,
      sourceHandle: '33333333-3333-4333-8333-333333333333',
    }
    let picks = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) return [source]
      if (channel === Commands.PickLegacyImportSource) {
        if (++picks === 1) return { dataPath, errorCode: 'invalidSource' }
        if (picks === 2) return null
        return repaired
      }
      if (channel === Queries.ScanLegacyImport)
        return { ...preview, sourceHandle: repaired.sourceHandle }
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await screen.findByRole('radio', { name: source.dataPath })
    const choose = await screen.findByRole('button', {
      name: 'Choose another location…',
    })
    await waitFor(() => expect(choose).toBeEnabled())
    fireEvent.click(choose)
    const rejected = await screen.findByRole('radio', { name: dataPath })
    expect(rejected).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('radio', { name: source.dataPath })).toBeChecked()
    expect(
      screen.getAllByRole('button', { name: 'Show in folder' })[1]
    ).toBeDisabled()
    expect(calls(Queries.ScanLegacyImport)).toBe(0)
    expect(calls(Commands.RevealLegacyImportSource)).toBe(0)
    fireEvent.click(choose)
    await waitFor(() => expect(choose).toBeEnabled())
    expect(rejected).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('alert')).toBeVisible()
    fireEvent.click(choose)
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: dataPath })).not.toHaveAttribute(
        'aria-disabled',
        'true'
      )
    )
    expect(screen.getAllByRole('radio', { name: dataPath })).toHaveLength(1)
    expect(screen.getByRole('radio', { name: dataPath })).toBeChecked()
    await continueFromSource()
    await screen.findByRole('heading', { name: 'Choose what to migrate' })
    expect(calls(Queries.ScanLegacyImport)).toBe(1)
  })

  it('retries a temporary scan failure and advances directly after success', async () => {
    let scans = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) return [source]
      if (channel === Queries.ScanLegacyImport) {
        if (++scans === 1) throw new Error('temporary read failure')
        return preview
      }
      if (channel === Commands.PickLegacyImportSource) return null
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await continueFromSource()
    await screen.findByText(
      'Check that this location is accessible, then try again.'
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose another location…' })
    )
    const retry = screen.getByRole('button', { name: 'Try again' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getByRole('alert')).toBeVisible()
    fireEvent.click(retry)
    await screen.findByRole('heading', { name: 'Choose what to migrate' })
    expect(scans).toBe(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the existing source usable after an unrelated folder selection fails', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) return [source]
      if (channel === Queries.ScanLegacyImport) return preview
      if (channel === Commands.PickLegacyImportSource)
        throw new Error('legacyImport.invalidSource')
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await continueFromSource()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Back to source' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose another location…' })
    )
    await screen.findByText('Unable to use the selected folder')
    expect(screen.getByRole('radio', { name: source.dataPath })).toBeChecked()
    await continueFromSource()
    await screen.findByRole('heading', { name: 'Choose what to migrate' })
    expect(calls(Queries.ScanLegacyImport)).toBe(1)
  })

  it('retries discovery without parsing tasks', async () => {
    let attempts = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) {
        if (++attempts === 1) throw new Error('unavailable')
        return [source]
      }
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await screen.findByText('Unable to look for previous downloads')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    )
    expect(attempts).toBe(2)
    expect(calls(Queries.ScanLegacyImport)).toBe(0)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores a late reveal failure after continuing to task selection', async () => {
    let rejectReveal!: (error: Error) => void
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) return [source]
      if (channel === Queries.ScanLegacyImport) return preview
      if (channel === Commands.RevealLegacyImportSource)
        return new Promise((_resolve, reject) => {
          rejectReveal = reject
        })
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show in folder' })
    )
    await continueFromSource()
    await screen.findByRole('heading', { name: 'Choose what to migrate' })
    await act(async () => rejectReveal(new Error('unavailable')))
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    )
  })

  it('retries reveal without scanning or forgetting that the selected source needs reauthorization', async () => {
    let reveals = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.DiscoverLegacyImport) return [source]
      if (channel === Queries.ScanLegacyImport)
        throw new Error('legacyImport.invalidSource')
      if (channel === Commands.RevealLegacyImportSource && ++reveals === 1)
        throw new Error('unavailable')
    })
    render(<LegacyImportDialog open presentation="page" onClose={vi.fn()} />)
    await continueFromSource()
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    await screen.findByText('Unable to show this folder')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Unable to read downloads from this location')
    expect(
      screen.getByRole('button', { name: 'Choose another location…' })
    ).toBeEnabled()
    expect(calls(Queries.ScanLegacyImport)).toBe(1)
    expect(reveals).toBe(2)
  })
})
