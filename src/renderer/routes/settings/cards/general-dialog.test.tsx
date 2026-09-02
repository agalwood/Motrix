import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted alongside vi.mock so the factory can reference it without TDZ.
const transportMock = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  off: vi.fn(),
  platform: 'darwin' as NodeJS.Platform | 'web',
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: transportMock,
}))

vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ pickSaveDir: vi.fn() }),
}))

import { transport } from '@renderer/lib/transport'
import { GeneralDialog } from './general-dialog'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SETTINGS_FIXTURE = {
  app: {
    launchAtStartup: false,
    defaultSaveDir: '/Users/me/Downloads',
    notifyOnComplete: true,
    notifyOnError: true,
    warnBeforeQuit: true,
    autofillClipboardLinks: true,
    protocols: { magnet: true },
    runMode: 1, // RunMode.Standard — numeric enum
    theme: 'system',
    language: 'en-US',
    traySpeedometer: false,
    magnetFileSelection: true,
  },
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  transportMock.platform = 'darwin'
  vi.mocked(transport.invoke).mockReset()
  vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
    if (channel === Queries.GetSettings) return SETTINGS_FIXTURE
    return { saved: true, requiresRestart: false, changedRestartKeys: [] }
  })
})

describe('<GeneralDialog>', () => {
  it('hydrates from GetSettings', async () => {
    render(
      <GeneralDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.general.title"
        descKey="settings.cards.general.desc"
      />
    )
    await waitFor(() => {
      expect(
        screen.getByDisplayValue('/Users/me/Downloads')
      ).toBeInTheDocument()
    })
  })

  it('saves warnBeforeQuit when toggled', async () => {
    render(<GeneralDialog open onClose={() => {}} labelKey="" descKey="" />)

    const toggle = await screen.findByRole('switch', {
      name: /confirm before quitting/i,
    })
    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
        app: { warnBeforeQuit: false },
      })
    })
  })

  it('hides host startup and quit controls in the web client', async () => {
    transportMock.platform = 'web'
    render(<GeneralDialog open onClose={() => {}} labelKey="" descKey="" />)

    await waitFor(() =>
      expect(
        screen.getByDisplayValue('/Users/me/Downloads')
      ).toBeInTheDocument()
    )
    expect(
      screen.queryByRole('switch', { name: /launch at startup/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: /confirm before quitting/i })
    ).not.toBeInTheDocument()
  })

  it('saves notifyOnError when toggled', async () => {
    render(<GeneralDialog open onClose={() => {}} labelKey="" descKey="" />)

    const toggle = await screen.findByRole('switch', {
      name: /notify on failure/i,
    })
    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
        app: { notifyOnError: false },
      })
    })
  })

  it('saves autofillClipboardLinks when toggled', async () => {
    render(<GeneralDialog open onClose={() => {}} labelKey="" descKey="" />)

    const toggle = await screen.findByRole('switch', {
      name: /autofill link from clipboard/i,
    })
    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
        app: { autofillClipboardLinks: false },
      })
    })
  })

  it('saves only dirty fields', async () => {
    const onClose = vi.fn()
    render(
      <GeneralDialog
        open
        onClose={onClose}
        labelKey="settings.cards.general.title"
        descKey="settings.cards.general.desc"
      />
    )
    await waitFor(() => screen.getByDisplayValue('/Users/me/Downloads'))
    const user = userEvent.setup()
    const switches = screen.getAllByRole('switch')
    await user.click(switches[0]) // toggle launchAtStartup
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      app: { launchAtStartup: true },
    })
    expect(onClose).toHaveBeenCalled()
  })
})
