import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openMock = vi.fn()
vi.mock(
  '@renderer/components/add-task-dialog/use-add-task-dialog-store',
  () => ({
    useAddTaskDialogStore: { getState: () => ({ openWith: openMock }) },
  })
)

const invokeMock = vi.fn()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...a: unknown[]) => invokeMock(...a),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

import { AddTaskTriggerButton } from './add-task-trigger-button'

function renderWithProviders() {
  return render(
    <TooltipProvider>
      <AddTaskTriggerButton />
    </TooltipProvider>
  )
}

describe('AddTaskTriggerButton', () => {
  beforeEach(() => {
    openMock.mockReset()
    invokeMock.mockReset().mockResolvedValue({ ok: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('opens the AddTaskDialog in web target', () => {
    vi.stubGlobal('__MOTRIX_TARGET__', 'web')
    renderWithProviders()
    fireEvent.click(screen.getByRole('button', { name: /new task/i }))
    expect(openMock).toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('invokes ShowAddTaskWindow IPC in electron target', () => {
    vi.stubGlobal('__MOTRIX_TARGET__', 'electron')
    renderWithProviders()
    fireEvent.click(screen.getByRole('button', { name: /new task/i }))
    expect(invokeMock).toHaveBeenCalledWith('command:showAddTaskWindow', {
      prefill: undefined,
    })
    expect(openMock).not.toHaveBeenCalled()
  })

  it('shares the window-chrome icon opacity treatment', () => {
    renderWithProviders()
    expect(screen.getByRole('button', { name: /new task/i })).toHaveClass(
      '[&>svg]:opacity-65',
      'hover:[&>svg]:opacity-90',
      'focus-visible:[&>svg]:opacity-90'
    )
  })
})
