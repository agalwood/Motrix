import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { holdExitAnimation } from '@test-utils/hold-exit-animation'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MenuConfirmation } from './menu-confirmation'

describe('MenuConfirmation exit', () => {
  it('preserves its request while closing and uses a fresh request when reopened', async () => {
    const run = vi.fn()
    const close = vi.fn()
    const view = render(
      <MenuConfirmation request={{ kind: 'discard', run }} close={close} />
    )
    const dialog = screen.getByRole('dialog')
    const finish = holdExitAnimation(dialog)
    const content = dialog.textContent
    view.rerender(<MenuConfirmation request={null} close={close} />)
    expect(dialog).toHaveAttribute('data-closed')
    expect(dialog.textContent).toBe(content)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(run).not.toHaveBeenCalled()
    await finish()
    view.rerender(
      <MenuConfirmation request={{ kind: 'logout', run }} close={close} />
    )
    expect(screen.getByRole('dialog').textContent).not.toBe(content)
  })
})
