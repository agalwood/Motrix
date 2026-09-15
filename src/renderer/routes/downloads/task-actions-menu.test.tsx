import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { createSelectionStore } from '@renderer/components/desktop-kit/selection/create-selection-store'
import { toast } from '@renderer/components/ui/toast'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { openMagnetFileSelection } from '@renderer/lib/open-magnet-file-selection'
import { transport } from '@renderer/lib/transport'
import { DownloadErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskActionsMenu } from './task-actions-menu'
import { useDownloadsView } from './view-preferences'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn().mockResolvedValue({ failed: [] }),
    platform: 'darwin',
  },
}))
vi.mock('@renderer/components/ui/toast', () => ({ toast: { add: vi.fn() } }))
vi.mock('@renderer/lib/open-add-task-dialog', () => ({
  openAddTaskDialog: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@renderer/lib/open-magnet-file-selection', () => ({
  openMagnetFileSelection: vi.fn().mockResolvedValue(true),
}))
const tasks = ['a', 'b', 'c'].map((id) =>
  makeDownloadTask({ id, name: id, status: TaskStatus.Paused })
)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(transport).platform = 'darwin'
  useDownloadsView.setState({
    inspectorVisible: false,
    inspectorTab: 'overview',
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

function setup(context = true, items = tasks) {
  const selection = createSelectionStore<DownloadTask>((task) => task.id)
  selection.getState().setItems(items)
  if (items[0]) selection.getState().select(items[0].id)
  if (items[1]) selection.getState().toggle(items[1].id)
  render(
    <TaskActionsMenu tasks={items} selection={selection}>
      {context ? (
        <div data-testid="context-list">
          {items.map((task) => (
            <div data-task-id={task.id} key={task.id}>
              {task.name}
            </div>
          ))}
        </div>
      ) : undefined}
    </TaskActionsMenu>
  )
  return selection
}

describe('TaskActionsMenu', () => {
  it('opens a new task from an empty list without empty task groups', async () => {
    setup(true, [])
    fireEvent.contextMenu(screen.getByTestId('context-list'))
    const item = await screen.findByRole('menuitem', { name: 'New Task…' })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    fireEvent.click(item)
    await waitFor(() => expect(openAddTaskDialog).toHaveBeenCalledWith())
    expect(transport.invoke).not.toHaveBeenCalled()
  })

  it('keeps the selected batch when creating from a row or list whitespace', async () => {
    const selection = setup()
    const user = userEvent.setup()
    for (const target of [
      screen.getByText('b'),
      screen.getByTestId('context-list'),
    ]) {
      fireEvent.contextMenu(target)
      const item = await screen.findByRole('menuitem', { name: 'New Task…' })
      expect(screen.getAllByRole('menuitem').at(-2)).toBe(item)
      await user.click(item)
      await waitFor(() =>
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      )
      expect(selection.getState().committedSelectedIds).toEqual(
        new Set(['a', 'b'])
      )
    }
    expect(openAddTaskDialog).toHaveBeenCalledTimes(2)
    expect(transport.invoke).not.toHaveBeenCalled()
  })

  it('reports a failure to open the new task window', async () => {
    setup(true, [])
    vi.mocked(openAddTaskDialog).mockRejectedValueOnce(
      new Error('Window unavailable')
    )
    fireEvent.contextMenu(screen.getByTestId('context-list'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New Task…' }))
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          description: 'Window unavailable',
        })
      )
    )
  })

  it('keeps view controls available without a selection and exposes details by keyboard', async () => {
    const user = userEvent.setup()
    const selection = setup(false)
    act(() => {
      selection.getState().clearSelection()
      useDownloadsView.getState().setInspectorVisible(false)
    })
    const trigger = screen.getByRole('button', { name: 'More' })
    expect(trigger).toBeEnabled()
    await user.click(trigger)
    expect(
      await screen.findByRole('menuitem', { name: 'List View' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: 'Copy URL' })
    ).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    act(() => selection.getState().select('a'))
    expect(trigger).toBeEnabled()
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.click(
      await screen.findByRole('menuitem', { name: 'Show Inspector' })
    )
    expect(useDownloadsView.getState().inspectorVisible).toBe(true)
    expect(selection.getState().selectedIds).toEqual(new Set(['a']))
  })
  it.each([TaskStatus.Completed, TaskStatus.Finalizing, TaskStatus.Error])(
    'omits empty transfer/queue groups without adjacent separators for %s tasks',
    async (status) => {
      setup(true, [
        makeDownloadTask({ id: 'a', name: 'a', status, type: TaskType.Http }),
      ])
      fireEvent.contextMenu(screen.getByText('a'))
      const menu = await screen.findByRole('menu')
      expect(
        screen.queryByRole('menuitem', { name: 'Move Up in Queue' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('menuitem', { name: 'Move Down in Queue' })
      ).not.toBeInTheDocument()
      const roles = [
        ...menu.querySelectorAll('[role="menuitem"], [role="separator"]'),
      ].map((element) => element.getAttribute('role'))
      expect(roles[0]).toBe('menuitem')
      expect(roles.at(-1)).toBe('menuitem')
      for (const [index, role] of roles.entries()) {
        if (role === 'separator') expect(roles[index + 1]).toBe('menuitem')
      }
    }
  )
  it('copies the captured batch as one clipboard write after selection changes', async () => {
    const selection = setup(
      true,
      tasks.map((task) => ({
        ...task,
        uris: [`https://example.test/${task.id}`],
      }))
    )
    fireEvent.contextMenu(screen.getByText('b'))
    const item = await screen.findByRole('menuitem', { name: 'Copy URLs' })
    act(() => selection.getState().select('c'))
    fireEvent.click(item)
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://example.test/a\nhttps://example.test/b'
      )
    )
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
  })
  it('copies the final file path and reports clipboard failures', async () => {
    setup(true, [
      makeDownloadTask({
        id: 'a',
        name: 'a',
        finalPath: '/downloads/final.bin',
        diskPath: '/downloads/partial.bin',
      }),
    ])
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
      new Error('Clipboard denied')
    )
    fireEvent.contextMenu(screen.getByText('a'))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Copy file path' })
    )
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        '/downloads/final.bin'
      )
    )
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      )
    )
    expect(toast.add).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' })
    )
  })
  it('opens file selection for a magnet whose metadata is ready', async () => {
    setup(true, [
      makeDownloadTask({
        id: 'a',
        name: 'a',
        type: TaskType.Magnet,
        status: TaskStatus.MetadataReady,
      }),
    ])
    fireEvent.contextMenu(screen.getByText('a'))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Select files' })
    )
    await waitFor(() =>
      expect(openMagnetFileSelection).toHaveBeenCalledWith('a')
    )
  })
  it('preserves multi-selection when right-clicking a selected task and sends one batch', async () => {
    const selection = setup()
    fireEvent.contextMenu(screen.getByText('b'))
    await screen.findByRole('menuitem', { name: 'Resume' })
    expect([...selection.getState().committedSelectedIds]).toEqual(['a', 'b'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Commands.ResumeTasks, [
        'a',
        'b',
      ])
    )
  })
  it('targets only an unselected context row', async () => {
    const selection = setup()
    fireEvent.contextMenu(screen.getByText('c'))
    await screen.findByRole('menuitem', { name: 'Resume' })
    expect([...selection.getState().committedSelectedIds]).toEqual(['c'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Commands.ResumeTasks, ['c'])
    )
  })
  it('keeps the removal confirmation bound to the original batch after selection changes', async () => {
    const user = userEvent.setup()
    const selection = setup()
    fireEvent.contextMenu(screen.getByText('b'))
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    act(() => selection.getState().select('c'))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Commands.RemoveTasks, {
        taskIds: ['a', 'b'],
        deleteWithFiles: false,
      })
    )
  })
  it.each([
    ['up', 'Move Up in Queue'],
    ['down', 'Move Down in Queue'],
    ['top', 'Move to Front'],
    ['bottom', 'Move to Back'],
  ] as const)(
    'moves the captured selection %s through the queue submenu',
    async (direction, label) => {
      const user = userEvent.setup()
      setup()
      vi.mocked(transport.invoke).mockResolvedValueOnce({
        moved: ['a', 'b'],
        unchanged: [],
        failed: [],
      })
      fireEvent.contextMenu(screen.getByText('b'))
      await user.click(
        await screen.findByRole('menuitem', { name: 'Download order' })
      )
      fireEvent.click(await screen.findByRole('menuitem', { name: label }))
      await waitFor(() =>
        expect(transport.invoke).toHaveBeenCalledWith(Commands.MoveTasks, {
          taskIds: ['a', 'b'],
          direction,
        })
      )
    }
  )

  it('opens the captured completed file by task id and reports failures', async () => {
    setup(true, [
      makeDownloadTask({
        id: 'a',
        name: 'a',
        status: TaskStatus.Completed,
        fileCount: 1,
        finalPath: '/downloads/a.bin',
      }),
    ])
    vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('File missing'))
    fireEvent.contextMenu(screen.getByText('a'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open file' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Commands.OpenTaskFile, {
        taskId: 'a',
      })
    )
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Could not open file', type: 'error' })
      )
    )
  })

  it.each([TaskStatus.Downloading, TaskStatus.Finalizing, TaskStatus.Error])(
    'does not offer to open a %s output',
    async (status) => {
      setup(true, [
        makeDownloadTask({
          id: 'a',
          name: 'a',
          status,
          fileCount: 1,
          finalPath: '/downloads/a.bin',
        }),
      ])
      fireEvent.contextMenu(screen.getByText('a'))
      await screen.findByRole('menu')
      expect(
        screen.queryByRole('menuitem', { name: 'Open file' })
      ).not.toBeInTheDocument()
    }
  )

  it('opens file selection on the original task after the selection changes', async () => {
    const selection = setup(true, [
      makeDownloadTask({
        id: 'a',
        name: 'a',
        type: TaskType.Bt,
        status: TaskStatus.Paused,
        fileCount: 3,
      }),
      makeDownloadTask({ id: 'b', name: 'b' }),
    ])
    act(() => selection.getState().select('a'))
    fireEvent.contextMenu(screen.getByText('a'))
    const item = await screen.findByRole('menuitem', { name: 'Choose files…' })
    act(() => selection.getState().select('b'))
    fireEvent.click(item)
    expect(useDownloadsView.getState()).toMatchObject({
      inspectorVisible: true,
      inspectorTab: 'files',
    })
    expect(selection.getState().committedSelectedIds).toEqual(new Set(['a']))
    expect(openMagnetFileSelection).not.toHaveBeenCalled()
  })

  it('copies only captured errors with translated reasons and technical details', async () => {
    const selection = setup(true, [
      makeDownloadTask({
        id: 'a',
        name: 'a',
        status: TaskStatus.Error,
        errorCode: DownloadErrorCode.DiskFull,
        errorMessage: 'ENOSPC',
      }),
      makeDownloadTask({ id: 'b', name: 'b', status: TaskStatus.Completed }),
    ])
    fireEvent.contextMenu(screen.getByText('a'))
    const item = await screen.findByRole('menuitem', {
      name: 'Copy error information',
    })
    act(() => selection.getState().select('b'))
    fireEvent.click(item)
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    )
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]
    expect(text).toContain('Task ID: a')
    expect(text).toContain('DL_DISK_FULL')
    expect(text).toContain('ENOSPC')
    expect(text).not.toContain('Task ID: b')
  })

  it('exposes the same actions through the toolbar while the inspector is hidden', async () => {
    setup(false)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Resume' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Commands.ResumeTasks, [
        'a',
        'b',
      ])
    )
  })
})

