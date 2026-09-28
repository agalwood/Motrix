import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { TaskType } from '@shared/types/task'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  FilterSearchPanel,
  type FilterSearchPanelProps,
} from './filter-search-panel'

const typeCounts = {
  [TaskType.Http]: 2,
  [TaskType.Magnet]: 1,
  [TaskType.Bt]: 1,
  [TaskType.Ftp]: 0,
  [TaskType.Metalink]: 0,
}

function setup(props: Partial<FilterSearchPanelProps> = {}) {
  const onTypesChange = vi.fn()
  render(
    <FilterSearchPanel
      types={[]}
      onTypesChange={onTypesChange}
      typeCounts={typeCounts}
      {...props}
    />
  )
  return { onTypesChange, user: userEvent.setup() }
}

describe('FilterSearchPanel', () => {
  it('adds and removes types without replacing the other selected types', async () => {
    const { user, onTypesChange } = setup({
      types: [TaskType.Bt, TaskType.Http],
    })
    await user.click(screen.getByRole('button', { name: /HTTP/i }))
    expect(onTypesChange).toHaveBeenLastCalledWith([TaskType.Bt])
    await user.click(screen.getByRole('button', { name: /Magnet/i }))
    expect(onTypesChange).toHaveBeenLastCalledWith([
      TaskType.Bt,
      TaskType.Http,
      TaskType.Magnet,
    ])
  })
  it('disables unavailable unselected types but permits clearing a selected zero-count type', async () => {
    const { user, onTypesChange } = setup({ types: [TaskType.Ftp] })
    expect(screen.getByRole('button', { name: /Metalink/i })).toBeDisabled()
    const ftp = screen.getByRole('button', { name: /FTP/i })
    expect(ftp).toBeEnabled()
    expect(ftp).toHaveAttribute('aria-pressed', 'true')
    await user.click(ftp)
    expect(onTypesChange).toHaveBeenCalledWith([])
  })
  it('resets all type filters', async () => {
    const { user, onTypesChange } = setup({
      types: [TaskType.Http, TaskType.Bt],
    })
    await user.click(screen.getByRole('button', { name: 'Reset filters' }))
    expect(onTypesChange).toHaveBeenCalledWith([])
  })
})
