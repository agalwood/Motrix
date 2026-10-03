import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryPicker, type DirectoryPickerProps } from './directory-picker'

const pickSaveDirMock = vi.fn()
const pickFileMock = vi.fn()
const getPathForFileMock = vi.fn()
let localDrop = true
const recordRecentMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@renderer/lib/directory-preferences', () => ({
  recordRecentDirectory: (...args: unknown[]) => recordRecentMock(...args),
}))
vi.mock('./directory-history-menu', () => ({
  DirectoryHistoryMenu: ({
    onSelect,
  }: {
    onSelect: (path: string) => void
  }) => (
    <button type="button" onClick={() => onSelect('/recent ')}>
      History
    </button>
  ),
}))
vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({
    pickSaveDir: pickSaveDirMock,
    pickFile: pickFileMock,
    getPathForFile: localDrop ? getPathForFileMock : undefined,
  }),
}))

interface FormShape {
  dir: string
}

function Wrapper(props: {
  initial: string
  variant: 'compact' | 'input' | 'file'
  options?: Partial<DirectoryPickerProps<FormShape>>
  showHistory?: boolean
  recordRecent?: boolean
  onPickingChange?: (picking: boolean) => void
}) {
  const form = useForm<FormShape>({ defaultValues: { dir: props.initial } })
  return (
    <FormProvider {...form}>
      <DirectoryPicker
        {...props.options}
        name="dir"
        variant={props.variant}
        showHistory={props.showHistory}
        recordRecent={props.recordRecent}
        onPickingChange={props.onPickingChange}
      />
      <div data-testid="value">{form.watch('dir')}</div>
      <div data-testid="dirty">
        {String(form.formState.dirtyFields.dir ?? false)}
      </div>
    </FormProvider>
  )
}

