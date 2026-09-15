import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { readTorrentFile } from '@renderer/lib/parse-torrent-file'
import { transport } from '@renderer/lib/transport'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebMenuButton } from './web-menu-button'

vi.mock('@renderer/lib/transport', () => ({
  transport: { platform: 'web', invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))
vi.mock('@renderer/lib/open-add-task-dialog', () => ({
  openAddTaskDialog: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@renderer/lib/parse-torrent-file', () => ({
  readTorrentFile: vi.fn(),
}))
vi.mock('./task-context', () => ({
  captureTaskMenuIntent: () => ({
    ids: [],
    generation: 0,
    selection: new Set(),
  }),
  focusDownloadsList: vi.fn(),
  selectAllDownloads: vi.fn(),
  selectedMenuTasks: () => [],
  subscribeMenuContext: () => () => {},
  menuContextSignature: () => 'stable',
  menuActionEnabled: () => true,
  taskWritesAvailable: () => true,
  startMenuConnection: () => () => {},
}))
function mount(narrow = false) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: narrow,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
  return render(
    <MemoryRouter>
      <WebMenuButton />
    </MemoryRouter>
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  useAddTaskDialogStore.getState().close()
  useOperatorSession.setState({
    state: 'authenticated',
    status: { authed: true, mode: 'cookie', canLogout: true },
  })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.hasPointerCapture = () => false
})
afterEach(() => vi.unstubAllGlobals())
it('renders browser product entries without desktop IPC or reserved accelerators', async () => {
  mount()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Motrix' }))
  await screen.findByRole('menu')
  expect(screen.getByRole('menuitem', { name: 'About Motrix' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: 'Sign out…' })).toBeVisible()
  expect(screen.queryByText(/Quit|Check for Updates|DevTools/)).toBeNull()
  expect(transport.invoke).not.toHaveBeenCalled()
})
it('opens the links form once after the menu closes', async () => {
  mount(true)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Motrix' }))
  await screen.findByRole('menu')
  await user.click(screen.getByRole('menuitem', { name: 'Task' }))
  await user.click(screen.getByRole('menuitem', { name: 'New Task…' }))
  await waitFor(() =>
    expect(openAddTaskDialog).toHaveBeenCalledExactlyOnceWith({ tab: 'links' })
  )
  expect(screen.queryByRole('menu')).toBeNull()
})
it('uses a one-level stack below 640px and Escape returns before closing', async () => {
  mount(true)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Motrix' }))
  await screen.findByRole('menu')
  await user.click(screen.getByRole('menuitem', { name: 'Task' }))
  expect(screen.getAllByRole('menu')).toHaveLength(1)
  expect(screen.getByRole('menuitem', { name: 'Back' })).toBeVisible()
  await user.keyboard('{Escape}')
  expect(screen.getByRole('menuitem', { name: 'About Motrix' })).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
})
it('uses real anchors for help and hides logout for unrestricted access', async () => {
  useOperatorSession.setState({
    status: { authed: true, mode: 'unrestricted', canLogout: false },
  })
  mount(true)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Motrix' }))
  await screen.findByRole('menu')
  expect(screen.queryByRole('menuitem', { name: 'Sign out…' })).toBeNull()
  await user.click(screen.getByRole('menuitem', { name: 'Help' }))
  for (const link of screen
    .getAllByRole('menuitem')
    .filter((element) => element.tagName === 'A')) {
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  }
  expect(
    screen.getAllByRole('menuitem').filter((element) => element.tagName === 'A')
  ).toHaveLength(4)
})
it('activates the browser file input synchronously and passes all parsed files to the form', async () => {
  mount(true)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Motrix' }))
  await screen.findByRole('menu')
  await user.click(screen.getByRole('menuitem', { name: 'Task' }))
  const input = screen.getByLabelText('Open Torrent File…') as HTMLInputElement
  const click = vi.spyOn(input, 'click')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open Torrent File…' }))
  expect(click).toHaveBeenCalledOnce()
  const parsed = {
    name: 'test.torrent',
    base64: 'base64',
    meta: {
      name: 'test',
      infoHash: 'a'.repeat(40),
      totalSize: 1,
      comment: null,
      isPrivate: false,
      files: [{ index: 0, path: 'test', size: 1, extension: '' }],
    },
  }
  vi.mocked(readTorrentFile).mockResolvedValue(parsed)
  fireEvent.change(input, {
    target: {
      files: [
        new File(['one'], 'one.torrent'),
        new File(['two'], 'two.torrent'),
      ],
    },
  })
  await waitFor(() =>
    expect(useAddTaskDialogStore.getState().torrentFiles).toHaveLength(2)
  )
  expect(useAddTaskDialogStore.getState().prefill).toEqual({ tab: 'torrent' })
  expect(input.value).toBe('')
})
