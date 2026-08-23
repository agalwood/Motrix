import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

import { transport } from '@renderer/lib/transport'
import { AppearanceDialog } from './appearance-dialog'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const FIXTURE = {
  app: {
    theme: 'system',
    language: 'en-US',
    traySpeedometer: false,
    runMode: 1, // RunMode.Standard — numeric enum
    lightweightMode: false,
    launchAtStartup: false,
    defaultSaveDir: '/x',
    notifyOnComplete: true,
    protocols: { magnet: true },
    magnetFileSelection: true,
    liquidGlassEffect: false,
  },
}

beforeAll(() => {
  // jsdom doesn't implement these; Base UI Select needs them.
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {}
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {}
  }
})

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  Object.defineProperty(transport, 'platform', {
    configurable: true,
    value: 'darwin',
  })
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  vi.mocked(transport.invoke).mockReset()
  vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
    if (channel === Queries.GetSettings) return FIXTURE
    return { saved: true, requiresRestart: false, changedRestartKeys: [] }
  })
})

describe('<AppearanceDialog>', () => {
  it('renders hydrated select labels instead of raw values', async () => {
    render(
      <AppearanceDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.appearance.title"
        descKey="settings.cards.appearance.desc"
      />
    )

    await waitFor(() => {
      const [themeTrigger, languageTrigger, runModeTrigger] =
        screen.getAllByRole('combobox')

      expect(themeTrigger).toHaveTextContent(/^System$/)
      expect(themeTrigger).not.toHaveTextContent(/^system$/)
      expect(languageTrigger).toHaveTextContent(/^English$/)
      expect(languageTrigger).not.toHaveTextContent(/^en-US$/)
      expect(languageTrigger).toHaveClass('min-w-30', 'max-w-64')
      expect(languageTrigger).not.toHaveClass('w-32')
      expect(runModeTrigger).toHaveTextContent(/^Dock & Menu Bar$/)
      expect(runModeTrigger).not.toHaveTextContent(/^1$/)
    })

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(
      screen.getByRole('combobox', {
        name: 'Show app in',
      })
    )
    expect(
      await screen.findByRole('option', { name: 'Dock & Menu Bar' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Menu Bar Only' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Dock Only' })
    ).toBeInTheDocument()
  })

  it.each(['win32', 'linux'] as const)(
    'uses launch behavior labels on %s',
    async (platform) => {
      Object.defineProperty(transport, 'platform', {
        configurable: true,
        value: platform,
      })
      render(
        <AppearanceDialog
          open
          onClose={vi.fn()}
          labelKey="settings.cards.appearance.title"
          descKey="settings.cards.appearance.desc"
        />
      )

      const runModeTrigger = await screen.findByRole('combobox', {
        name: 'When opening Motrix',
      })
      expect(runModeTrigger).toHaveTextContent(/^Open Main Window$/)

      const user = userEvent.setup({ pointerEventsCheck: 0 })
      await user.click(runModeTrigger)
      expect(
        await screen.findByRole('option', { name: 'Open Main Window' })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('option', { name: 'Start in System Tray' })
      ).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: 'Dock Only' })).toBeNull()

      if (platform === 'linux') {
        expect(
          screen.getByText(/depend on your desktop environment/i)
        ).toBeInTheDocument()
      }
    }
  )

  it('does not show desktop run-mode settings on the web', async () => {
    Object.defineProperty(transport, 'platform', {
      configurable: true,
      value: 'web',
    })
    render(
      <AppearanceDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.appearance.title"
        descKey="settings.cards.appearance.desc"
      />
    )

    await waitFor(() => {
      expect(
        screen.getByRole('combobox', { name: 'Theme' })
      ).toBeInTheDocument()
    })
    expect(screen.queryByRole('combobox', { name: 'Show app in' })).toBeNull()
    expect(
      screen.queryByRole('combobox', { name: 'When opening Motrix' })
    ).toBeNull()
  })

  it('hydrates and submits dirty changes', async () => {
    const onClose = vi.fn()
    render(
      <AppearanceDialog
        open
        onClose={onClose}
        labelKey="settings.cards.appearance.title"
        descKey="settings.cards.appearance.desc"
      />
    )
    await waitFor(() => screen.getAllByRole('combobox').length > 0)
    // Disable pointer-events check; Base UI Select toggles `pointer-events: none`
    // on the body during open transitions and jsdom doesn't model it reliably.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    // First combobox is the Theme select.
    const [themeTrigger] = screen.getAllByRole('combobox')
    await user.click(themeTrigger)
    const darkOption = await screen.findByRole('option', { name: /dark/i })
    await user.click(darkOption)
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      app: { theme: 'dark' },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('hydrates and submits lightweight mode independently', async () => {
    render(
      <AppearanceDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.appearance.title"
        descKey="settings.cards.appearance.desc"
      />
    )
    const lightweight = await screen.findByRole('switch', {
      name: 'Lightweight mode',
    })
    const user = userEvent.setup()

    expect(lightweight).not.toBeChecked()
    await user.click(lightweight)
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      app: { lightweightMode: true },
    })
  })

  it('waits for the host locale event after persisting a language change', async () => {
    render(
      <AppearanceDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.appearance.title"
        descKey="settings.cards.appearance.desc"
      />
    )
    await waitFor(() => screen.getAllByRole('combobox').length > 0)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const [, languageTrigger] = screen.getAllByRole('combobox')

    await user.click(languageTrigger)
    await user.click(await screen.findByRole('option', { name: '简体中文' }))
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      app: { language: 'zh-CN' },
    })
    expect(i18n.resolvedLanguage).toBe('en-US')
  })
})
