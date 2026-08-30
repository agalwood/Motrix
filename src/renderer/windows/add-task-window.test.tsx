import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { toast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddTaskWindow } from './add-task-window'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

vi.mock('@renderer/hooks/use-adaptive-window-height', () => ({
  useAdaptiveWindowHeight: vi.fn(),
}))

describe('AddTaskWindow', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('en-US')
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetSettings) {
        return { app: { defaultSaveDir: '/downloads' } }
      }
      if (channel === Commands.CreateTask) {
        throw new Error(
          "Error invoking remote method 'command:createTask': AppError: ffmpeg is required to download this video: its video and audio are separate streams that must be muxed. Install ffmpeg (or set MOTRIX_FFMPEG_BIN) and restart Motrix."
        )
      }
      return undefined
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    act(() => toast.close())
    vi.restoreAllMocks()
  })

  it('hosts and displays task creation errors in the standalone window', async () => {
    const user = userEvent.setup()
    const { baseElement } = render(<AddTaskWindow />)

    expect(
      baseElement.querySelector('[aria-label="Notifications"]')
    ).toBeInTheDocument()

    await user.type(
      screen.getByRole('textbox', { name: 'URLs' }),
      'https://example.com/video'
    )
    const downloadButton = screen.getByRole('button', { name: 'Download' })
    await waitFor(() => expect(downloadButton).toBeEnabled())
    await user.click(downloadButton)

    expect(
      await screen.findByText(
        'Failed to create download task: ffmpeg is required to download this video: its video and audio are separate streams that must be muxed. Install ffmpeg (or set MOTRIX_FFMPEG_BIN) and restart Motrix.'
      )
    ).toBeVisible()
    expect(
      screen.queryByText(/Error invoking remote method/u)
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/AppError:/u)).not.toBeInTheDocument()
  })
})