describe('<DirectoryPicker>', () => {
  beforeEach(() => {
    pickSaveDirMock.mockReset()
    pickFileMock.mockReset()
    getPathForFileMock.mockReset()
    localDrop = true
    recordRecentMock.mockClear()
  })

  it('input variant renders input + browse button', () => {
    render(<Wrapper initial="/x" variant="input" />)
    expect(screen.getByDisplayValue('/x')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument()
  })

  it('compact variant renders single button', () => {
    render(<Wrapper initial="/x" variant="compact" />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('/x').length).toBeGreaterThanOrEqual(1)
  })

  it('clicking browse calls pickSaveDir and updates field', async () => {
    pickSaveDirMock.mockResolvedValueOnce('/picked')
    render(<Wrapper initial="" variant="input" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /browse/i }))
    expect(pickSaveDirMock).toHaveBeenCalled()
    expect(screen.getByTestId('value')).toHaveTextContent('/picked')
    expect(recordRecentMock).toHaveBeenCalledWith('/picked')
  })

  it('skips field update when picker returns null', async () => {
    pickSaveDirMock.mockResolvedValueOnce(null)
    render(<Wrapper initial="/keep" variant="input" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /browse/i }))
    expect(screen.getByTestId('value')).toHaveTextContent('/keep')
    expect(recordRecentMock).not.toHaveBeenCalled()
  })

  it('lets a batched settings form stage a selection without persisting recent history', async () => {
    pickSaveDirMock.mockResolvedValueOnce('/draft')
    render(<Wrapper initial="/original" variant="input" recordRecent={false} />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /browse/i }))
    expect(screen.getByTestId('value')).toHaveTextContent('/draft')
    expect(screen.getByTestId('dirty')).toHaveTextContent('true')
    expect(recordRecentMock).not.toHaveBeenCalled()
  })

  it('reports picker activity and ignores a result after its form unmounts', async () => {
    let finish!: (path: string) => void
    const activity = vi.fn()
    pickSaveDirMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    const view = render(
      <Wrapper initial="/original" variant="input" onPickingChange={activity} />
    )
    fireEvent.click(screen.getByRole('button', { name: /browse/i }))
    expect(activity).toHaveBeenCalledWith(true)
    view.unmount()
    await act(async () => finish('/late'))
    expect(recordRecentMock).not.toHaveBeenCalled()
  })

  it('ignores repeated clicks while a picker request is pending', async () => {
    let resolvePick!: (path: string | null) => void
    pickSaveDirMock.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolvePick = resolve
        })
    )
    render(<Wrapper initial="/current" variant="compact" />)
    const button = screen.getByRole('button')

    fireEvent.click(button)
    fireEvent.click(button)

    expect(pickSaveDirMock).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()

    resolvePick('/picked')
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.getByTestId('value')).toHaveTextContent('/picked')

    pickSaveDirMock.mockResolvedValueOnce(null)
    fireEvent.click(button)
    await waitFor(() => expect(pickSaveDirMock).toHaveBeenCalledTimes(2))
  })

  it('enables direct history only when requested and selection is dirty without recording', async () => {
    const { rerender } = render(<Wrapper initial="/x" variant="compact" />)
    expect(
      screen.queryByRole('button', { name: 'History' })
    ).not.toBeInTheDocument()
    rerender(<Wrapper initial="/x" variant="compact" showHistory />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'History' }))
    expect(screen.getByTestId('value').textContent).toBe('/recent ')
    expect(screen.getByTestId('dirty')).toHaveTextContent('true')
    expect(recordRecentMock).not.toHaveBeenCalled()
    expect(pickSaveDirMock).not.toHaveBeenCalled()
  })

  it('does not wait for best-effort history persistence before updating the field', async () => {
    recordRecentMock.mockImplementationOnce(() => new Promise(() => {}))
    pickSaveDirMock.mockResolvedValueOnce('/picked ')
    render(<Wrapper initial="/old" variant="input" />)
    const browse = screen.getByRole('button', { name: /browse/i })
    await userEvent.setup().click(browse)
    expect(screen.getByTestId('value').textContent).toBe('/picked ')
    expect(browse).toBeEnabled()
  })
  it('file card selects through the existing picker and keeps the full path', async () => {
    pickFileMock
      .mockResolvedValueOnce('/media/new.mp4')
      .mockResolvedValueOnce(null)
    render(
      <Wrapper
        initial="/media/old.mp4"
        variant="file"
        options={{ file: { kind: 'open' }, prefixLabel: 'Video' }}
      />
    )
    const card = screen.getByRole('button', { name: 'Video' })
    await userEvent.setup().click(card)
    expect(pickFileMock).toHaveBeenCalledWith({
      kind: 'open',
      defaultPath: '/media/old.mp4',
    })
    expect(card).toHaveAttribute('title', '/media/new.mp4')
    expect(screen.getByText('new.mp4')).toBeVisible()
    expect(screen.getByTestId('dirty')).toHaveTextContent('true')
    await userEvent.setup().click(card)
    expect(card).toHaveAttribute('title', '/media/new.mp4')
    expect(recordRecentMock).not.toHaveBeenCalled()
  })

  it('resolves a dropped file through the host and stops the global torrent drop handler', () => {
    const dropped = new File(['clip'], 'clip.MP4')
    getPathForFileMock.mockReturnValue('/media/clip.MP4')
    const globalDrop = vi.fn()
    window.addEventListener('drop', globalDrop)
    try {
      render(
        <Wrapper
          initial=""
          variant="file"
          options={{
            file: { kind: 'open', extensions: ['mp4'] },
            allowDrop: true,
            prefixLabel: 'Video',
          }}
        />
      )
      fireEvent.drop(screen.getByRole('button', { name: 'Video' }), {
        dataTransfer: { files: [dropped] },
      })
      expect(getPathForFileMock).toHaveBeenCalledWith(dropped)
      expect(screen.getByTestId('value')).toHaveTextContent('/media/clip.MP4')
      expect(screen.getByTestId('dirty')).toHaveTextContent('true')
      expect(globalDrop).not.toHaveBeenCalled()
      expect(pickFileMock).not.toHaveBeenCalled()
      expect(recordRecentMock).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('drop', globalDrop)
    }
  })

  it.each([
    ['multiple files', [new File(['a'], 'a.mp4'), new File(['b'], 'b.mp4')]],
    ['unsupported extension', [new File(['a'], 'a.txt')]],
  ])('keeps the selection when dropping %s', (_label, files) => {
    const onPickError = vi.fn()
    render(
      <Wrapper
        initial="/media/keep.mp4"
        variant="file"
        options={{
          file: { kind: 'open', extensions: ['mp4'] },
          allowDrop: true,
          prefixLabel: 'Video',
          onPickError,
        }}
      />
    )
    fireEvent.drop(screen.getByRole('button', { name: 'Video' }), {
      dataTransfer: { files },
    })
    expect(onPickError).toHaveBeenCalledWith(expect.any(Error))
    expect(getPathForFileMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('value')).toHaveTextContent('/media/keep.mp4')
  })

  it('does not treat a browser file as a server path and still offers server selection', async () => {
    localDrop = false
    const onPickError = vi.fn()
    pickFileMock.mockResolvedValue('/server/clip.mp4')
    render(
      <Wrapper
        initial=""
        variant="file"
        options={{
          file: { kind: 'open' },
          allowDrop: true,
          prefixLabel: 'Video',
          onPickError,
        }}
      />
    )
    const card = screen.getByRole('button', { name: 'Video' })
    expect(screen.queryByText(/Drop a file/)).not.toBeInTheDocument()
    fireEvent.drop(card, {
      dataTransfer: { files: [new File(['clip'], 'clip.mp4')] },
    })
    expect(onPickError).toHaveBeenCalledWith(
      new Error('Choose a file on the server using this picker.')
    )
    expect(screen.getByTestId('value')).toBeEmptyDOMElement()
    await userEvent.setup().click(card)
    expect(screen.getByTestId('value')).toHaveTextContent('/server/clip.mp4')
  })

  it('ignores a disabled drop and reports a missing host path without erasing the selection', () => {
    const onPickError = vi.fn()
    const options = {
      file: { kind: 'open' as const },
      allowDrop: true,
      prefixLabel: 'Video',
      onPickError,
    }
    const view = render(
      <Wrapper
        initial="/keep.mp4"
        variant="file"
        options={{ ...options, disabled: true }}
      />
    )
    const card = screen.getByRole('button', { name: 'Video' })
    const event = { dataTransfer: { files: [new File(['clip'], 'clip.mp4')] } }
    fireEvent.drop(card, event)
    expect(getPathForFileMock).not.toHaveBeenCalled()
    view.rerender(
      <Wrapper initial="/keep.mp4" variant="file" options={options} />
    )
    getPathForFileMock.mockReturnValue(null)
    fireEvent.drop(card, event)
    expect(onPickError).toHaveBeenCalledWith(expect.any(Error))
    expect(screen.getByTestId('value')).toHaveTextContent('/keep.mp4')
  })
})
