import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWindowTorrentDrop } from './use-window-torrent-drop'

const mocks = vi.hoisted(() => ({
  dialog: { open: false, openWith: vi.fn() },
  session: { state: 'authenticated' },
  notify: vi.fn(),
  readTorrentFile: vi.fn(),
}))

vi.mock(
  '@renderer/components/add-task-dialog/use-add-task-dialog-store',
  () => ({ useAddTaskDialogStore: { getState: () => mocks.dialog } })
)
vi.mock('@renderer/lib/operator-auth', () => ({
  useOperatorSession: { getState: () => mocks.session },
}))
vi.mock('@renderer/lib/parse-torrent-file', () => ({
  readTorrentFile: mocks.readTorrentFile,
}))
vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ notify: mocks.notify }),
}))

function Harness() {
  useWindowTorrentDrop()
  return null
}

function drop(files: File[], types: string[] = ['Files']) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, types },
  })
  window.dispatchEvent(event)
  return event
}

const torrent = (name = 'a.torrent') => new File(['x'], name)

describe('useWindowTorrentDrop', () => {
  beforeEach(() => {
    mocks.dialog.open = false
    mocks.dialog.openWith.mockReset()
    mocks.session.state = 'authenticated'
    mocks.notify.mockReset()
    mocks.readTorrentFile.mockReset()
    mocks.readTorrentFile.mockImplementation(async (file: File) => ({
      name: file.name,
    }))
  })

  it('opens the torrent tab with the parsed files', async () => {
    render(<Harness />)
    drop([torrent('a.torrent'), torrent('B.TORRENT')])
    await vi.waitFor(() => expect(mocks.dialog.openWith).toHaveBeenCalled())
    expect(mocks.dialog.openWith).toHaveBeenCalledWith({ tab: 'torrent' }, [
      { name: 'a.torrent' },
      { name: 'B.TORRENT' },
    ])
  })

  it('prevents the browser from navigating to a dropped file', () => {
    render(<Harness />)
    expect(drop([torrent()]).defaultPrevented).toBe(true)
  })

  it('ignores drags that carry no files', () => {
    render(<Harness />)
    const event = drop([], ['text/plain'])
    expect(event.defaultPrevented).toBe(false)
    expect(mocks.readTorrentFile).not.toHaveBeenCalled()
  })

  it('ignores files that are not .torrent', async () => {
    render(<Harness />)
    drop([new File(['x'], 'notes.txt')])
    await Promise.resolve()
    expect(mocks.readTorrentFile).not.toHaveBeenCalled()
    expect(mocks.dialog.openWith).not.toHaveBeenCalled()
  })

  it('leaves drops to the dialog while it is open', async () => {
    mocks.dialog.open = true
    render(<Harness />)
    drop([torrent()])
    await Promise.resolve()
    expect(mocks.readTorrentFile).not.toHaveBeenCalled()
    expect(mocks.dialog.openWith).not.toHaveBeenCalled()
  })

  it('does nothing while signed out', async () => {
    mocks.session.state = 'unauthenticated'
    render(<Harness />)
    drop([torrent()])
    await Promise.resolve()
    expect(mocks.readTorrentFile).not.toHaveBeenCalled()
  })

  it('reports a parse failure but still opens with the good files', async () => {
    mocks.readTorrentFile.mockImplementation(async (file: File) => {
      if (file.name === 'bad.torrent') throw new Error('bad')
      return { name: file.name }
    })
    render(<Harness />)
    drop([torrent('bad.torrent'), torrent('ok.torrent')])
    await vi.waitFor(() => expect(mocks.dialog.openWith).toHaveBeenCalled())
    expect(mocks.notify).toHaveBeenCalledWith('error', 'task.add.parseFailed')
    expect(mocks.dialog.openWith).toHaveBeenCalledWith({ tab: 'torrent' }, [
      { name: 'ok.torrent' },
    ])
  })

  it('removes its listeners on unmount', () => {
    const { unmount } = render(<Harness />)
    unmount()
    drop([torrent()])
    expect(mocks.readTorrentFile).not.toHaveBeenCalled()
  })
})
