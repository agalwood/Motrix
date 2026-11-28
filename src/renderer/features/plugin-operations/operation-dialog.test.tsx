import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { holdExitAnimation } from '@test-utils/hold-exit-animation'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationDialogHost } from './operation-dialog'
import { useOperationDialog } from './operation-store'

vi.mock('./operation-form', () => ({
  default: ({ operationId }: { operationId: string }) => (
    <input aria-label="Operation draft" defaultValue={operationId} />
  ),
}))

describe('OperationDialogHost exit', () => {
  beforeEach(() => useOperationDialog.getState().close())
  it('preserves the mounted draft until exit finishes without retaining the live request', async () => {
    useOperationDialog
      .getState()
      .openWith({ pluginId: 'example', operationId: 'first' })
    render(<OperationDialogHost />)
    const input = await screen.findByRole('textbox', {
      name: 'Operation draft',
    })
    fireEvent.change(input, { target: { value: 'unsaved draft' } })
    const dialog = screen.getByRole('dialog')
    const finish = holdExitAnimation(dialog)
    act(() => useOperationDialog.getState().close())
    expect(useOperationDialog.getState().request).toBeNull()
    expect(dialog).toContainElement(input)
    expect(input).toHaveValue('unsaved draft')
    await finish()
    act(() =>
      useOperationDialog
        .getState()
        .openWith({ pluginId: 'example', operationId: 'second' })
    )
    expect(
      await screen.findByRole('textbox', { name: 'Operation draft' })
    ).toHaveValue('second')
  })
})
