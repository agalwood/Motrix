import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginInputGroup } from './plugin-input-group'

const prepareFile = vi.fn()

function services(withFiles = true): PlatformServices {
  return {
    kind: 'electron',
    ...(withFiles
      ? {
          pluginInstallFile: {
            mode: 'local-path' as const,
            prepare: prepareFile,
          },
        }
      : {}),
    pickSaveDir: vi.fn(),
    closeHost: vi.fn(),
    readClipboard: vi.fn(),
    openExternal: vi.fn(),
    notify: vi.fn(),
  }
}

function renderGroup(onCheck = vi.fn(), checking = false, withFiles = true) {
  return render(
    <PlatformServicesProvider services={services(withFiles)}>
      <PluginInputGroup onCheck={onCheck} checking={checking} />
    </PlatformServicesProvider>
  )
}

describe('PluginInputGroup', () => {
  beforeEach(() => {
    prepareFile.mockReset()
    prepareFile.mockResolvedValue({
      sourceType: 'local',
      absPath: '/abs/foo.moext',
      fileHash: 'a'.repeat(64),
    })
  })

  it('detects github shorthand and enables Check', () => {
    const onCheck = vi.fn()
    renderGroup(onCheck)
    const input = screen.getByPlaceholderText(/Paste a GitHub/i)
    fireEvent.change(input, { target: { value: 'motrix/plugin-video' } })
    expect(screen.getAllByText('GitHub').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByLabelText('Check this plugin'))
    expect(onCheck).toHaveBeenCalledWith({
      sourceType: 'github',
      spec: 'motrix/plugin-video',
    })
  })

  it('uses a multiline prompt input like the shadcn InputGroup reference', () => {
    renderGroup()
    expect(screen.getByPlaceholderText(/Paste a GitHub/i).tagName).toBe(
      'TEXTAREA'
    )
  })

  it('detects URL and shows the URL chip', () => {
    const onCheck = vi.fn()
    renderGroup(onCheck)
    fireEvent.change(screen.getByPlaceholderText(/Paste a GitHub/i), {
      target: { value: 'https://example.com/p.zip' },
    })
    expect(screen.getAllByText('URL').length).toBeGreaterThan(0)
  })

  it('disables Check button for empty/invalid input', () => {
    renderGroup()
    expect(screen.getByLabelText('Check this plugin')).toBeDisabled()
  })

  it('disables file picker when the host omits the file capability', () => {
    renderGroup(vi.fn(), false, false)
    const fileBtn = screen.getByLabelText(
      /Local file install is unavailable in this host/
    )
    expect(fileBtn).toBeDisabled()
  })

  it('shows preparation inside the disabled Check button while pending', () => {
    renderGroup(vi.fn(), true)
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled()
  })

  it('auto-triggers onCheck when a local moext file is picked', async () => {
    const onCheck = vi.fn()
    const { container } = renderGroup(onCheck)
    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], 'foo.moext', {
      type: 'application/zip',
    })
    fireEvent.change(fileInput, { target: { files: [file] } })
    await waitFor(() => expect(onCheck).toHaveBeenCalledTimes(1))
    expect(onCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'local',
        absPath: '/abs/foo.moext',
        fileHash: 'a'.repeat(64),
      })
    )
  })

  it('passes an uploaded Web reference without inventing a local path', async () => {
    prepareFile.mockResolvedValue({
      sourceType: 'upload',
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      fileHash: 'b'.repeat(64),
    })
    const onCheck = vi.fn()
    const { container } = renderGroup(onCheck)
    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 'foo.moext')] },
    })
    await waitFor(() => expect(onCheck).toHaveBeenCalledTimes(1))
    expect(onCheck).toHaveBeenCalledWith({
      sourceType: 'upload',
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      fileHash: 'b'.repeat(64),
    })
  })

  it('shows a host capability error instead of failing silently', async () => {
    prepareFile.mockRejectedValue(new Error('upload is unavailable'))
    const { container } = renderGroup()
    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 'foo.moext')] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /upload is unavailable/
    )
  })

  it('hides the Check button when input is a local moext', () => {
    renderGroup()
    fireEvent.change(screen.getByPlaceholderText(/Paste a GitHub/i), {
      target: { value: 'plugin.moext' },
    })
    expect(screen.queryByLabelText('Check this plugin')).toBeNull()
  })
  it('ignores an upload result after its input is unmounted', async () => {
    let finish!: (value: {
      sourceType: 'upload'
      uploadId: string
      fileHash: string
    }) => void
    prepareFile.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const onCheck = vi.fn()
    const view = renderGroup(onCheck)
    const input = view.container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'foo.moext')] },
    })
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled()
    expect(screen.getByRole('textbox')).toBeDisabled()
    view.unmount()
    await act(async () =>
      finish({
        sourceType: 'upload',
        uploadId: 'old',
        fileHash: 'a'.repeat(64),
      })
    )
    expect(onCheck).not.toHaveBeenCalled()
  })

  it('accepts only one file while an upload is in flight', async () => {
    let finish!: (value: {
      sourceType: 'upload'
      uploadId: string
      fileHash: string
    }) => void
    prepareFile.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const onCheck = vi.fn()
    const view = renderGroup(onCheck)
    const input = view.container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'first.moext')] },
    })
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'second.moext')] },
    })
    expect(prepareFile).toHaveBeenCalledTimes(1)
    await act(async () =>
      finish({
        sourceType: 'upload',
        uploadId: 'first',
        fileHash: 'a'.repeat(64),
      })
    )
    expect(onCheck).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: 'first' })
    )
  })
})