describe('organized task menu and keyboard actions', () => {
  it('groups completed-task access, clipboard, creation and removal in that order', async () => {
    setup(true, [
      makeDownloadTask({
        id: 'a',
        name: 'a',
        status: TaskStatus.Completed,
        fileCount: 1,
        diskPath: '/downloads/a.bin',
        finalPath: '/downloads/a.bin',
      }),
    ])
    fireEvent.contextMenu(screen.getByText('a'))
    const menu = await screen.findByRole('menu')
    const groups = [...menu.querySelectorAll('[role="group"]')].map((group) =>
      [...group.querySelectorAll('[role="menuitem"]')].map((item) =>
        [...item.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join('')
      )
    )
    expect(groups).toEqual([
      ['Open file', 'Open folder', 'Show Inspector'],
      ['Copy URL', 'Copy file path'],
      ['New Task…'],
      ['Remove'],
    ])
    expect(screen.getByRole('menuitem', { name: 'Copy URL' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Meta+C'
    )
    expect(
      screen.getByRole('menuitem', { name: 'Show Inspector' })
    ).toHaveAttribute('aria-keyshortcuts', 'Meta+I')
    expect(
      menu.querySelector('[data-slot="dropdown-menu-shortcut"]')
    ).toHaveAttribute('aria-hidden', 'true')
    expect(
      screen.getByRole('menuitem', { name: 'Open file' })
    ).not.toHaveAttribute('aria-keyshortcuts')
  })

  it.each(['darwin', 'win32', 'linux'] as const)(
    'copies the selected batch once with the %s primary modifier',
    async (platform) => {
      vi.mocked(transport).platform = platform
      setup(
        true,
        tasks.map((task) => ({
          ...task,
          uris: [`https://example.test/${task.id}`],
        }))
      )
      fireEvent.keyDown(screen.getByTestId('context-list'), {
        key: 'c',
        metaKey: platform === 'darwin',
        ctrlKey: platform !== 'darwin',
      })
      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          'https://example.test/a\nhttps://example.test/b'
        )
      )
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    }
  )

  it('restores the captured selection, toggles the inspector and closes the menu with its shortcut', async () => {
    const selection = setup()
    fireEvent.contextMenu(screen.getByText('b'))
    const menu = await screen.findByRole('menu')
    act(() => selection.getState().select('c'))
    fireEvent.keyDown(menu, { key: 'i', metaKey: true })
    expect(useDownloadsView.getState().inspectorVisible).toBe(true)
    expect(selection.getState().committedSelectedIds).toEqual(
      new Set(['a', 'b'])
    )
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    )
    fireEvent.keyDown(screen.getByTestId('context-list'), {
      key: 'i',
      metaKey: true,
    })
    expect(useDownloadsView.getState().inspectorVisible).toBe(false)
  })

  it.each(['darwin', 'win32'] as const)(
    'opens the existing removal confirmation, with files kept by default, on %s',
    async (platform) => {
      vi.mocked(transport).platform = platform
      const selection = setup()
      fireEvent.keyDown(screen.getByTestId('context-list'), {
        key: platform === 'darwin' ? 'Backspace' : 'Delete',
        metaKey: platform === 'darwin',
      })
      expect(await screen.findByRole('dialog')).toBeInTheDocument()
      expect(transport.invoke).not.toHaveBeenCalled()
      act(() => selection.getState().select('c'))
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
      await waitFor(() =>
        expect(transport.invoke).toHaveBeenCalledWith(Commands.RemoveTasks, {
          taskIds: ['a', 'b'],
          deleteWithFiles: false,
        })
      )
    }
  )

  it('preserves text editing, IME input, extra modifiers and held keys', () => {
    const selection = setup()
    const list = screen.getByTestId('context-list')
    const input = document.createElement('input')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const child = document.createElement('span')
    editable.append(child)
    list.append(input, editable)
    for (const target of [input, child]) {
      fireEvent.keyDown(target, { key: 'i', metaKey: true })
      fireEvent.keyDown(target, { key: 'Backspace', metaKey: true })
      fireEvent.copy(target)
    }
    fireEvent.keyDown(list, { key: 'i', metaKey: true, isComposing: true })
    fireEvent.keyDown(list, { key: 'i', metaKey: true, shiftKey: true })
    fireEvent.keyDown(list, { key: 'i', metaKey: true, repeat: true })
    fireEvent.keyDown(list, { key: 'Backspace' })
    expect(useDownloadsView.getState().inspectorVisible).toBe(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(selection.getState().committedSelectedIds).toEqual(
      new Set(['a', 'b'])
    )
  })

  it('copies the captured batch through a native copy event while the menu is open', async () => {
    const selection = setup(
      true,
      tasks.map((task) => ({
        ...task,
        uris: [`https://example.test/${task.id}`],
      }))
    )
    fireEvent.contextMenu(screen.getByText('b'))
    const item = await screen.findByRole('menuitem', { name: 'Copy URLs' })
    act(() => selection.getState().select('c'))
    fireEvent.copy(item)
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://example.test/a\nhttps://example.test/b'
      )
    )
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    )
  })

  it('supports the same keyboard actions in the More menu', async () => {
    setup(
      false,
      tasks.map((task) => ({
        ...task,
        uris: [`https://example.test/${task.id}`],
      }))
    )
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    const item = await screen.findByRole('menuitem', { name: 'Copy URLs' })
    fireEvent.keyDown(item, { key: 'c', metaKey: true })
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://example.test/a\nhttps://example.test/b'
      )
    )
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    )
  })
})
