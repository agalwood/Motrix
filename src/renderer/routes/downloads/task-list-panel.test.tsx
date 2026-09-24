import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { createSelectionStore } from '@renderer/components/desktop-kit/selection/create-selection-store'
import type { VirtualListProps } from '@renderer/components/desktop-kit/virtual-list/types'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTaskColumns } from './columns'
import { useDownloadsSort } from './store'
import { TaskListPanel } from './task-list-panel'
import { useDownloadsView } from './view-preferences'

vi.mock('@renderer/lib/transport', () => ({
  transport: { platform: 'darwin', on: vi.fn(), off: vi.fn() },
}))

// Render every row in jsdom, which has no viewport measurements. Keep the real
// selection hook and TaskRow so reordering exercises their index callbacks.
vi.mock('@renderer/components/desktop-kit/virtual-list/virtual-list', () => ({
  VirtualList: ({
    items,
    getId,
    renderRow,
    renderHeader,
    scrollRef,
  }: VirtualListProps<DownloadTask>) => (
    <div ref={scrollRef} data-testid="virtual-list-container">
      {renderHeader?.()}
      {items.map((item, index) => (
        <div key={getId(item)}>{renderRow({ item, index, style: {} })}</div>
      ))}
    </div>
  ),
}))

beforeEach(() => {
  vi.clearAllMocks()
  window.getSelection()?.removeAllRanges()
  useDownloadsSort.setState({ sort: null })
  useDownloadsView.setState({
    inspectorVisible: false,
    inspectorSnap: 'medium',
    columns: defaultTaskColumns().map((column) => ({
      ...column,
      visible: true,
    })),
  })
})

function renderTasks(tasks: DownloadTask[]) {
  const selection = createSelectionStore<DownloadTask>((task) => task.id)
  const tree = (items: DownloadTask[]) => (
    <TaskListPanel
      tasks={items}
      hasAnyTasks
      filter="all"
      search=""
      onClearSearch={() => {}}
      selection={selection}
    />
  )
  const view = render(tree(tasks))
  return {
    ...view,
    selection,
    updateTasks: (next: DownloadTask[]) => view.rerender(tree(next)),
  }
}

function visibleNames() {
  return screen
    .getAllByRole('row')
    .filter((row) => row.hasAttribute('data-task-id'))
    .map((row) => row.querySelector('.font-medium')?.textContent)
}

