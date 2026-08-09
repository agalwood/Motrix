import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginInputGroup } from './plugin-input-group'

interface MotrixBridge {
  getPathForFile?: (file: File) => string
}
const originalMotrix = (window as unknown as { motrix?: MotrixBridge }).motrix

describe('PluginInputGroup', () => {
  beforeEach(() => {
    ;(window as unknown as { motrix?: MotrixBridge }).motrix = {
      getPathForFile: vi.fn().mockReturnValue('/abs/foo.moext'),
    }
  })

  afterAll(() => {
    ;(window as unknown as { motrix?: MotrixBridge }).motrix = originalMotrix
  })

  it('detects github shorthand and enables Check', () => {
    const onCheck = vi.fn()
    render(<PluginInputGroup onCheck={onCheck} checking={false} />)
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
    render(<PluginInputGroup onCheck={vi.fn()} checking={false} />)
    expect(screen.getByPlaceholderText(/Paste a GitHub/i).tagName).toBe(
      'TEXTAREA'
    )
  })

  it('detects URL and shows the URL chip', () => {
    const onCheck = vi.fn()
    render(<PluginInputGroup onCheck={onCheck} checking={false} />)
    fireEvent.change(screen.getByPlaceholderText(/Paste a GitHub/i), {
      target: { value: 'https://example.com/p.zip' },
    })
    expect(screen.getAllByText('URL').length).toBeGreaterThan(0)
  })

  it('disables Check button for empty/invalid input', () => {
    render(<PluginInputGroup onCheck={vi.fn()} checking={false} />)
    expect(screen.getByLabelText('Check this plugin')).toBeDisabled()
  })

  it('disables file picker button on web (no getPathForFile bridge)', () => {
    delete (window as unknown as { motrix?: MotrixBridge }).motrix
    render(<PluginInputGroup onCheck={vi.fn()} checking={false} />)
    const fileBtn = screen.getByLabelText(
      /Local file install is only available in the desktop app/
    )
    expect(fileBtn).toBeDisabled()
  })

  it('disables Check while pending', () => {
    render(<PluginInputGroup onCheck={vi.fn()} checking={true} />)
    expect(screen.getByLabelText('Check this plugin')).toBeDisabled()
  })

  it('auto-triggers onCheck when a local moext file is picked', async () => {
    const onCheck = vi.fn()
    const { container } = render(
      <PluginInputGroup onCheck={onCheck} checking={false} />
    )
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
        fileHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    )
  })

  it('hides the Check button when input is a local moext', () => {
    render(<PluginInputGroup onCheck={vi.fn()} checking={false} />)
    fireEvent.change(screen.getByPlaceholderText(/Paste a GitHub/i), {
      target: { value: 'plugin.moext' },
    })
    expect(screen.queryByLabelText('Check this plugin')).toBeNull()
  })
})
