import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { AddTaskForm } from '@renderer/components/add-task/add-task-form'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { transport } from '@renderer/lib/transport'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetryParametersDialogHost } from './retry-parameters-dialog-host'
import {
  retryParametersPrefill,
  useRetryParametersStore,
} from './retry-parameters-store'

vi.mock('@renderer/lib/transport', () => ({
  transport: { platform: 'win32', invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))
vi.mock('@renderer/hooks/use-task-list', () => ({
  invalidateTaskList: vi.fn(),
}))
vi.mock('@renderer/lib/directory-preferences', () => ({
  recordRecentDirectory: vi.fn(),
}))
vi.mock('@renderer/components/desktop-kit/directory-history-menu', () => ({
  DirectoryHistoryMenu: () => null,
}))

const services: PlatformServices = {
  kind: 'electron',
  pickSaveDir: vi.fn(),
  closeHost: vi.fn(),
  readClipboard: vi.fn(async () => ''),
  openExternal: vi.fn(),
  notify: vi.fn(),
}
const failedTask = makeDownloadTask({
  id: 'failed',
  name: 'archive.zip',
  finalName: 'archive.zip',
  status: TaskStatus.Error,
  uris: ['https://example.com/archive.zip'],
  saveDir: '/downloads',
  downloadedBytes: 4096,
})
function show(tasks = [failedTask]) {
  useRetryParametersStore.getState().openWith(tasks)
  return renderShell(<RetryParametersDialogHost />)
}
function renderShell(children: ReactNode) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <PlatformServicesProvider services={services}>
          {children}
        </PlatformServicesProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
}
const creations = () =>
  vi
    .mocked(transport.invoke)
    .mock.calls.filter(([channel]) => channel === Commands.CreateTask)

describe('retry parameters dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useRetryParametersStore.getState().close()
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Commands.CreateTask)
        return { outcome: 'created', taskId: 'new-task', gid: 'new-gid' }
      if (channel === Queries.GetSettings)
        return { app: { autofillClipboardLinks: false } }
      return []
    })
  })
  afterEach(() => {
    cleanup()
    useRetryParametersStore.getState().close()
    vi.restoreAllMocks()
  })

  it.each(['Control', 'Meta'])(
    'does not submit the draft underneath a discard confirmation with %s+Enter',
    async (modifier) => {
      show()
      await userEvent.type(screen.getByLabelText('Cookie'), 'unfinished-cookie')
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      const confirmation = screen.getByRole('dialog', {
        name: 'Discard this task draft?',
      })
      const cancel = within(confirmation).getByRole('button', {
        name: 'Cancel',
      })
      cancel.focus()
      await userEvent.keyboard(`{${modifier}>}{Enter}{/${modifier}}`)
      expect(creations()).toHaveLength(0)
      await userEvent.click(cancel)
      await userEvent.click(screen.getByLabelText('Cookie'))
      await userEvent.keyboard(`{${modifier}>}{Enter}{/${modifier}}`)
      await waitFor(() => expect(creations()).toHaveLength(1))
    }
  )

  it('submits only the focused form when multiple task forms are mounted', async () => {
    renderShell(
      <>
        <AddTaskForm
          defaultValues={retryParametersPrefill(failedTask)}
          onCancel={vi.fn()}
        />
        <section data-testid="foreground-form">
          <AddTaskForm
            defaultValues={{
              ...retryParametersPrefill(failedTask),
              urls: 'https://example.com/foreground.zip',
            }}
            onCancel={vi.fn()}
          />
        </section>
      </>
    )
    await userEvent.click(
      within(screen.getByTestId('foreground-form')).getByRole('textbox', {
        name: 'URLs',
      })
    )
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(creations()).toHaveLength(1))
    expect(creations()[0][1]).toMatchObject({
      uris: ['https://example.com/foreground.zip'],
    })
  })

  it('separates retry receipts from the original create and other tasks but recovers its own receipt after reopening', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Commands.CreateTask) throw new Error('Response lost')
      return []
    })
    const original = renderShell(
      <AddTaskForm
        defaultValues={retryParametersPrefill(failedTask)}
        onCancel={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The result is unconfirmed'
      )
    )
    original.unmount()

    for (const task of [
      failedTask,
      failedTask,
      { ...failedTask, id: 'other' },
    ]) {
      const dialog = show([task])
      await userEvent.click(screen.getByRole('button', { name: 'Re-download' }))
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'The result is unconfirmed'
        )
      )
      dialog.unmount()
      useRetryParametersStore.getState().close()
    }
    const requests = creations().map(
      ([, payload]) => payload as { requestId: string }
    )
    expect(requests).toHaveLength(4)
    expect(requests[1]).toEqual({
      ...requests[0],
      requestId: expect.any(String),
    })
    expect(requests[1].requestId).not.toBe(requests[0].requestId)
    expect(requests[2]).toEqual(requests[1])
    expect(requests[3].requestId).not.toBe(requests[1].requestId)
    expect(requests[3].requestId).not.toBe(requests[0].requestId)
  })

  it('collects fresh parameters and creates a separate download without retrying or removing the old task', async () => {
    const original = structuredClone(failedTask)
    show()
    expect(screen.getByRole('dialog', { name: 'Retry download' })).toBeVisible()
    expect(
      screen.getByText(/The failed task and its partial file will be kept/)
    ).toBeVisible()
    expect(
      screen.queryByRole('tab', { name: 'Torrent' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByLabelText('Cookie')).toHaveValue('')
    expect(screen.getByLabelText('Authorization')).toHaveValue('')
    await userEvent.type(
      screen.getByLabelText('Referer'),
      'https://example.com/page'
    )
    await userEvent.type(screen.getByLabelText('Cookie'), 'sid=fresh-cookie')
    await userEvent.type(
      screen.getByLabelText('Authorization'),
      'Bearer fresh-token'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Re-download' }))
    await waitFor(() => expect(creations()).toHaveLength(1))
    expect(creations()[0][1]).toMatchObject({
      type: 'http',
      uris: ['https://example.com/archive.zip'],
      saveDir: '/downloads',
      filename: 'archive.zip',
      requestId: expect.any(String),
      headers: expect.arrayContaining([
        { name: 'Referer', value: 'https://example.com/page' },
        { name: 'Cookie', value: 'sid=fresh-cookie' },
        { name: 'Authorization', value: 'Bearer fresh-token' },
      ]),
    })
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.RetryTasks,
      expect.anything()
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.RemoveTasks,
      expect.anything()
    )
    expect(failedTask).toEqual(original)
    await waitFor(() =>
      expect(useRetryParametersStore.getState().targets).toHaveLength(0)
    )
    expect(JSON.stringify(localStorage)).not.toContain('fresh-cookie')
    expect(JSON.stringify(localStorage)).not.toContain('fresh-token')
  })

  it('does not submit a cancelled draft and clears credentials before reopening', async () => {
    show()
    await userEvent.type(screen.getByLabelText('Cookie'), 'discard-me')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.getByRole('dialog', { name: 'Discard this task draft?' })
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() =>
      expect(useRetryParametersStore.getState().targets).toHaveLength(0)
    )
    expect(creations()).toHaveLength(0)
    act(() => {
      useRetryParametersStore.getState().openWith([failedTask])
    })
    expect(screen.getByLabelText('Cookie')).toHaveValue('')
  })

  it('retains the same submission ID after a lost response without persisting credentials', async () => {
    let tries = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel !== Commands.CreateTask) return []
      if (tries++ === 0) throw new Error('Response lost')
      return { outcome: 'created', taskId: 'new-task', gid: 'new-gid' }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    show()
    await userEvent.type(screen.getByLabelText('Cookie'), 'private-cookie')
    await userEvent.click(screen.getByRole('button', { name: 'Re-download' }))
    await waitFor(() => expect(creations()).toHaveLength(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Re-download' })).toBeEnabled()
    )
    expect(JSON.stringify(localStorage)).not.toContain('private-cookie')
    await userEvent.click(screen.getByRole('button', { name: 'Re-download' }))
    await waitFor(() => expect(creations()).toHaveLength(2))
    expect(creations()[1][1]).toEqual(creations()[0][1])
    vi.mocked(console.error).mockRestore()
  })

  it('keeps a pending submission open and does not carry credentials to the next task', async () => {
    let finish: ((value: unknown) => void) | undefined
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Commands.CreateTask
        ? new Promise((resolve) => {
            finish = resolve
          })
        : []
    )
    show([
      failedTask,
      {
        ...failedTask,
        id: 'second',
        name: 'second.zip',
        finalName: 'second.zip',
      },
    ])
    await userEvent.type(screen.getByLabelText('Cookie'), 'first-only')
    await userEvent.click(screen.getByRole('button', { name: 'Re-download' }))
    await waitFor(() => expect(finish).toBeDefined())
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Close' })
    ).not.toBeInTheDocument()
    expect(useRetryParametersStore.getState().openWith([failedTask])).toBe(
      false
    )
    await act(async () =>
      finish?.({ outcome: 'created', taskId: 'new-task', gid: 'new-gid' })
    )
    await waitFor(() =>
      expect(screen.getByText('Download 2 of 2')).toBeVisible()
    )
    expect(screen.getByLabelText('Cookie')).toHaveValue('')
    expect(screen.getByLabelText('Filename')).toHaveValue('second.zip')
    expect(creations()).toHaveLength(1)
  })
})
