import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskColumnHeader } from './task-column-header'

describe('TaskColumnHeader', () => {
  it('renders localized column labels', () => {
    render(
      <TaskColumnHeader
        headerCheckbox={{
          checked: false,
          indeterminate: false,
          onChange: () => {},
        }}
      />
    )
    expect(screen.getByText(/name/i)).toBeInTheDocument()
    expect(screen.getByText(/status/i)).toBeInTheDocument()
  })

  it('covers the full horizontal scroll width on compact viewports', () => {
    render(
      <TaskColumnHeader
        headerCheckbox={{
          checked: false,
          indeterminate: false,
          onChange: () => {},
        }}
      />
    )

    expect(screen.getByText(/name/i).parentElement).toHaveStyle({
      minWidth: '960px',
    })
  })

  it('fires onChange when header checkbox clicked', () => {
    const onChange = vi.fn()
    render(
      <TaskColumnHeader
        headerCheckbox={{ checked: false, indeterminate: false, onChange }}
      />
    )
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalled()
  })
})
