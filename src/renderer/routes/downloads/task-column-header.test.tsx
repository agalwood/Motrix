import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { DirectionProvider } from '@renderer/components/ui/direction'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTaskColumns } from './columns'
import { nextTaskSort, type TaskSort } from './sort'
import { TaskColumnHeader } from './task-column-header'
import { useDownloadsView } from './view-preferences'

beforeEach(() => useDownloadsView.setState({ columns: defaultTaskColumns() }))

describe('TaskColumnHeader', () => {
  it('uses column semantics and only displays the active chevron', async () => {
    const user = userEvent.setup()
    const { container, rerender } = render(
      <TaskColumnHeader sort={null} onSort={() => {}} />
    )
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(container.querySelectorAll('button svg')).toHaveLength(1)
    const created = screen.getByRole('button', {
      name: 'Date created: descending',
    })
    expect(created).toHaveAttribute('aria-pressed', 'true')
    expect(created).toHaveAttribute('title', 'Sort Date created ascending')
    expect(
      screen.getByRole('columnheader', { name: /Date created/ })
    ).toHaveAttribute('aria-sort', 'descending')
    const download = screen.getByRole('button', { name: 'Download speed' })
    expect(download).toHaveTextContent(/^Download$/)
    expect(download).toHaveAttribute('title', 'Sort Download speed descending')
    await user.hover(screen.getByRole('button', { name: 'Name' }))
    expect(container.querySelectorAll('button svg')).toHaveLength(1)
    rerender(
      <TaskColumnHeader
        sort={{ column: 'name', direction: 'asc' }}
        onSort={() => {}}
      />
    )
    expect(container.querySelectorAll('button svg')).toHaveLength(1)
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    )
    expect(
      screen.getByRole('columnheader', { name: /Date created/ })
    ).not.toHaveAttribute('aria-sort')
  })

  it('reverses sorting repeatedly by keyboard without reaching the list handler', async () => {
    const onKeyDown = vi.fn()
    const user = userEvent.setup()
    function Harness() {
      const [sort, setSort] = useState<TaskSort>(null)
      return (
        <div role="listbox" tabIndex={0} onKeyDown={onKeyDown}>
          <TaskColumnHeader
            sort={sort}
            onSort={(column) =>
              setSort((current) => nextTaskSort(current, column))
            }
          />
        </div>
      )
    }
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Name' })
    button.focus()
    await user.keyboard(' ')
    expect(button).toHaveAccessibleName('Name: ascending')
    await user.keyboard('{Enter}')
    expect(button).toHaveAccessibleName('Name: descending')
    await user.keyboard(' ')
    expect(button).toHaveAccessibleName('Name: ascending')
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('allows keyboard resizing and reordering without sorting', () => {
    const onSort = vi.fn()
    render(<TaskColumnHeader sort={null} onSort={onSort} />)
    fireEvent.keyDown(
      screen.getByRole('separator', { name: 'Resize Name column' }),
      { key: 'ArrowRight' }
    )
    expect(useDownloadsView.getState().columns[0].width).toBe(216)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Name' }), {
      key: 'ArrowRight',
      shiftKey: true,
      altKey: true,
    })
    expect(
      useDownloadsView
        .getState()
        .columns.slice(0, 2)
        .map((column) => column.id)
    ).toEqual(['size', 'name'])
    expect(onSort).not.toHaveBeenCalled()
  })

  it('resizes and reorders RTL columns toward their visual neighbor', () => {
    render(
      <DirectionProvider direction="rtl">
        <TaskColumnHeader sort={null} onSort={() => {}} />
      </DirectionProvider>
    )
    fireEvent.keyDown(
      screen.getByRole('separator', { name: 'Resize Name column' }),
      { key: 'ArrowLeft' }
    )
    expect(useDownloadsView.getState().columns[0].width).toBe(216)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Name' }), {
      key: 'ArrowLeft',
      shiftKey: true,
      altKey: true,
    })
    expect(
      useDownloadsView
        .getState()
        .columns.slice(0, 2)
        .map((column) => column.id)
    ).toEqual(['size', 'name'])
  })

  it('opens the shadcn context menu to choose columns', async () => {
    render(<TaskColumnHeader sort={null} onSort={() => {}} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Name' }))
    expect(
      await screen.findByRole('menuitemcheckbox', { name: 'Name' })
    ).toHaveAttribute('aria-disabled', 'true')
    const eta = screen.getByRole('menuitemcheckbox', { name: 'ETA' })
    expect(eta).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(eta)
    expect(
      useDownloadsView.getState().columns.find((column) => column.id === 'eta')
        ?.visible
    ).toBe(false)
  })
})
