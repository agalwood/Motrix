import '@test-utils/dom-animations'
import type { SaveGeneralSettingsRequest } from '@shared/schemas/general-settings'
import {
  generalSettingsSnapshot,
  TEST_GENERAL_REVISION,
} from '@test-utils/general-settings'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted alongside vi.mock so the factory can reference it without TDZ.
const transportMock = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  off: vi.fn(),
  platform: 'darwin' as NodeJS.Platform | 'web',
  pickSaveDir: vi.fn(),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: transportMock,
}))

const pickSaveDir = transportMock.pickSaveDir
vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ pickSaveDir: transportMock.pickSaveDir }),
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
    showMainWindowAtLogin: false,
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

const generalResult = (
  preferences = { favorites: [] as string[], recent: [] as string[] },
  app = SETTINGS_FIXTURE.app
) => ({ ok: true, value: generalSettingsSnapshot(preferences, app) })

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  transportMock.platform = 'darwin'
  transportMock.pickSaveDir.mockReset().mockResolvedValue(null)
  vi.mocked(transport.invoke).mockReset()
  vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
    if (channel === Queries.GetGeneralSettingsDraft) return generalResult()
    return generalResult()
  })
})

describe('<GeneralDialog>', () => {
  it.each(['Cancel', 'Save'])(
    'keeps desktop notification choices local until %s without changing native settings',
    async (action) => {
      const close = vi.fn()
      render(
        <GeneralDialog
          open
          onClose={close}
          labelKey="settings.cards.general.title"
          descKey="settings.cards.general.desc"
        />
      )
      await screen.findByDisplayValue('/Users/me/Downloads')
      const user = userEvent.setup()
      await user.click(
        screen.getByRole('switch', { name: 'Show completed downloads' })
      )
      await user.click(
        screen.getByRole('switch', { name: 'Show failed downloads' })
      )
      screen.getByRole('combobox', { name: 'Notification badge' }).focus()
      await user.keyboard('[ArrowDown]')
      await user.click(await screen.findByRole('option', { name: 'Dot' }))
      expect(
        screen.getByRole('switch', { name: 'Notify when download completes' })
      ).toBeChecked()
      expect(
        screen.getByRole('switch', { name: 'Notify on failure' })
      ).toBeChecked()
      expect(transport.invoke).not.toHaveBeenCalledWith(
        Commands.SaveGeneralSettings,
        expect.anything()
      )
      await user.click(screen.getByRole('button', { name: action }))
      await waitFor(() => expect(close).toHaveBeenCalledOnce())
      if (action === 'Save') {
        expect(transport.invoke).toHaveBeenCalledWith(
          Commands.SaveGeneralSettings,
          {
            expectedRevision: TEST_GENERAL_REVISION,
            app: {
              notifyInAppOnComplete: false,
              notifyInAppOnError: false,
              notificationBadgeStyle: 'dot',
            },
            directories: {
              addFavorites: [],
              removeFavorites: [],
              removeRecent: [],
            },
          }
        )
      } else {
        expect(transport.invoke).not.toHaveBeenCalledWith(
          Commands.SaveGeneralSettings,
          expect.anything()
        )
      }
    }
  )

  it('does not expose desktop notification controls in Web settings', async () => {
    transportMock.platform = 'web'
    render(<GeneralDialog open onClose={vi.fn()} labelKey="" descKey="" />)
    await screen.findByDisplayValue('/Users/me/Downloads')
    expect(
      screen.queryByRole('switch', { name: 'Show completed downloads' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: 'Show failed downloads' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: 'Notification badge' })
    ).not.toBeInTheDocument()
  })

  it('keeps failed initial settings controls disabled and focuses a stable element before Retry', async () => {
    let attempts = 0
    let release!: (value: unknown) => void
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel !== Queries.GetGeneralSettingsDraft) return generalResult()
      if (++attempts === 1) throw new Error('offline')
      return new Promise((resolve) => {
        release = resolve
      })
    })
    render(
      <GeneralDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.general.title"
        descKey="settings.cards.general.desc"
      />
    )
    await screen.findByRole('alert')
    const toggle = screen.getByRole('switch', { name: /notify on failure/i })
    const original = toggle.getAttribute('aria-checked')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', original)
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    await userEvent.click(retry)
    expect(screen.getByRole('dialog')).toContainElement(
      document.activeElement as HTMLElement
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await act(async () => release(generalResult()))
    await screen.findByDisplayValue('/Users/me/Downloads')
  })

  it.each(['Cancel', 'Save'])(
    'keeps directory edits and the default Browse selection in the same %s session',
    async (action) => {
      const preferences = { favorites: ['/saved '], recent: ['/recent'] }
      vi.mocked(transport.invoke).mockImplementation(async (channel) =>
        channel === Queries.GetGeneralSettingsDraft
          ? generalResult(preferences)
          : generalResult(preferences)
      )
      transportMock.pickSaveDir.mockResolvedValue('/new-default')
      const onClose = vi.fn()
      render(
        <GeneralDialog
          open
          onClose={onClose}
          labelKey="settings.cards.general.title"
          descKey="settings.cards.general.desc"
        />
      )
      await screen.findByRole('button', { name: 'Remove favorite /saved' })
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove favorite /saved' })
      )
      await userEvent.click(
        screen.getByRole('switch', { name: /notify on failure/i })
      )
      await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
      await screen.findByDisplayValue('/new-default')
      expect(
        vi
          .mocked(transport.invoke)
          .mock.calls.every(
            ([channel]) => channel === Queries.GetGeneralSettingsDraft
          )
      ).toBe(true)
      await userEvent.click(screen.getByRole('button', { name: action }))
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      if (action === 'Save') {
        expect(transport.invoke).toHaveBeenCalledWith(
          Commands.SaveGeneralSettings,
          {
            expectedRevision: TEST_GENERAL_REVISION,
            app: { defaultSaveDir: '/new-default', notifyOnError: false },
            directories: {
              addFavorites: [],
              removeFavorites: ['/saved '],
              removeRecent: [],
            },
          }
        )
      } else {
        expect(vi.mocked(transport.invoke).mock.calls).toHaveLength(1)
      }
    }
  )

  it('locks Save, Cancel and Escape while default-directory Browse is pending', async () => {
    let release!: (path: string | null) => void
    transportMock.pickSaveDir.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const onClose = vi.fn()
    render(
      <GeneralDialog
        open
        onClose={onClose}
        labelKey="settings.cards.general.title"
        descKey="settings.cards.general.desc"
      />
    )
    await screen.findByDisplayValue('/Users/me/Downloads')
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => release(null))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('retains dirty app fields and directory rows after an atomic Save failure', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetGeneralSettingsDraft)
        return generalResult({ favorites: ['/saved'], recent: [] })
      return { ok: false, error: { code: 'permissionDenied' } }
    })
    const onClose = vi.fn()
    render(
      <GeneralDialog
        open
        onClose={onClose}
        labelKey="settings.cards.general.title"
        descKey="settings.cards.general.desc"
      />
    )
    await screen.findByRole('button', { name: 'Remove favorite /saved' })
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove favorite /saved' })
    )
    await userEvent.click(
      screen.getByRole('switch', { name: /notify on failure/i })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(onClose).not.toHaveBeenCalled()
    expect(
      screen.getByRole('switch', { name: /notify on failure/i })
    ).not.toBeChecked()
    expect(screen.queryByTitle('/saved')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(
          ([channel]) => channel === Commands.SaveGeneralSettings
        )
    ).toHaveLength(2)
  })

  it('hydrates General fields and directories from one snapshot', async () => {
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
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.SaveGeneralSettings,
        {
          expectedRevision: TEST_GENERAL_REVISION,
          app: { warnBeforeQuit: false },
          directories: {
            addFavorites: [],
            removeFavorites: [],
            removeRecent: [],
          },
        }
      )
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
      screen.queryByRole('switch', { name: /open at login/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: /show window at login/i })
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
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.SaveGeneralSettings,
        {
          expectedRevision: TEST_GENERAL_REVISION,
          app: { notifyOnError: false },
          directories: {
            addFavorites: [],
            removeFavorites: [],
            removeRecent: [],
          },
        }
      )
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
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.SaveGeneralSettings,
        {
          expectedRevision: TEST_GENERAL_REVISION,
          app: { autofillClipboardLinks: false },
          directories: {
            addFavorites: [],
            removeFavorites: [],
            removeRecent: [],
          },
        }
      )
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
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.SaveGeneralSettings,
      {
        expectedRevision: TEST_GENERAL_REVISION,
        app: { launchAtStartup: true },
        directories: {
          addFavorites: [],
          removeFavorites: [],
          removeRecent: [],
        },
      }
    )
    expect(onClose).toHaveBeenCalled()
  })
})

