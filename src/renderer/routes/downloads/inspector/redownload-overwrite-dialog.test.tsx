import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { holdExitAnimation } from '@test-utils/hold-exit-animation'
import { makeDownloadTask } from '@test-utils/task'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RedownloadOverwriteDialog } from './redownload-overwrite-dialog'

describe('RedownloadOverwriteDialog', () => {
  it('finishes its exit with the original task description after the target is cleared', async () => {
    const props = { onOpenChange: vi.fn(), onConfirm: vi.fn() }
    const view = render(
      <RedownloadOverwriteDialog
        open
        target={makeDownloadTask({ name: 'sample.mp4' })}
        {...props}
      />
    )
    const dialog = screen.getByRole('alertdialog')
    const content = dialog.textContent
    const finish = holdExitAnimation(dialog)
    view.rerender(
      <RedownloadOverwriteDialog open={false} target={null} {...props} />
    )
    expect(dialog).toHaveAttribute('data-closed')
    expect(dialog.textContent).toBe(content)
    fireEvent.click(screen.getByRole('button', { name: 'Re-download' }))
    expect(props.onConfirm).not.toHaveBeenCalled()
    await finish()
  })
  it('does not render when target is null', () => {
    const { container } = render(
      <RedownloadOverwriteDialog
        open={true}
        target={null}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders title and description with task name when open', () => {
    const task = makeDownloadTask({ id: 't1', name: 'sample.mp4' })
    render(
      <RedownloadOverwriteDialog
        open={true}
        target={task}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByText('File Already Exists')).toBeDefined()
    expect(
      screen.getByText(
        /“sample\.mp4” already exists in the download directory\./
      )
    ).toBeDefined()
  })

  it('calls onConfirm when confirm button clicked', () => {
    const task = makeDownloadTask({ id: 't1', name: 'sample.mp4' })
    const onConfirm = vi.fn()
    render(
      <RedownloadOverwriteDialog
        open={true}
        target={task}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    const confirmBtn = screen.getByRole('button', { name: 'Re-download' })
    fireEvent.click(confirmBtn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('disables buttons when busy is true', () => {
    const task = makeDownloadTask({ id: 't1', name: 'sample.mp4' })
    render(
      <RedownloadOverwriteDialog
        open={true}
        busy={true}
        target={task}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
    const confirmBtn = screen.getByRole('button', { name: 'Re-download' })
    expect(cancelBtn).toHaveProperty('disabled', true)
    expect(confirmBtn).toHaveProperty('disabled', true)
  })
})
