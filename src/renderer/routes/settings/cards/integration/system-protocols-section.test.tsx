import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { WindowsDefaultAssociationsSchema } from '@shared/schemas/windows-default-apps'
import type { LinuxDefaultAssociations } from '@shared/types/linux-default-apps'
import type { WindowsDefaultAssociations } from '@shared/types/windows-default-apps'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { FormProvider, useForm } from 'react-hook-form'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationFormValues } from './integration-dialog'
import { SystemProtocolsSection } from './system-protocols-section'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), off: vi.fn(), on: vi.fn(), platform: 'win32' },
}))

let windowsStatus: WindowsDefaultAssociations
let linuxStatus: LinuxDefaultAssociations

const packagedStatus: Extract<
  WindowsDefaultAssociations,
  { authority: 'windows-package' }
> = {
  authority: 'windows-package',
  supported: true,
  registered: null,
  scope: null,
  mainAppAumid: 'Motrix.Store.Test_8wekyb3d8bbwe!Motrix',
  torrent: true,
  magnet: true,
}

const unknownPackagedStatus = {
  ...packagedStatus,
  mainAppAumid: null,
  torrent: null,
  magnet: null,
}

function expectUnknownWindowsStatus() {
  expect(screen.getAllByText('Couldn’t verify')).toHaveLength(2)
  expect(screen.queryByText('Default')).not.toBeInTheDocument()
  expect(screen.queryByText('Not default')).not.toBeInTheDocument()
  expect(screen.queryByText('Setup required')).not.toBeInTheDocument()
}

function renderSection(platform: typeof transport.platform) {
  Object.defineProperty(transport, 'platform', {
    configurable: true,
    value: platform,
  })

  function Harness() {
    const form = useForm<IntegrationFormValues>({
      defaultValues: {
        app: {
          browserBridgeEnabled: true,
          protocols: { magnet: true },
        },
        media: {
          ffmpegBinaryPath: '',
          ffmpegStagingMB: 512,
          ffmpegOpTimeoutSec: 300,
        },
      },
    })
    return (
      <FormProvider {...form}>
        <SystemProtocolsSection />
      </FormProvider>
    )
  }

  return render(<Harness />)
}