describe('TaskListPanel', () => {
  it('clears pointer selection with Escape without revealing keyboard focus', async () => {
    const user = userEvent.setup()
    const { selection } = renderTasks([
      makeDownloadTask({ id: 'a', name: 'Alpha.bin' }),
      makeDownloadTask({ id: 'b', name: 'Beta.bin' }),
    ])
    const grid = screen.getByRole('grid')
    await user.click(screen.getByRole('row', { name: 'Alpha.bin' }))
    const focusedRow = grid.getAttribute('aria-activedescendant')
    expect(grid).toHaveFocus()
    expect(grid).toHaveAttribute('data-keyboard-focus', 'false')

    await user.keyboard('{Escape}{Escape}')
    expect(selection.getState().selectedIds.size).toBe(0)
    expect(grid).toHaveFocus()
    expect(grid).toHaveAttribute('aria-activedescendant', focusedRow)
    expect(grid).toHaveAttribute('data-keyboard-focus', 'false')

    // Cancellation must not make a later programmatic return look like Tab.
    act(() => screen.getByRole('button', { name: 'Name' }).focus())
    act(() => grid.focus())
    expect(grid).toHaveAttribute('data-keyboard-focus', 'false')
  })

  it('shows focus for row navigation and preserves it on Escape until a pointer action', async () => {
    const user = userEvent.setup()
    renderTasks([
      makeDownloadTask({ id: 'a', name: 'Alpha.bin' }),
      makeDownloadTask({ id: 'b', name: 'Beta.bin' }),
    ])
    const grid = screen.getByRole('grid')
    const alpha = screen.getByRole('row', { name: 'Alpha.bin' })
    await user.click(alpha)
    for (const event of [
      { key: 'Shift' },
      { key: 'a', metaKey: true },
      { key: 'ArrowDown', altKey: true },
      { key: 'a', isComposing: true },
      { key: 'F8' },
    ]) {
      fireEvent.keyDown(grid, event)
      expect(grid).toHaveAttribute('data-keyboard-focus', 'false')
    }
    await user.keyboard('{ArrowDown}')
    expect(grid).toHaveAttribute('data-keyboard-focus', 'true')
    await user.keyboard('{Escape}')
    expect(grid).toHaveAttribute('data-keyboard-focus', 'true')
    await user.click(alpha)
    expect(grid).toHaveAttribute('data-keyboard-focus', 'false')
    await user.keyboard('b')
    expect(grid).toHaveAttribute('data-keyboard-focus', 'true')
    expect(screen.getByRole('row', { name: 'Beta.bin' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it.each([TaskStatus.Paused, TaskStatus.Downloading, TaskStatus.Completed])(
    'opens %s task details only on a plain double click, preserving the chosen height',
    async (status) => {
      const user = userEvent.setup()
      const { selection } = renderTasks([
        makeDownloadTask({ id: 'a', name: 'A.bin', status }),
        makeDownloadTask({ id: 'b', name: 'B.bin' }),
      ])
      const row = screen.getByRole('row', { name: 'A.bin' })
      act(() => useDownloadsView.getState().setInspectorSnap('expanded'))
      await user.click(row)
      expect(selection.getState().selectedIds).toEqual(new Set(['a']))
      expect(useDownloadsView.getState().inspectorVisible).toBe(false)
      await user.dblClick(row)
      expect(useDownloadsView.getState().inspectorVisible).toBe(true)
      expect(useDownloadsView.getState().inspectorSnap).toBe('expanded')
      await user.dblClick(row)
      expect(useDownloadsView.getState().inspectorVisible).toBe(true)

      act(() => useDownloadsView.getState().setInspectorVisible(false))
      await user.click(screen.getByRole('row', { name: 'B.bin' }))
      expect(selection.getState().selectedIds).toEqual(new Set(['b']))
      expect(useDownloadsView.getState().inspectorVisible).toBe(false)
    }
  )

  it('does not open details from modified double clicks, column controls or whitespace', async () => {
    const user = userEvent.setup()
    renderTasks([
      makeDownloadTask({ id: 'a', name: 'A.bin' }),
      makeDownloadTask({ id: 'b', name: 'B.bin' }),
    ])
    const row = screen.getByRole('row', { name: 'A.bin' })
    for (const modifier of ['Meta', 'Control', 'Shift', 'Alt']) {
      await user.keyboard(`{${modifier}>}`)
      await user.dblClick(row)
      await user.keyboard(`{/${modifier}}`)
      expect(useDownloadsView.getState().inspectorVisible).toBe(false)
    }
    await user.dblClick(screen.getByRole('button', { name: 'Name' }))
    await user.dblClick(screen.getByTestId('virtual-list-container'))
    expect(useDownloadsView.getState().inspectorVisible).toBe(false)
  })

  it('clears selection on plain viewport whitespace clicks while preserving header and modified clicks', () => {
    const { selection } = renderTasks([
      makeDownloadTask({ id: 'a', name: 'A.bin' }),
      makeDownloadTask({ id: 'b', name: 'B.bin' }),
    ])
    const viewport = screen.getByTestId('virtual-list-container')
    act(() => selection.getState().selectAll())
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    fireEvent.click(screen.getAllByRole('columnheader')[0])
    fireEvent.click(viewport, { metaKey: true })
    fireEvent.click(viewport, { ctrlKey: true })
    fireEvent.click(viewport, { shiftKey: true })
    expect(selection.getState().selectedIds).toEqual(new Set(['a', 'b']))

    fireEvent.click(viewport)
    expect(selection.getState().selectedIds.size).toBe(0)
    expect(selection.getState().committedSelectedIds.size).toBe(0)
  })

  it('selects the current list from the native menu and removes the listener on unmount', () => {
    const tasks = [1, 2, 3].map((id) =>
      makeDownloadTask({
        id: String(id),
        name: `File ${id}`,
      })
    )
    const { selection, updateTasks, unmount } = renderTasks(tasks)
    const listener = vi
      .mocked(transport.on)
      .mock.calls.find(([channel]) => channel === Events.TaskSelectAll)?.[1]
    expect(listener).toBeTypeOf('function')
    const textRange = document.createRange()
    textRange.selectNodeContents(screen.getByRole('grid'))
    window.getSelection()?.addRange(textRange)
    expect(window.getSelection()?.toString()).not.toBe('')
    act(() => listener?.())
    expect(selection.getState().selectedIds).toEqual(new Set(['1', '2', '3']))
    expect(screen.getByRole('grid')).toHaveFocus()
    expect(window.getSelection()?.toString()).toBe('')

    updateTasks(tasks.slice(1))
    act(() => selection.getState().clearSelection())
    act(() => listener?.())
    expect(selection.getState().selectedIds).toEqual(new Set(['2', '3']))
    expect(window.getSelection()?.toString()).toBe('')
    unmount()
    expect(transport.off).toHaveBeenCalledWith(Events.TaskSelectAll, listener)
  })

  it('keeps new tasks first by default and restores that order after manual sorting', () => {
    const tasks = [
      makeDownloadTask({ id: 'older', name: 'Older', createdAt: 1_000 }),
      makeDownloadTask({ id: 'newer', name: 'Newer', createdAt: 2_000 }),
    ]
    const { updateTasks } = renderTasks(tasks)
    expect(visibleNames()).toEqual(['Newer', 'Older'])
    expect(
      screen.getByRole('button', { name: 'Date created: descending' })
    ).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(
      screen.getByRole('button', { name: 'Date created: descending' })
    )
    expect(visibleNames()).toEqual(['Older', 'Newer'])
    expect(
      screen.getByRole('columnheader', { name: /Date created/ })
    ).toHaveAttribute('aria-sort', 'ascending')
    act(() => useDownloadsSort.getState().resetSort())
    updateTasks([
      ...tasks,
      makeDownloadTask({ id: 'latest', name: 'Latest', createdAt: 3_000 }),
    ])
    expect(visibleNames()).toEqual(['Latest', 'Newer', 'Older'])
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    fireEvent.click(screen.getByRole('button', { name: 'Name: ascending' }))
    expect(visibleNames()).toEqual(['Older', 'Newer', 'Latest'])
    act(() => useDownloadsSort.getState().resetSort())
    expect(visibleNames()).toEqual(['Latest', 'Newer', 'Older'])
    expect(
      screen.getByRole('columnheader', { name: /Date created/ })
    ).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getByRole('button', { name: 'Name' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })
  it('freezes row targets through a pointer gesture while refreshing task data', async () => {
    const a = makeDownloadTask({ id: 'a', name: 'A.bin', sizeWhenDone: 20 })
    const b = makeDownloadTask({ id: 'b', name: 'B.bin', sizeWhenDone: 10 })
    useDownloadsSort.setState({ sort: { column: 'size', direction: 'desc' } })
    const view = renderTasks([a, b])
    const row = screen.getByRole('row', { name: 'A.bin' })
    fireEvent(row, new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    view.updateTasks([
      { ...a, sizeWhenDone: 5 },
      { ...b, sizeWhenDone: 30 },
    ])
    expect(visibleNames()).toEqual(['A.bin', 'B.bin'])
    fireEvent.click(row)
    expect([...view.selection.getState().committedSelectedIds]).toEqual(['a'])
    fireEvent(window, new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    await waitFor(() => expect(visibleNames()).toEqual(['B.bin', 'A.bin']))
    expect(screen.getByRole('row', { name: 'A.bin' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('renders EmptyTasks when filtered task list is empty', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    render(
      <TaskListPanel
        tasks={[]}
        hasAnyTasks={false}
        selection={selection}
        filter="all"
        search=""
        onClearSearch={() => {}}
      />
    )
    expect(screen.getByText(/no downloads yet/i)).toBeInTheDocument()
  })

  it('reorders rows, preserves selection, and uses the new indices for Shift-click and keyboard selection', () => {
    const tasks = [3, 1, 2].map((id) =>
      makeDownloadTask({ id: String(id), name: `File ${id}` })
    )
    const { selection } = renderTasks(tasks)
    fireEvent.click(screen.getByText('File 2'))
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    expect(visibleNames()).toEqual(['File 1', 'File 2', 'File 3'])
    expect([...selection.getState().selectedIds]).toEqual(['2'])
    expect(selection.getState().focusedIndex).toBe(1)

    // File 3 was index 0 before sorting. A memoized stale callback would select
    // File 1 as well when extending this range.
    fireEvent.click(screen.getByText('File 3'), { shiftKey: true })
    expect([...selection.getState().selectedIds]).toEqual(['2', '3'])
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowUp' })
    expect([...selection.getState().selectedIds]).toEqual(['1'])

    fireEvent.click(screen.getByRole('button', { name: 'Name: ascending' }))
    expect(visibleNames()).toEqual(['File 3', 'File 2', 'File 1'])
    fireEvent.click(screen.getByRole('button', { name: 'Name: descending' }))
    expect(visibleNames()).toEqual(['File 1', 'File 2', 'File 3'])
  })

  it('reorders refreshed values and new tasks while updating visible cells', () => {
    const tasks = [
      makeDownloadTask({
        id: 'a',
        name: 'Small',
        sizeWhenDone: 2_000,
        connections: 1,
      }),
      makeDownloadTask({
        id: 'b',
        name: 'Large',
        sizeWhenDone: 10_000,
        connections: 2,
      }),
    ]
    const { updateTasks } = renderTasks(tasks)
    fireEvent.click(screen.getByRole('button', { name: 'Size' }))
    expect(visibleNames()).toEqual(['Large', 'Small'])
    updateTasks([
      { ...tasks[0], name: 'Largest', sizeWhenDone: 30_000, connections: 99 },
      tasks[1],
      makeDownloadTask({ id: 'c', name: 'New', sizeWhenDone: 20_000 }),
    ])
    expect(visibleNames()).toEqual(['Largest', 'New', 'Large'])
    expect(
      screen
        .getAllByRole('row')
        .filter((row) => row.hasAttribute('data-task-id'))[0]
    ).toHaveTextContent('30.00 KB')
    expect(
      screen
        .getAllByRole('row')
        .filter((row) => row.hasAttribute('data-task-id'))[0]
    ).toHaveTextContent('99')
  })

  it('retains the sort across list remounts and select-all follows the visible list', () => {
    const tasks = [2, 1].map((id) =>
      makeDownloadTask({ id: String(id), name: `File ${id}` })
    )
    const first = renderTasks(tasks)
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    first.unmount()
    const { selection } = renderTasks(tasks)
    expect(visibleNames()).toEqual(['File 1', 'File 2'])
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'a', metaKey: true })
    expect([...selection.getState().selectedIds]).toEqual(['1', '2'])
    expect(
      screen
        .getAllByRole('row')
        .filter((row) => row.hasAttribute('data-task-id'))
        .every((row) => row.getAttribute('aria-selected') === 'true')
    ).toBe(true)
  })
})