it('enables the login window preference with auto-launch and saves both dirty fields', async () => {
  render(<GeneralDialog open onClose={() => {}} labelKey="" descKey="" />)
  await waitFor(() => screen.getByDisplayValue('/Users/me/Downloads'))
  const toggle = screen.getByRole('switch', {
    name: /show window at login/i,
  })
  expect(toggle).toHaveAttribute('aria-disabled', 'true')
  expect(toggle).not.toBeChecked()
  await userEvent.click(screen.getByRole('switch', { name: /open at login/i }))
  expect(toggle).not.toHaveAttribute('aria-disabled', 'true')
  await userEvent.click(toggle)
  await userEvent.click(screen.getByRole('button', { name: /save/i }))
  expect(transport.invoke).toHaveBeenCalledWith(Commands.SaveGeneralSettings, {
    expectedRevision: TEST_GENERAL_REVISION,
    app: { launchAtStartup: true, showMainWindowAtLogin: true },
    directories: { addFavorites: [], removeFavorites: [], removeRecent: [] },
  })
})

it('asks for a download folder and clears the error after browsing', async () => {
  vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
    if (channel === Queries.GetGeneralSettingsDraft)
      return generalResult(undefined, {
        ...SETTINGS_FIXTURE.app,
        defaultSaveDir: '',
      })
    return generalResult()
  })
  pickSaveDir.mockResolvedValue('/Downloads')
  const onClose = vi.fn()
  render(<GeneralDialog open onClose={onClose} labelKey="" descKey="" />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Choose a download folder.')).toBeVisible()
  expect(onClose).not.toHaveBeenCalled()
  expect(transport.invoke).not.toHaveBeenCalledWith(
    Commands.UpdateSettings,
    expect.anything()
  )
  await user.click(screen.getByRole('button', { name: 'Browse…' }))
  await screen.findByDisplayValue('/Downloads')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.SaveGeneralSettings,
      {
        expectedRevision: TEST_GENERAL_REVISION,
        app: { defaultSaveDir: '/Downloads' },
        directories: {
          addFavorites: [],
          removeFavorites: [],
          removeRecent: [],
        },
      }
    )
  )
  expect(onClose).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'saves a boolean restored to its original clean value after a lost committed response (refresh=%s)',
  async (refresh) => {
    let host = generalSettingsSnapshot(undefined, SETTINGS_FIXTURE.app)
    let first = true
    vi.mocked(transport.invoke).mockImplementation(async (channel, raw) => {
      if (channel === Queries.GetGeneralSettingsDraft)
        return { ok: true, value: structuredClone(host) }
      const request = raw as SaveGeneralSettingsRequest
      if (request.expectedRevision !== host.revision)
        return {
          ok: false,
          error: { code: 'conflict' },
          snapshot: structuredClone(host),
        }
      host = {
        ...host,
        app: { ...host.app, ...request.app },
        revision: '00000000-0000-4000-8000-000000000002',
      }
      if (first) {
        first = false
        host.app.autofillClipboardLinks = false // An unrelated client's committed edit.
        throw new Error('response lost after commit')
      }
      return { ok: true, value: structuredClone(host) }
    })
    const close = vi.fn()
    render(<GeneralDialog open onClose={close} labelKey="" descKey="" />)
    await screen.findByDisplayValue('/Users/me/Downloads')
    const user = userEvent.setup()
    const notification = screen.getByRole('switch', {
      name: /notify on failure/i,
    })
    await user.click(notification)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(host.app.notifyOnError).toBe(false)
    expect(close).not.toHaveBeenCalled()
    await user.click(notification) // RHF dirty=false against the original true baseline.
    if (refresh) {
      await user.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
      )
    }
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(host.app.notifyOnError).toBe(true)
    expect(host.app.autofillClipboardLinks).toBe(false)
    expect(
      screen.getByRole('switch', { name: /autofill link from clipboard/i })
    ).not.toBeChecked()
    const saves = vi
      .mocked(transport.invoke)
      .mock.calls.filter(
        ([channel]) => channel === Commands.SaveGeneralSettings
      )
    expect(saves.at(-1)?.[1]).toMatchObject({ app: { notifyOnError: true } })
    const finalRequest = saves.at(-1)?.[1] as
      | SaveGeneralSettingsRequest
      | undefined
    expect(finalRequest?.app).toEqual({ notifyOnError: true })
  }
)
