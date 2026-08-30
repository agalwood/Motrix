import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { DEFAULT_MEDIA_SETTINGS } from '@shared/schemas'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { FormProvider, useForm } from 'react-hook-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationFormValues } from './integration-dialog'
import { MediaToolsSection } from './media-tools-section'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
  },
}))

function TestForm() {
  const form = useForm<IntegrationFormValues>({
    defaultValues: {
      app: {
        browserBridgeEnabled: false,
        protocols: { magnet: false },
      },
      media: { ...DEFAULT_MEDIA_SETTINGS },
    },
  })
  return (
    <FormProvider {...form}>
      <MediaToolsSection />
    </FormProvider>
  )
}

describe('MediaToolsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
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
    expect(managedPathButton.lastElementChild).toHaveClass('lucide-copy')

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
    expect(within(manualRow).queryByRole('textbox')).not.toBeInTheDocument()
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
})
