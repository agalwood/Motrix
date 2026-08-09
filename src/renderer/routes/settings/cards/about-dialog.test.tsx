import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AppUpdateState } from '@shared/types/app-update'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import packageJson from '../../../../../package.json'
import { AboutDialog } from './about-dialog'
import { shouldShowAppUpdate } from './app-update-section'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

const idleState: AppUpdateState = {
  phase: 'idle',
  currentVersion: packageJson.version,
}

beforeEach(() => {
  vi.mocked(transport.invoke).mockReset()
  vi.mocked(transport.on).mockReset()
  vi.mocked(transport.off).mockReset()
  vi.mocked(transport.invoke).mockImplementation(async (channel) => {
    if (channel === Queries.GetUpdateState) return idleState
    if (channel === Queries.GetSettings) {
      return {
        app: { checkForUpdatesOnLaunch: true, updateChannel: 'stable' },
      }
    }
    return { ok: true }
  })
})

function renderDialog(onClose = vi.fn()) {
  render(
    <AboutDialog
      open
      onClose={onClose}
      labelKey="settings.cards.about.title"
      descKey="settings.cards.about.desc"
    />
  )
  return onClose
}

describe('<AboutDialog>', () => {
  it('renders app identity, project metadata and resource links', () => {
    renderDialog()

    expect(
      screen.getByRole('img', { name: 'Motrix app icon' })
    ).toBeInTheDocument()
    expect(screen.getByText(packageJson.productName)).toBeInTheDocument()
    expect(
      screen.getByText(`Version ${packageJson.version}`)
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: packageJson.author.name })
    ).toHaveAttribute('href', EXTERNAL_URLS.github.author)
    expect(screen.queryByText(packageJson.author.email)).not.toBeInTheDocument()
    expect(
      screen.getByText(`${packageJson.license} License`)
    ).toBeInTheDocument()

    expect(
      screen.getByRole('link', { name: /source repository/i })
    ).toHaveAttribute('href', EXTERNAL_URLS.github.repository)
    expect(screen.getByRole('link', { name: /manual/i })).toHaveAttribute(
      'href',
      EXTERNAL_URLS.motrix.manual.home
    )
    expect(screen.getByRole('link', { name: /plugins/i })).toHaveAttribute(
      'href',
      EXTERNAL_URLS.motrix.plugins
    )
    expect(screen.getByRole('link', { name: /changelog/i })).toHaveAttribute(
      'href',
      EXTERNAL_URLS.motrix.changelog
    )
    expect(
      screen.getByRole('link', { name: /official website/i })
    ).toHaveAttribute('href', EXTERNAL_URLS.motrix.home)
    expect(
      screen.getByRole('link', { name: /acknowledgments/i })
    ).toHaveAttribute('href', EXTERNAL_URLS.motrix.acknowledgments)
  })

  it('closes from the footer action', async () => {
    const onClose = renderDialog()

    await userEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('hydrates the desktop update section and checks on demand', async () => {
    renderDialog()

    expect(
      await screen.findByText('Keep Motrix up to date')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        `Version ${packageJson.version} is installed. Check now, or let Motrix check when it opens.`
      )
    ).toBeInTheDocument()
    const checkButton = screen.getByRole('button', {
      name: 'Check for updates',
    })
    expect(checkButton).not.toHaveTextContent('Check for updates')
    expect(checkButton.querySelector('svg')).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Update channel' }).parentElement
    ).toContainElement(checkButton)
    await userEvent.click(checkButton)

    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetUpdateState)
    expect(transport.invoke).toHaveBeenCalledWith(Commands.CheckForUpdates)
  })

  it('offers download when a newer version becomes available', async () => {
    renderDialog()
    await emitState({
      phase: 'available',
      currentVersion: packageJson.version,
      availableVersion: '2.0.1',
    })

    expect(screen.getByText('Motrix 2.0.1 is available')).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Download update' })
    )

    expect(transport.invoke).toHaveBeenCalledWith(Commands.DownloadUpdate)
  })

  it('renders accessible download progress and survives rehydration', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetUpdateState) {
        return {
          phase: 'downloading',
          currentVersion: packageJson.version,
          availableVersion: '2.0.1',
          progress: {
            percent: 45,
            bytesPerSecond: 1024 * 1024,
            transferred: 4.5 * 1024 * 1024,
            total: 10 * 1024 * 1024,
          },
        } satisfies AppUpdateState
      }
      return { ok: true }
    })

    const view = render(
      <AboutDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.about.title"
        descKey="settings.cards.about.desc"
      />
    )

    expect(
      await screen.findByRole('progressbar', {
        name: 'Update download progress',
      })
    ).toHaveAttribute('aria-valuenow', '45')
    expect(screen.getByText('45%')).toBeInTheDocument()

    view.unmount()
    renderDialog()
    expect(
      await screen.findByRole('progressbar', {
        name: 'Update download progress',
      })
    ).toBeInTheDocument()
  })

  it('offers restart only after the update is downloaded', async () => {
    renderDialog()
    await emitState({
      phase: 'downloaded',
      currentVersion: packageJson.version,
      availableVersion: '2.0.1',
    })

    await userEvent.click(
      screen.getByRole('button', { name: 'Restart and install' })
    )

    expect(transport.invoke).toHaveBeenCalledWith(Commands.InstallUpdate)
  })

  it('retries the download after a version-specific error', async () => {
    renderDialog()
    await emitState({
      phase: 'error',
      currentVersion: packageJson.version,
      availableVersion: '2.0.1',
      error: { message: 'network unavailable' },
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Update failed: network unavailable'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(transport.invoke).toHaveBeenCalledWith(Commands.DownloadUpdate)
  })

  it('explains when this build cannot update itself', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetUpdateState) {
        return {
          phase: 'unsupported',
          currentVersion: packageJson.version,
        } satisfies AppUpdateState
      }
      if (channel === Queries.GetSettings) {
        return {
          app: { checkForUpdatesOnLaunch: true, updateChannel: 'stable' },
        }
      }
      return { ok: true }
    })

    renderDialog()

    expect(
      await screen.findByText('Automatic updates unavailable')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'This build of Motrix doesn’t support automatic updates. Download the latest release from the official website.'
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Check for updates' })
    ).not.toBeInTheDocument()
  })

  it('persists the automatic launch check setting from the footer', async () => {
    renderDialog()

    const automaticCheck = await screen.findByRole('switch', {
      name: 'Check automatically',
    })
    await waitFor(() => expect(automaticCheck).toBeEnabled())
    expect(automaticCheck).toBeChecked()

    await userEvent.click(automaticCheck)

    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      app: { checkForUpdatesOnLaunch: false },
    })
  })

  it('persists the beta channel and shows its risk and rollback semantics', async () => {
    renderDialog()

    const channel = await screen.findByRole('combobox', {
      name: 'Update channel',
    })
    await waitFor(() => expect(channel).toBeEnabled())
    await userEvent.click(channel)
    await userEvent.click(await screen.findByRole('option', { name: 'Beta' }))

    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      app: { updateChannel: 'beta' },
    })
    expect(channel).toHaveTextContent('Beta')
    expect(
      screen.getByText(/Beta releases may be less reliable/)
    ).toHaveTextContent(
      'Switching back to Stable stops future betas but never installs an older version automatically.'
    )
  })

  it('keeps release notes out of the compact dialog', () => {
    renderDialog()

    expect(
      screen.queryByRole('heading', { name: /changelog|release notes/i })
    ).not.toBeInTheDocument()
  })

  it('keeps the update form inside a shrinkable scroll region', () => {
    renderDialog()

    expect(screen.getByRole('dialog')).toHaveClass(
      'flex',
      'max-h-[calc(100svh-2rem)]',
      'overflow-hidden'
    )
    expect(screen.getByTestId('about-dialog-scroll')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto'
    )
  })

  it('does not expose app updates to the web target', () => {
    expect(shouldShowAppUpdate('web')).toBe(false)
    expect(shouldShowAppUpdate('electron')).toBe(true)
  })
})

async function emitState(state: AppUpdateState) {
  await waitFor(() => {
    expect(transport.on).toHaveBeenCalledWith(
      Events.UpdateStateChanged,
      expect.any(Function)
    )
  })
  const call = vi
    .mocked(transport.on)
    .mock.calls.find(([event]) => event === Events.UpdateStateChanged)
  await act(async () => {
    call?.[1](state)
  })
}