describe('<SystemProtocolsSection>', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
    windowsStatus = {
      supported: true,
      registered: true,
      scope: 'user',
      torrent: true,
      magnet: false,
    }
    linuxStatus = {
      supported: true,
      packageKind: 'native',
      registered: true,
      canSetTorrentDefault: true,
      torrent: false,
      magnet: true,
    }
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetWindowsDefaultAssociations) {
        return windowsStatus
      }
      if (channel === Queries.GetLinuxDefaultAssociations) {
        return linuxStatus
      }
      if (channel === Commands.RequestDefaultTorrentHandler) {
        return { ok: true, action: 'set' }
      }
      if (channel === Commands.EnableAppImageIntegration) {
        return { supported: true, status: 'healthy' }
      }
      return { ok: true }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('shows current Windows status and opens the system settings', async () => {
    renderSection('win32')

    expect(
      screen.queryByText('Open magnet links with Motrix')
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Default app for torrents and magnet links')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Requires an installed copy of Motrix/u)
    ).toBeInTheDocument()
    expect(await screen.findByText('Default')).toBeInTheDocument()
    expect(screen.getByText('Not default')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Open Windows settings' })
    )
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.RequestDefaultTorrentHandler
      )
    )
  })

  it('refreshes association status when the window regains focus', async () => {
    windowsStatus = { ...windowsStatus, torrent: false }
    renderSection('win32')
    expect(await screen.findAllByText('Not default')).toHaveLength(2)

    windowsStatus = { ...windowsStatus, torrent: true, magnet: true }
    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => {
      expect(screen.getAllByText('Default')).toHaveLength(2)
    })
  })

  it('explains when the portable ZIP has no installer registration', async () => {
    windowsStatus = { ...windowsStatus, registered: false, scope: null }
    renderSection('win32')

    expect(await screen.findAllByText('Setup required')).toHaveLength(2)
  })

  describe('Windows package defaults', () => {
    it.each([
      [true, true, 'Default', 'Default'],
      [true, false, 'Default', 'Not default'],
      [true, null, 'Default', 'Couldn’t verify'],
      [false, true, 'Not default', 'Default'],
      [false, false, 'Not default', 'Not default'],
      [false, null, 'Not default', 'Couldn’t verify'],
      [null, true, 'Couldn’t verify', 'Default'],
      [null, false, 'Couldn’t verify', 'Not default'],
      [null, null, 'Couldn’t verify', 'Couldn’t verify'],
    ] as const)(
      'shows actual torrent=%s and magnet=%s defaults without installer setup',
      async (torrent, magnet, torrentLabel, magnetLabel) => {
        windowsStatus = { ...packagedStatus, torrent, magnet }
        expect(WindowsDefaultAssociationsSchema.parse(windowsStatus)).toEqual(
          windowsStatus
        )
        renderSection('win32')

        await waitFor(() => {
          expect(
            within(
              screen.getByText('.torrent files').parentElement as HTMLElement
            ).getByText(torrentLabel)
          ).toBeVisible()
          expect(
            within(
              screen.getByText('Magnet links').parentElement as HTMLElement
            ).getByText(magnetLabel)
          ).toBeVisible()
        })
        expect(screen.queryByText('Setup required')).not.toBeInTheDocument()
        expect(
          screen.queryByText('Open magnet links with Motrix')
        ).not.toBeInTheDocument()
      }
    )

    it('keeps loading status until a package query completes', async () => {
      let resolveStatus!: (value: WindowsDefaultAssociations) => void
      vi.mocked(transport.invoke).mockReturnValueOnce(
        new Promise<WindowsDefaultAssociations>((resolve) => {
          resolveStatus = resolve
        })
      )
      renderSection('win32')

      expect(screen.getAllByText('Checking…')).toHaveLength(2)
      expect(screen.queryByText('Setup required')).not.toBeInTheDocument()
      expect(screen.queryByText('Default')).not.toBeInTheDocument()

      await act(async () => resolveStatus(packagedStatus))
      expect(screen.getAllByText('Default')).toHaveLength(2)
    })

    it('treats an unavailable main AUMID as unknown without requesting setup', async () => {
      windowsStatus = unknownPackagedStatus
      renderSection('win32')

      await screen.findAllByText('Couldn’t verify')
      expectUnknownWindowsStatus()
      expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
        Queries.GetWindowsDefaultAssociations
      )
      expect(
        screen.getByRole('button', { name: 'Open Windows settings' })
      ).toBeEnabled()
    })

    it.each([
      ['null response', null],
      ['missing fields', { authority: 'windows-package' }],
      ['string torrent', { ...packagedStatus, torrent: 'true' }],
      ['numeric magnet', { ...packagedStatus, magnet: 0 }],
      ['missing AUMID', { ...packagedStatus, mainAppAumid: undefined }],
      [
        'helper AUMID',
        {
          ...packagedStatus,
          mainAppAumid: 'Motrix.Store.Test_8wekyb3d8bbwe!MotrixNativeHost',
        },
      ],
      [
        'unknown AUMID with default claims',
        { ...packagedStatus, mainAppAumid: null },
      ],
      [
        'installer registration on package',
        { ...packagedStatus, registered: true },
      ],
      ['installer scope on package', { ...packagedStatus, scope: 'user' }],
      ['unsupported package', { ...packagedStatus, supported: false }],
      ['unknown authority', { ...packagedStatus, authority: 'other' }],
      ['extra response fields', { ...packagedStatus, unexpected: true }],
      [
        'legacy non-boolean default',
        {
          supported: true,
          registered: true,
          scope: 'user',
          torrent: 'true',
          magnet: false,
        },
      ],
    ])(
      'rejects %s and performs only one bounded retry',
      async (_name, status) => {
        vi.useFakeTimers()
        expect(WindowsDefaultAssociationsSchema.safeParse(status).success).toBe(
          false
        )
        vi.mocked(transport.invoke).mockResolvedValue(status)

        await act(async () => {
          renderSection('win32')
        })
        expectUnknownWindowsStatus()
        expect(transport.invoke).toHaveBeenCalledTimes(1)

        await act(async () => vi.advanceTimersByTimeAsync(500))
        expectUnknownWindowsStatus()
        expect(transport.invoke).toHaveBeenCalledTimes(2)

        await act(async () => vi.advanceTimersByTimeAsync(1000))
        expect(transport.invoke).toHaveBeenCalledTimes(2)
      }
    )

    it.each(['transport error', 'invalid response'])(
      'clears a prior success on focus %s and recovers on the retry',
      async (failure) => {
        vi.useFakeTimers()
        const invoke = vi.mocked(transport.invoke)
        invoke.mockResolvedValueOnce(packagedStatus)
        if (failure === 'transport error') {
          invoke.mockRejectedValueOnce(new Error('helper unavailable'))
        } else {
          invoke.mockResolvedValueOnce({ ...packagedStatus, torrent: 'true' })
        }
        invoke.mockResolvedValueOnce({ ...packagedStatus, torrent: false })

        await act(async () => {
          renderSection('win32')
        })
        expect(screen.getAllByText('Default')).toHaveLength(2)

        await act(async () => {
          window.dispatchEvent(new Event('focus'))
        })
        expectUnknownWindowsStatus()
        expect(invoke).toHaveBeenCalledTimes(2)

        await act(async () => vi.advanceTimersByTimeAsync(500))
        expect(screen.getByText('Default')).toBeVisible()
        expect(screen.getByText('Not default')).toBeVisible()
        expect(screen.queryByText('Couldn’t verify')).not.toBeInTheDocument()
        expect(screen.queryByText('Setup required')).not.toBeInTheDocument()
        expect(invoke).toHaveBeenCalledTimes(3)

        await act(async () => vi.advanceTimersByTimeAsync(1000))
        expect(invoke).toHaveBeenCalledTimes(3)
      }
    )

    it('does not let an old success overwrite a newer unknown package result', async () => {
      let resolveOld!: (value: WindowsDefaultAssociations) => void
      vi.mocked(transport.invoke)
        .mockReturnValueOnce(
          new Promise<WindowsDefaultAssociations>((resolve) => {
            resolveOld = resolve
          })
        )
        .mockResolvedValueOnce(unknownPackagedStatus)
      renderSection('win32')

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
      })
      expectUnknownWindowsStatus()

      await act(async () => resolveOld(packagedStatus))
      expectUnknownWindowsStatus()
      expect(transport.invoke).toHaveBeenCalledTimes(2)
    })

    it('ignores an old failure after a newer success without retrying it', async () => {
      vi.useFakeTimers()
      let rejectOld!: (error: Error) => void
      vi.mocked(transport.invoke)
        .mockReturnValueOnce(
          new Promise((_resolve, reject) => {
            rejectOld = reject
          })
        )
        .mockResolvedValueOnce(packagedStatus)
      renderSection('win32')

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
      })
      expect(screen.getAllByText('Default')).toHaveLength(2)

      await act(async () => rejectOld(new Error('stale failure')))
      expect(screen.getAllByText('Default')).toHaveLength(2)
      expect(screen.queryByText('Couldn’t verify')).not.toBeInTheDocument()

      await act(async () => vi.advanceTimersByTimeAsync(1000))
      expect(transport.invoke).toHaveBeenCalledTimes(2)
    })
  })

  it('shows live native Linux defaults and offers a verified one-click action', async () => {
    renderSection('linux')

    expect(
      screen.getByText('Open magnet links with Motrix')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Linux file and link associations')
    ).toBeInTheDocument()
    expect(await screen.findByText('Package: deb / rpm')).toBeVisible()
    expect(screen.getByText('Not default')).toBeVisible()
    expect(screen.getByText('Default')).toBeVisible()

    fireEvent.click(
      screen.getByRole('button', { name: 'Set .torrent default' })
    )
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.RequestDefaultTorrentHandler
      )
    )
    expect(
      await screen.findByText('Motrix is now the default for .torrent files.')
    ).toBeVisible()
  })

  it('routes AppImage users to the dedicated desktop integration controls', async () => {
    linuxStatus = {
      ...linuxStatus,
      packageKind: 'appimage',
      canSetTorrentDefault: false,
      torrent: true,
    }
    renderSection('linux')

    expect(await screen.findByText('Package: AppImage')).toBeVisible()
    expect(screen.getByText(/Use Desktop integration below/u)).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Set .torrent default' })
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Applied immediately after saving/u)).toBeVisible()
  })

  it('offers a transaction-safe repair for a legacy AppImage association', async () => {
    linuxStatus = {
      ...linuxStatus,
      packageKind: 'appimage',
      registered: true,
      canSetTorrentDefault: false,
      torrent: false,
    }
    renderSection('linux')

    fireEvent.click(
      await screen.findByRole('button', { name: 'Repair associations' })
    )
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.EnableAppImageIntegration
      )
    )
  })

  it('explains sandbox ownership and distinguishes an unreadable default', async () => {
    linuxStatus = {
      ...linuxStatus,
      packageKind: 'flatpak',
      canSetTorrentDefault: false,
      torrent: null,
      magnet: null,
    }
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetLinuxDefaultAssociations) return linuxStatus
      if (channel === Commands.RequestDefaultTorrentHandler) {
        return { ok: true, action: 'opened-fallback' }
      }
      return { ok: true }
    })
    renderSection('linux')

    expect(await screen.findByText('Package: Flatpak')).toBeVisible()
    expect(screen.getAllByText('Couldn’t verify')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'View setup steps' }))
    expect(
      await screen.findByText(/Setup instructions were opened instead/u)
    ).toBeVisible()
  })
})
