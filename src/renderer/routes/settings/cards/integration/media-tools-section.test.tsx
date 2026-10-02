import '@testing-library/jest-dom/vitest'
import {
  useSettingsForm,
  useSettingsSubmit,
} from '@renderer/components/settings-kit/use-settings-form'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_MEDIA_SETTINGS } from '@shared/schemas'
import type { FfmpegInstallStatus } from '@shared/schemas/ffmpeg-release'
import {
  act,
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

function mockInstallStatus(status: Partial<FfmpegInstallStatus>) {
  Object.defineProperty(transport, 'platform', {
    configurable: true,
    value: 'linux',
  })
  const snapshot: FfmpegInstallStatus = {
    phase: 'downloading',
    bytesReceived: 50,
    bytesTotal: 100,
    percent: 0.5,
    directory: null,
    releaseVersion: '9.0.2-motrix.2',
    error: null,
    ...status,
  }
  vi.mocked(transport.invoke).mockImplementation(async (channel) =>
    channel === Queries.GetFfmpegInstallStatus
      ? snapshot
      : { active: null, candidates: [] }
  )
  return snapshot
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
      expect(screen.getByText(/Motrix build · GPL/)).toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('button', { name: 'Download and verify' })
      )
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          'Verified and installed.'
        )
      )
      expect(
        screen.queryByRole('button', { name: 'Download and verify' })
      ).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Download FFmpeg' }))
      expect(
        screen.getByRole('button', { name: 'Download and verify' })
      ).toBeVisible()
      expect(
        vi
          .mocked(transport.invoke)
          .mock.calls.filter(([channel]) => channel === Commands.InstallFfmpeg)
      ).toHaveLength(1)
    }
  )
  it('mirrors an in-flight download after reopening, shows byte progress, and prevents duplicate operations', async () => {
    mockInstallStatus({})
    render(<TestForm />)
    const progress = await screen.findByRole('progressbar', {
      name: 'FFmpeg download progress',
    })
    expect(progress).toHaveAttribute('aria-valuenow', '50')
    expect(progress).toHaveClass('sr-only', 'absolute!', 'h-px', 'w-px')
    const button = screen.getByRole('button', {
      name: 'Downloading FFmpeg… 50%',
    })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-describedby', progress.id)
    expect(button).toHaveAttribute('title', '50 / 100 bytes')
    expect(button).toHaveTextContent('50%')
    expect(button).not.toHaveTextContent('Downloading FFmpeg…')
    expect(
      button.querySelector('[data-slot="ffmpeg-download-fill"]')
    ).toHaveStyle({ transform: 'scaleX(0.5)' })
    fireEvent.click(button)
    expect(transport.invoke).not.toHaveBeenCalledWith(Commands.InstallFfmpeg)
    expect(transport.on).toHaveBeenCalledWith(
      Events.FfmpegInstallStatusChanged,
      expect.any(Function)
    )
  })
  it.each([
    [0, '0%', 'scaleX(0)'],
    [0.456, '46%', 'scaleX(0.46)'],
    [0.999, '99%', 'scaleX(0.99)'],
    [1, '100%', 'scaleX(1)'],
  ] as const)(
    'fills the download button for progress %s',
    async (percent, label, transform) => {
      mockInstallStatus({ percent })
      render(<TestForm />)
      const button = await screen.findByRole('button', {
        name: `Downloading FFmpeg… ${label}`,
      })
      expect(button).toHaveTextContent(label)
      expect(button).toBeDisabled()
      const fill = button.querySelector('[data-slot="ffmpeg-download-fill"]')
      expect(fill).toHaveStyle({ transform })
      expect(fill).toHaveAttribute('aria-hidden', 'true')
      expect(fill).toHaveClass(
        'transition-transform',
        'motion-reduce:transition-none'
      )
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        label.replace('%', '')
      )
      expect(
        screen.queryByText('Verified and installed.')
      ).not.toBeInTheDocument()
      expect(screen.queryByText(/Motrix build · GPL/)).not.toBeInTheDocument()
    }
  )

  it('does not invent a percentage while the download size is unknown', async () => {
    mockInstallStatus({ bytesTotal: 0, percent: null })
    render(<TestForm />)
    const button = await screen.findByRole('button', {
      name: 'Downloading FFmpeg…',
    })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).not.toHaveAttribute('title')
    const spinner = button.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
    expect(spinner).toHaveClass('motion-reduce:animate-none')
    expect(
      button.querySelector('[data-slot="ffmpeg-download-fill"]')
    ).toBeNull()
    expect(button).not.toHaveTextContent('%')
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  })

  it.each([
    ['metadata', 'Checking the formal release…'],
    ['verifying', 'Verifying the release signature…'],
    ['extracting', 'Verifying and extracting files…'],
    ['systemTrust', 'Checking macOS signing and notarization…'],
    ['installing', 'Installing FFmpeg…'],
  ] as const)(
    'shows the %s phase inside the button without download progress',
    async (phase, label) => {
      mockInstallStatus({ phase, percent: 1 })
      render(<TestForm />)
      const button = await screen.findByRole('button', { name: label })
      expect(button).toHaveTextContent(label)
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-busy', 'true')
      expect(button).not.toHaveAttribute('aria-describedby')
      expect(button.querySelector('.animate-spin')).toBeInTheDocument()
      expect(
        button.querySelector('[data-slot="ffmpeg-download-fill"]')
      ).toBeNull()
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent(label)
    }
  )

  it('updates the same button from download percentage to verification on a transport event', async () => {
    const snapshot = mockInstallStatus({})
    render(<TestForm />)
    const button = await screen.findByRole('button', {
      name: 'Downloading FFmpeg… 50%',
    })
    const listener = vi
      .mocked(transport.on)
      .mock.calls.find(
        ([event]) => event === Events.FfmpegInstallStatusChanged
      )?.[1]
    expect(listener).toBeDefined()
    snapshot.phase = 'verifying'
    snapshot.percent = null
    await act(async () => listener?.())
    expect(
      screen.getByRole('button', { name: 'Verifying the release signature…' })
    ).toBe(button)
    expect(button).toBeDisabled()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(
      button.querySelector('[data-slot="ffmpeg-download-fill"]')
    ).toBeNull()
  })

  it('links to the official FFmpeg manual before install consent', async () => {
    mockInstallStatus({ phase: 'idle', percent: null })
    render(<TestForm />)
    const manual = await screen.findByRole('link', { name: 'FFmpeg manual' })
    expect(manual).toHaveAttribute('href', 'https://motrix.app/manual/ffmpeg/')
    expect(manual).toHaveAttribute('rel', 'noopener noreferrer')
    expect(manual).toHaveAttribute('target', '_blank')
    expect(
      screen.queryByRole('button', { name: 'Download and verify' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download FFmpeg' }))
    expect(
      screen.getByRole('button', { name: 'Download and verify' })
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Download FFmpeg' })
    ).not.toBeInTheDocument()
    expect(manual).toBeInTheDocument()
    expect(transport.invoke).not.toHaveBeenCalledWith(Commands.InstallFfmpeg)
  })

  it.each(['zh-CN', 'zh-TW'])(
    'links to the Chinese FFmpeg manual for %s without English fallback',
    async (locale) => {
      mockInstallStatus({ phase: 'idle', percent: null })
      try {
        await act(async () => i18n.changeLanguage(locale))
        render(<TestForm />)
        const manual = await screen.findByRole('link', {
          name: locale === 'zh-CN' ? 'FFmpeg 手册' : 'FFmpeg 手冊',
        })
        expect(manual).toHaveAttribute(
          'href',
          'https://motrix.app/zh/manual/ffmpeg/'
        )
        expect(
          screen.queryByRole('link', { name: 'FFmpeg manual' })
        ).not.toBeInTheDocument()
      } finally {
        await act(async () => i18n.changeLanguage('en-US'))
      }
    }
  )

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
    expect(screen.getByText(/not Authenticode/)).toBeInTheDocument()
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
      '/Users/example/Library/Application Support/Motrix/binaries/ffmpeg-verified/releases/hash-darwin-arm64/ffmpeg'
    vi.mocked(transport.invoke).mockResolvedValue({
      active: { path: managedPath, version: '9.0.2' },
      candidates: [
        { kind: 'manual', path: null, state: 'unconfigured' },
        {
          kind: 'userData',
          path: managedPath,
          state: 'active',
          version: '9.0.2',
        },
      ],
    })
    render(<TestForm />)

    expect(screen.queryByText(/Save to use this path/)).not.toBeInTheDocument()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show detection details' })
    )
    expect(screen.getByText(/Save to use this path/)).toBeVisible()
    const managedPathButton = await screen.findByRole('button', {
      name: 'Copy Motrix FFmpeg path',
    })
    const managedRow = screen.getByTestId('candidate-row-userData')
    expect(within(managedRow).getByTitle(managedPath)).toHaveAttribute(
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

  it('shows and copies the complete installed directory without hiding its suffix', async () => {
    const directory =
      '/Users/example/Library/Application Support/Motrix/binaries/ffmpeg-verified/releases/hash-darwin-arm64'
    mockInstallStatus({ phase: 'installed', directory, percent: null })
    render(<TestForm />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download FFmpeg' })
    )
    const row = await screen.findByTestId('ffmpeg-installed-directory')
    expect(within(row).getByTitle(directory)).toHaveAttribute(
      'data-slot',
      'middle-ellipsis'
    )
    expect(within(row).getByText('Installed directory:')).toBeVisible()
    fireEvent.click(
      within(row).getByRole('button', { name: 'Copy Motrix FFmpeg path' })
    )
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(directory)
    )
  })

  it.each(['env', 'path'] as const)(
    'keeps the complete %s path in the title',
    async (kind) => {
      const binaryPath = '/opt/media tools/ffmpeg/bin/ffmpeg'
      vi.mocked(transport.invoke).mockResolvedValue({
        active: null,
        candidates: [{ kind, path: binaryPath, state: 'available' }],
      })
      render(<TestForm />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'Show detection details' })
      )
      expect(
        within(screen.getByTestId(`candidate-row-${kind}`)).getByTitle(
          binaryPath
        )
      ).toHaveAttribute('data-slot', 'middle-ellipsis')
    }
  )

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
    expect(input).toHaveAttribute('title', '/opt/ffmpeg/bin/ffmpeg')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(within(manualRow).queryByRole('textbox')).not.toBeInTheDocument()
    )
    expect(within(manualRow).getByText('/opt/ffmpeg/bin/ffmpeg')).toBeVisible()
    expect(
      within(manualRow).getByTitle('/opt/ffmpeg/bin/ffmpeg')
    ).toHaveAttribute('data-slot', 'middle-ellipsis')
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
