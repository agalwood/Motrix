import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { PlatformServices } from '@renderer/platform/services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { AddTaskForm } from './add-task-form'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn().mockResolvedValue({ gid: 'test-gid' }),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

const mockServices: PlatformServices = {
  kind: 'electron',
  pickSaveDir: vi.fn().mockResolvedValue('/picked'),
  closeHost: vi.fn(),
  readClipboard: vi.fn().mockResolvedValue(''),
  openExternal: vi.fn(),
  notify: vi.fn(),
}

function renderForm(props = {}) {
  return render(
    <PlatformServicesProvider services={mockServices}>
      <AddTaskForm
        onCancel={vi.fn()}
        onSubmitSuccess={vi.fn()}
        defaultValues={{ tab: 'links', urls: '', saveDir: '/d' }}
        subscribeEvents={false}
        {...props}
      />
    </PlatformServicesProvider>
  )
}

describe('AddTaskForm', () => {
  afterEach(() => vi.clearAllMocks())

  it('renders links tab by default', () => {
    renderForm()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('disables submit when urls are empty', () => {
    renderForm()
    const submit = screen.getByRole('button', { name: /download/i })
    expect(submit).toBeDisabled()
  })

  it('disables submit when saveDir is empty even if urls are filled', async () => {
    const user = userEvent.setup()
    renderForm({ defaultValues: { tab: 'links', urls: '', saveDir: '' } })

    await user.type(screen.getByRole('textbox'), 'https://a/b')
    const submit = screen.getByRole('button', { name: /download/i })
    expect(submit).toBeDisabled()
  })

  it('cancel button calls onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    renderForm({ onCancel })
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('submit flow calls transport and onSubmitSuccess', async () => {
    const onSubmitSuccess = vi.fn()
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    renderForm({ onSubmitSuccess })

    await user.type(screen.getByRole('textbox'), 'https://a/b')
    await user.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        'command:createTask',
        expect.objectContaining({ type: 'http', uris: ['https://a/b'] })
      )
    )
    expect(onSubmitSuccess).toHaveBeenCalledWith('test-gid')
  })
})
