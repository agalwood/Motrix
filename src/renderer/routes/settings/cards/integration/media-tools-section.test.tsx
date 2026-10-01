import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import {
  useSettingsForm,
  useSettingsSubmit,
} from '@renderer/components/settings-kit/use-settings-form'
import { transport } from '@renderer/lib/transport'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_MEDIA_SETTINGS } from '@shared/schemas'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { FormProvider } from 'react-hook-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { integrationFormSchema } from '../settings-form-schemas'
import type { IntegrationFormValues } from './integration-dialog'
import { MediaToolsSection } from './media-tools-section'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

function TestForm({
  onSave = () => {},
}: {
  onSave?: (values: IntegrationFormValues) => void
}) {
  const form = useSettingsForm<IntegrationFormValues>(integrationFormSchema, {
    app: {
      browserBridgeEnabled: false,
      protocols: { magnet: false },
    },
    media: { ...DEFAULT_MEDIA_SETTINGS },
  })
  const submit = useSettingsSubmit(form, onSave)
  return (
    <FormProvider {...form}>
      <MediaToolsSection />
      <button type="button" onClick={submit}>
        Save
      </button>
    </FormProvider>
  )
}

describe('MediaToolsSection', () => {
  it.each(['darwin', 'linux'])(
    'offers verified one-click install on %s only after consent',
    async (platform) => {
      Object.defineProperty(transport, 'platform', {
        configurable: true,
        value: platform,
      })
      vi.mocked(transport.invoke).mockImplementation(async (channel) =>
        channel === Commands.InstallFfmpeg
          ? { ok: true, releaseVersion: '9.0.2-motrix.2' }
          : channel === Queries.GetFfmpegInstallStatus
            ? {
                phase: 'idle',
                bytesReceived: 0,
                bytesTotal: 0,
                percent: null,
                directory: null,
                releaseVersion: null,
                error: null,
              }
            : { active: null, candidates: [] }
      )
      render(<TestForm />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'Download FFmpeg' })
      )
      expect(transport.invoke).not.toHaveBeenCalledWith(Commands.InstallFfmpeg)
      expect(
        screen.getByText(/GPL-licensed; included licenses/)
      ).toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('button', { name: 'Download and verify' })
      )
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          'Verified and installed.'
        )
      )
    }
  )
  it('mirrors an in-flight download after reopening, shows byte progress, and prevents duplicate operations', async () => {
    Object.defineProperty(transport, 'platform', {
      configurable: true,
      value: 'linux',
    })
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Queries.GetFfmpegInstallStatus
        ? {
            phase: 'downloading',
            bytesReceived: 50,
            bytesTotal: 100,
            percent: 0.5,
            directory: null,
            releaseVersion: '9.0.2-motrix.2',
            error: null,
          }
        : { active: null, candidates: [] }
    )
    render(<TestForm />)
    expect(
      await screen.findByRole('progressbar', {
        name: 'FFmpeg download progress',
      })
    ).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText('50 / 100 bytes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verifying…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Verifying…' }))
    expect(transport.invoke).not.toHaveBeenCalledWith(Commands.InstallFfmpeg)
    expect(transport.on).toHaveBeenCalledWith(
      Events.FfmpegInstallStatusChanged,
      expect.any(Function)
    )
  })
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(transport, 'platform', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('requires an explicit Windows install action and reports failed verification', async () => {
    Object.defineProperty(transport, 'platform', {
      configurable: true,
      value: 'win32',
    })
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Commands.InstallFfmpeg
        ? { ok: false, error: 'verification' }
        : channel === Queries.GetFfmpegInstallStatus
          ? {
              phase: 'idle',
              bytesReceived: 0,
              bytesTotal: 0,
              percent: null,
              directory: null,
              releaseVersion: null,
              error: null,
            }
          : { active: null, candidates: [] }
    )
    render(<TestForm />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download FFmpeg' })
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(Commands.InstallFfmpeg)
    expect(
      screen.getByText(/no public Authenticode signature/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download and verify' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Download or verification failed'
      )
    )
    expect(transport.invoke).toHaveBeenCalledWith(Commands.InstallFfmpeg)
    expect(
      screen.queryByText('Verified and installed.')
    ).not.toBeInTheDocument()
  })

  it('refreshes detection only after successful verified Windows installation', async () => {
    Object.defineProperty(transport, 'platform', {
      configurable: true,
      value: 'win32',
    })
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Commands.InstallFfmpeg
        ? { ok: true, releaseVersion: '9.0.2-motrix.2' }
        : channel === Queries.GetFfmpegInstallStatus
          ? {
              phase: 'idle',
              bytesReceived: 0,
              bytesTotal: 0,
              percent: null,
              directory: null,
              releaseVersion: null,
              error: null,
            }
          : { active: null, candidates: [] }
    )
    render(<TestForm />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download FFmpeg' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download and verify' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Verified and installed.'
      )
    )
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(
          ([channel]) => channel === Queries.GetFfmpegDetection
        )
    ).toHaveLength(2)
  })
  it('keeps a successful install result when the separate detection refresh fails', async () => {
    Object.defineProperty(transport, 'platform', {
      configurable: true,
      value: 'darwin',
    })
    let detections = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Commands.InstallFfmpeg)
        return { ok: true, releaseVersion: '9.0.2-motrix.8' }
      if (channel === Queries.GetFfmpegInstallStatus)
        return {
          phase: 'idle',
          bytesReceived: 0,
          bytesTotal: 0,
          percent: null,
          directory: null,
          releaseVersion: null,
          error: null,
        }
      if (channel === Queries.GetFfmpegDetection && ++detections > 1)
        throw new Error('detection refresh unavailable')
      return { active: null, candidates: [] }
    })
    render(<TestForm />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download FFmpeg' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download and verify' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Verified and installed.'
      )
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t refresh FFmpeg detection'
    )
    expect(
      screen.getByText(
        'Restart Motrix for active plugins to detect the installation.'
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Download or verification failed/)
    ).not.toBeInTheDocument()
  })

  it('places the FFmpeg download action before refresh without a separate card', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      active: null,
      candidates: [],
    })
    render(<TestForm />)

    const card = await screen.findByTestId('media-detection-card')
    const download = within(card).getByRole('link', {
      name: 'Download FFmpeg',
    })
    const refresh = within(card).getByRole('button', { name: 'Refresh' })

    expect(download).toHaveAttribute(
      'href',
      EXTERNAL_URLS.github.ffmpegStaticReleases
    )
    expect(
      download.compareDocumentPosition(refresh) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.queryByText('Motrix static FFmpeg')).not.toBeInTheDocument()
  })

  it('copies the complete Motrix data FFmpeg path when clicked', async () => {
    const managedPath =
      '/Users/example/Library/Application Support/Motrix/ffmpeg/bin/ffmpeg'
    vi.mocked(transport.invoke).mockResolvedValue({
      active: null,
      candidates: [
        { kind: 'manual', path: null, state: 'unconfigured' },
        { kind: 'userData', path: managedPath, state: 'missing' },
      ],
    })
    render(<TestForm />)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Show detection details' })
    )
    const managedPathButton = await screen.findByRole('button', {
      name: 'Copy Motrix FFmpeg path',
    })
    const managedRow = screen.getByTestId('candidate-row-userData')
    expect(within(managedRow).getByText(managedPath)).toHaveAttribute(
      'title',
      managedPath
    )
    expect(managedPathButton).toHaveAttribute('data-size', 'icon-xs')
    expect(managedPathButton.lastElementChild).toHaveAttribute(
      'data-icon',
      'copy'
    )

    fireEvent.click(managedPathButton)

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(managedPath)
    )
  })

  it('edits the custom FFmpeg path directly in the detection row', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      active: null,
      candidates: [
        { kind: 'manual', path: null, state: 'unconfigured' },
        { kind: 'env', path: null, state: 'unconfigured' },
      ],
    })
    render(<TestForm />)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Show detection details' })
    )
    const manualRow = await screen.findByTestId('candidate-row-manual')
    expect(within(manualRow).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(manualRow).getAllByText('Not set')).toHaveLength(2)

    fireEvent.click(
      within(manualRow).getByRole('button', {
        name: 'Edit custom FFmpeg path',
      })
    )
    const input = within(manualRow).getByRole('textbox', {
      name: 'Custom FFmpeg path',
    })

    expect(input).toHaveAttribute('placeholder', 'Not set')
    fireEvent.change(input, { target: { value: '/opt/ffmpeg/bin/ffmpeg' } })
    expect(input).toHaveValue('/opt/ffmpeg/bin/ffmpeg')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(within(manualRow).queryByRole('textbox')).not.toBeInTheDocument()
    )
    expect(within(manualRow).getByText('/opt/ffmpeg/bin/ffmpeg')).toBeVisible()
    expect(
      within(manualRow).getByRole('button', {
        name: 'Edit custom FFmpeg path',
      })
    ).toBeVisible()
    expect(
      within(await screen.findByTestId('candidate-row-env')).queryByRole(
        'textbox'
      )
    ).not.toBeInTheDocument()
  })

  it('shows a macOS trust failure instead of reporting the file as missing', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      active: null,
      candidates: [
        { kind: 'manual', path: null, state: 'unconfigured' },
        {
          kind: 'userData',
          path: '/Users/example/ffmpeg',
          state: 'untrusted',
        },
      ],
    })
    render(<TestForm />)

    expect(
      await screen.findByText('FFmpeg was blocked by macOS')
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show detection details' })
    )
    expect(await screen.findByText('Blocked by macOS')).toBeInTheDocument()
    expect(screen.queryByText('Not found')).not.toBeInTheDocument()
  })

  it.each([
    [
      'media-staging-mb-input',
      '65537',
      'Enter a whole number from 256 to 65536.',
      '2048',
    ],
    [
      'media-op-timeout-sec-input',
      '1.5',
      'Enter a whole number from 60 to 3600.',
      '600',
    ],
  ])(
    'blocks invalid %s and saves its correction',
    async (id, value, message, valid) => {
      vi.mocked(transport.invoke).mockResolvedValue({
        active: null,
        candidates: [],
      })
      const onSave = vi.fn()
      render(<TestForm onSave={onSave} />)
      const input = await screen.findByTestId(id)
      fireEvent.change(input, { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(await screen.findByText(message)).toBeVisible()
      expect(onSave).not.toHaveBeenCalled()
      fireEvent.change(input, { target: { value: valid } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    }
  )

  it('keeps an invalid custom path visible and editable until it is corrected', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      active: null,
      candidates: [],
    })
    const onSave = vi.fn()
    render(<TestForm onSave={onSave} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show detection details' })
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit custom FFmpeg path' })
    )
    const input = screen.getByRole('textbox', { name: 'Custom FFmpeg path' })
    fireEvent.change(input, { target: { value: '/tmp/\0ffmpeg' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(
      await screen.findByText(
        'Remove line breaks or hidden control characters.'
      )
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(input).toBeVisible()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
  })
})
