import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { RemoveTaskDialog } from './remove-task-dialog'

describe('RemoveTaskDialog', () => {
  it('renders dialog content when open=true', () => {
    render(
      <RemoveTaskDialog
        open
        taskName="example.iso"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Remove task?')).toBeInTheDocument()
  })

  it('does not render dialog content when open=false', () => {
    render(
      <RemoveTaskDialog
        open={false}
        taskName="example.iso"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('interpolates the task name into the description', () => {
    render(
      <RemoveTaskDialog
        open
        taskName="my-linux-distro.iso"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText(/my-linux-distro\.iso/)).toBeInTheDocument()
  })

  it('calls onConfirm(false) when the checkbox is unchecked', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <RemoveTaskDialog
        open
        taskName="example.iso"
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onConfirm(true) when the delete-files checkbox is checked', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <RemoveTaskDialog
        open
        taskName="example.iso"
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('toggles the checkbox state on click', async () => {
    const user = userEvent.setup()
    render(
      <RemoveTaskDialog
        open
        taskName="example.iso"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toHaveAttribute('aria-checked', 'false')
    await user.click(checkbox)
    expect(checkbox).toHaveAttribute('aria-checked', 'true')
    await user.click(checkbox)
    expect(checkbox).toHaveAttribute('aria-checked', 'false')
  })

  it('calls onClose without onConfirm when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <RemoveTaskDialog
        open
        taskName="example.iso"
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
