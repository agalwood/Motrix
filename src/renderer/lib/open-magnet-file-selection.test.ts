import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openMagnetFileSelection,
  showMagnetFileSelection,
} from './open-magnet-file-selection'

vi.mock('@renderer/lib/transport', () => ({ transport: { invoke: vi.fn() } }))
const selection = {
  taskId: 'ready',
  magnetUri: 'magnet:?xt=urn:btih:abc',
  torrentBase64: 'dG9ycmVudA==',
  saveDir: '/downloads',
  meta: {
    name: 'demo',
    infoHash: 'a'.repeat(40),
    totalSize: 30,
    comment: null,
    isPrivate: false,
    files: [
      { index: 0, path: 'a.txt', size: 10, extension: '.txt' },
      { index: 1, path: 'b.txt', size: 20, extension: '.txt' },
    ],
  },
}

beforeEach(() => {
  vi.stubGlobal('__MOTRIX_TARGET__', 'web')
  vi.clearAllMocks()
  useAddTaskDialogStore.setState({
    open: false,
    prefill: undefined,
    revision: 0,
  })
  vi.mocked(transport.invoke).mockResolvedValue({ ok: true, selection })
})
afterEach(() => vi.unstubAllGlobals())

describe('openMagnetFileSelection', () => {
  it('opens from the HTTP response without any WebSocket event', async () => {
    await expect(openMagnetFileSelection('ready')).resolves.toBe(true)
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.ReopenMagnetFileSelection,
      'ready'
    )
    expect(useAddTaskDialogStore.getState().prefill).toMatchObject({
      existingTaskId: 'ready',
      selectedFiles: [0, 1],
      base64: selection.torrentBase64,
    })
  })

  it('does not reset edits if the matching selection is already displayed', async () => {
    showMagnetFileSelection(selection)
    useAddTaskDialogStore
      .getState()
      .openWith({ existingTaskId: 'ready', tab: 'torrent', selectedFiles: [1] })
    const revision = useAddTaskDialogStore.getState().revision
    await openMagnetFileSelection('ready')
    expect(useAddTaskDialogStore.getState().revision).toBe(revision)
    expect(useAddTaskDialogStore.getState().prefill).toMatchObject({
      selectedFiles: [1],
    })
  })

  it('ignores a stale task selection', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({ ok: true, selection: null })
    await expect(openMagnetFileSelection('ready')).resolves.toBe(false)
    expect(useAddTaskDialogStore.getState().open).toBe(false)
  })

  it('reports malformed responses instead of silently claiming success', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({ ok: true })
    await expect(openMagnetFileSelection('ready')).rejects.toThrow()
  })

  it('retains the desktop window command flow', async () => {
    vi.stubGlobal('__MOTRIX_TARGET__', 'electron')
    vi.mocked(transport.invoke).mockResolvedValue(undefined)
    await openMagnetFileSelection('ready')
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.ReopenMagnetFileSelection,
      'ready'
    )
    expect(useAddTaskDialogStore.getState().open).toBe(false)
  })
})
