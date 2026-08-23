import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { MemoryRouter, Route, Routes } from 'react-router'
import { AddTaskDialogHost } from './add-task-dialog-host'
import { useAddTaskDialogStore } from './use-add-task-dialog-store'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

// Stub AddTaskForm so tests can drive onSubmitSuccess / onCancel directly
// without filling the actual form. The host's contract with the form is
// just those two callbacks plus defaultValues — keeping the stub narrow
// means changes to AddTaskForm internals don't break host tests.
// `submitSuccessRef` exposes the latest onSubmitSuccess so tests can
// simulate the in-flight CreateTask resolving AFTER the user cancelled
// the dialog (the cancelled-submit race the guard in onSubmitSuccess
// protects against).
const submitSuccessRef: {
  current: ((gid: string) => void) | undefined
} = { current: undefined }

vi.mock('@renderer/components/add-task/add-task-form', () => ({
  AddTaskForm: ({
    onSubmitSuccess,
    onCancel,
  }: {
    onSubmitSuccess?: (gid: string) => void
    onCancel: () => void
  }) => {
    submitSuccessRef.current = onSubmitSuccess
    return (
      <div data-testid="add-task-form-stub">
        <button type="button" onClick={() => onSubmitSuccess?.('gid-1')}>
          stub-submit
        </button>
        <button type="button" onClick={onCancel}>
          stub-cancel
        </button>
      </div>
    )
  },
}))

// Mirror production: AppLayout mounts <AddTaskDialogHost /> once ABOVE
// the route Outlet. Route changes swap the route element but never
// unmount the dialog host. Mounting the host outside <Routes> here
// exercises the same lifecycle (no spurious unmount/remount cleanup).
function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AddTaskDialogHost />
      <Routes>
        <Route path="/" element={null} />
        <Route
          path="/downloads/all"
          element={<div data-testid="downloads-route" />}
        />
      </Routes>
    </MemoryRouter>
  )
}

describe('AddTaskDialogHost', () => {
  beforeEach(() => {
    useAddTaskDialogStore.setState({ open: false, prefill: undefined })
    vi.mocked(transport.on).mockClear()
    vi.mocked(transport.off).mockClear()
    vi.mocked(transport.invoke).mockResolvedValue({
      app: { defaultSaveDir: '/downloads' },
    })
    submitSuccessRef.current = undefined
  })

  it('does not render dialog content when store is closed', () => {
    renderWithRouter()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders dialog content when store is open', () => {
    useAddTaskDialogStore.setState({ open: true, prefill: undefined })
    renderWithRouter()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('navigates to the stable task and closes on submit success', () => {
    useAddTaskDialogStore.setState({ open: true, prefill: undefined })
    renderWithRouter()
    expect(screen.queryByTestId('downloads-route')).toBeNull()

    fireEvent.click(screen.getByText('stub-submit'))

    expect(useAddTaskDialogStore.getState().open).toBe(false)
    expect(screen.getByTestId('downloads-route')).toBeInTheDocument()
  })

  it('cancel only closes dialog without navigation', () => {
    useAddTaskDialogStore.setState({ open: true, prefill: undefined })
    renderWithRouter()

    fireEvent.click(screen.getByText('stub-cancel'))

    expect(useAddTaskDialogStore.getState().open).toBe(false)
    expect(screen.queryByTestId('downloads-route')).toBeNull()
  })

  it('does not navigate when dialog was closed before submit resolves', () => {
    // Cancelled-submit race: user clicks Submit (form starts in-flight
    // CreateTask), then closes the dialog (Esc / outside-click) before
    // the IPC resolves. When the resolved callback finally fires, the
    // guard in onSubmitSuccess must skip navigate.
    useAddTaskDialogStore.setState({ open: true, prefill: undefined })
    renderWithRouter()
    const onSubmitSuccess = submitSuccessRef.current
    expect(onSubmitSuccess).toBeDefined()

    // Simulate the user cancelling mid-submit.
    act(() => {
      useAddTaskDialogStore.setState({ open: false })
    })

    // Simulate CreateTask resolving after the cancel.
    act(() => {
      onSubmitSuccess?.('gid-1')
    })

    expect(screen.queryByTestId('downloads-route')).toBeNull()
  })

  it('opens with torrent prefill when magnet metadata selection is forwarded', () => {
    renderWithRouter()
    const onMagnet = vi
      .mocked(transport.on)
      .mock.calls.find(
        ([channel]) => channel === Events.MagnetFileSelection
      )?.[1]
    expect(onMagnet).toBeInstanceOf(Function)

    act(() => {
      onMagnet?.({
        taskId: 'm-pending-123',
        magnetUri: 'magnet:?xt=urn:btih:abc',
        torrentBase64: 'dG9ycmVudA==',
        saveDir: '/downloads',
        meta: {
          name: 'demo',
          infoHash: 'a'.repeat(40),
          totalSize: 1,
          comment: null,
          isPrivate: false,
          files: [
            {
              index: 0,
              path: '/downloads/demo/file.txt',
              size: 1,
              extension: '.txt',
            },
          ],
        },
      })
    })

    expect(useAddTaskDialogStore.getState()).toMatchObject({
      open: true,
      prefill: {
        tab: 'torrent',
        source: 'magnet',
        magnetUri: 'magnet:?xt=urn:btih:abc',
        base64: 'dG9ycmVudA==',
        selectedFiles: [0],
        saveDir: '/downloads',
        // Plan B: existingTaskId threaded so CreateTask handler can
        // swap the magnet_metadata_resolution instance in place.
        existingTaskId: 'm-pending-123',
      },
    })
  })
})
