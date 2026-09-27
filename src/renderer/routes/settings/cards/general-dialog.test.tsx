import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  generalSettingsSnapshot,
  TEST_GENERAL_REVISION,
} from '@test-utils/general-settings'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralDialog } from './general-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), platform: 'darwin' },
}))
let snapshot = generalSettingsSnapshot()
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  transport.platform = 'darwin'
  snapshot = generalSettingsSnapshot()
  vi.mocked(transport.invoke)
    .mockReset()
    .mockImplementation(async (channel) =>
      channel === Queries.GetAutoLaunchStatus
        ? { authority: 'application' }
        : { ok: true, value: snapshot }
    )
})
async function openGeneral(close = vi.fn()) {
  render(
    <GeneralDialog
      open
      onClose={close}
      labelKey="settings.cards.general.title"
      descKey="settings.cards.general.desc"
    />
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  )
  return close
}
const saves = () =>
  vi
    .mocked(transport.invoke)
    .mock.calls.filter(([channel]) => channel === Commands.SaveGeneralSettings)

describe('General settings', () => {
  it.each([
    ['Off', false, false],
    ['System notifications', true, false],
    ['In-app notifications', false, true],
    ['Both', true, true],
  ] as const)(
    'maps %s to independent system and in-app preferences',
    async (label, system, inside) => {
      snapshot.app.notifyOnComplete = false
      snapshot.app.notifyInAppOnComplete = false
      await openGeneral()
      const user = userEvent.setup()
      await user.click(
        screen.getByRole('combobox', { name: 'Download completed' })
      )
      await user.click(await screen.findByRole('option', { name: label }))
      expect(saves()).toHaveLength(0)
      await user.click(screen.getByRole('button', { name: 'Save' }))
      const patch = saves()[0]?.[1] as { app: Record<string, boolean> }
      expect({ ...snapshot.app, ...patch.app }).toMatchObject({
        notifyOnComplete: system,
        notifyInAppOnComplete: inside,
      })
      expect(
        Object.keys(patch.app).every((key) =>
          ['notifyOnComplete', 'notifyInAppOnComplete'].includes(key)
        )
      ).toBe(true)
    }
  )
  it('discards notification and badge edits on Cancel', async () => {
    const close = await openGeneral()
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: 'Download failed' }))
    await user.click(await screen.findByRole('option', { name: 'Off' }))
    await user.click(screen.getByRole('combobox', { name: 'Unread badge' }))
    await user.click(await screen.findByRole('option', { name: 'Hidden' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(saves()).toHaveLength(0)
    expect(close).toHaveBeenCalledOnce()
  })
  it('saves moved lifecycle fields and startup fields without touching directories', async () => {
    await openGeneral()
    const user = userEvent.setup()
    expect(screen.queryByRole('textbox', { name: /folder/i })).toBeNull()
    expect(
      screen.getByRole('switch', { name: 'Show window at login' })
    ).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('switch', { name: 'Open at login' }))
    await user.click(
      screen.getByRole('switch', { name: 'Show window at login' })
    )
    await user.click(
      screen.getByRole('switch', {
        name: 'Save memory when the window is closed',
      })
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(saves()[0]?.[1]).toEqual({
      expectedRevision: TEST_GENERAL_REVISION,
      app: {
        launchAtStartup: true,
        showMainWindowAtLogin: true,
        lightweightMode: true,
      },
      directories: { addFavorites: [], removeFavorites: [], removeRecent: [] },
    })
  })
  it.each(['win32', 'linux'])(
    'keeps desktop-specific run modes on %s',
    async (platform) => {
      transport.platform = platform as typeof transport.platform
      await openGeneral()
      const user = userEvent.setup()
      await user.click(
        screen.getByRole('combobox', { name: 'When opening Motrix' })
      )
      await user.click(
        await screen.findByRole('option', { name: 'Start in System Tray' })
      )
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(saves()[0]?.[1]).toMatchObject({ app: { runMode: 2 } })
    }
  )
  it('keeps unsupported desktop controls out of the Web dialog', async () => {
    transport.platform = 'web'
    render(
      <GeneralDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.general.title"
        descKey="settings.cards.general.desc"
      />
    )
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })
  it('disables writes after a failed load and supports retry', async () => {
    vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('offline'))
    render(<GeneralDialog open onClose={vi.fn()} labelKey="" descKey="" />)
    await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(
      screen.getByRole('switch', { name: 'Open at login' })
    ).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    )
    expect(transport.invoke).toHaveBeenCalledWith(
      Queries.GetGeneralSettingsDraft,
      {}
    )
  })
  it('preserves intent after an uncertain committed save and reversal', async () => {
    let lost = true
    vi.mocked(transport.invoke).mockImplementation(async (channel, raw) => {
      if (channel === Queries.GetGeneralSettingsDraft)
        return { ok: true, value: snapshot }
      const request = raw as { app: object }
      if (lost) {
        lost = false
        snapshot = {
          ...snapshot,
          app: { ...snapshot.app, ...request.app },
          revision: '00000000-0000-4000-8000-000000000002',
        }
        throw new Error('reply lost')
      }
      return { ok: true, value: snapshot }
    })
    await openGeneral()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('switch', { name: 'Confirm before quitting' })
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    )
    await user.click(
      screen.getByRole('switch', { name: 'Confirm before quitting' })
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(saves().at(-1)?.[1]).toMatchObject({ app: { warnBeforeQuit: true } })
  })
})

describe('Windows packaged startup settings', () => {
  const status = (state: string) => ({
    authority: 'windows-package',
    result: {
      version: 1,
      ok: true,
      taskId: 'MotrixStartup',
      state,
      packageIdentityPresent: true,
    },
  })
  function windows(initial: unknown) {
    transport.platform = 'win32'
    let current = initial
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetAutoLaunchStatus) return current
      if (channel === Commands.OpenStartupSettings) return { ok: true }
      return { ok: true, value: snapshot }
    })
    return (next: unknown) => {
      current = next
    }
  }
  it('reads actual Windows state without submitting a saved preference', async () => {
    snapshot.app.launchAtStartup = false
    windows(status('enabled'))
    await openGeneral()
    expect(await screen.findByText('Enabled in Windows')).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Open at login' })).toBeChecked()
    expect(saves()).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saves()[0]?.[1]).toMatchObject({ app: {} })
  })
  it.each([
    [false, 'enabled', false],
    [true, 'disabled', true],
  ] as const)(
    'submits explicit intent even when it matches the stored value %s',
    async (stored, state, desired) => {
      snapshot.app.launchAtStartup = stored
      windows(status(state))
      await openGeneral()
      const toggle = screen.getByRole('switch', { name: 'Open at login' })
      await waitFor(() =>
        expect(toggle).not.toHaveAttribute('aria-disabled', 'true')
      )
      await userEvent.click(toggle)
      if (desired) expect(toggle).toBeChecked()
      else expect(toggle).not.toBeChecked()
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(saves()[0]?.[1]).toMatchObject({
        app: { launchAtStartup: desired },
      })
    }
  )
  it.each(['disabled_by_user', 'disabled_by_policy', 'enabled_by_policy'])(
    'leaves %s under Windows control',
    async (state) => {
      windows(status(state))
      await openGeneral()
      const toggle = screen.getByRole('switch', { name: 'Open at login' })
      expect(toggle).toHaveAttribute('aria-disabled', 'true')
      if (state === 'enabled_by_policy') expect(toggle).toBeChecked()
      else expect(toggle).not.toBeChecked()
      await userEvent.click(
        screen.getByRole('button', { name: 'Open Windows startup settings' })
      )
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.OpenStartupSettings
      )
      expect(saves()).toHaveLength(0)
    }
  )
  it('refreshes on focus without changing the stored preference or draft', async () => {
    const setStatus = windows(status('enabled'))
    await openGeneral()
    expect(await screen.findByText('Enabled in Windows')).toBeVisible()
    setStatus(status('disabled_by_user'))
    fireEvent(window, new Event('focus'))
    await screen.findByText(
      'Disabled in Windows startup settings. Enable it there to allow opening at login.'
    )
    expect(
      screen.getByRole('switch', { name: 'Open at login' })
    ).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saves()[0]?.[1]).toMatchObject({ app: {} })
  })
  it('discards an unsaved startup edit superseded by a locked Windows choice', async () => {
    snapshot.app.launchAtStartup = false
    const setStatus = windows(status('disabled'))
    await openGeneral()
    await screen.findByText('Disabled in Windows')
    const toggle = screen.getByRole('switch', { name: 'Open at login' })
    await userEvent.click(toggle)
    expect(toggle).toBeChecked()
    setStatus(status('disabled_by_user'))
    fireEvent(window, new Event('focus'))
    await screen.findByText(
      'Disabled in Windows startup settings. Enable it there to allow opening at login.'
    )
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saves()[0]?.[1]).toMatchObject({ app: {} })
  })

  it('does not resurrect a failed submitted edit after a Windows lock is removed', async () => {
    windows(status('disabled'))
    let current = status('disabled')
    let failSave!: (value: unknown) => void
    const pendingSave = new Promise((resolve) => {
      failSave = resolve
    })
    let first = true
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetAutoLaunchStatus) return current
      if (channel === Commands.SaveGeneralSettings && first) {
        first = false
        return pendingSave
      }
      return { ok: true, value: snapshot }
    })
    await openGeneral()
    await screen.findByText('Disabled in Windows')
    await userEvent.click(screen.getByRole('switch', { name: 'Open at login' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    current = status('disabled_by_user')
    fireEvent(window, new Event('focus'))
    await screen.findByText(
      'Disabled in Windows startup settings. Enable it there to allow opening at login.'
    )
    snapshot.app.launchAtStartup = true
    failSave({ ok: false, error: { code: 'startupNotApplied' }, snapshot })
    await screen.findByText(
      'Settings were saved, but Windows did not apply the startup change. Review Windows startup settings.'
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    )
    current = status('disabled')
    fireEvent(window, new Event('focus'))
    await screen.findByText('Disabled in Windows')
    expect(
      screen.getByRole('switch', { name: 'Open at login' })
    ).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saves()[1]?.[1]).toMatchObject({ app: { launchAtStartup: false } })
  })

  it('keeps unknown or failed states unavailable and can retry the query', async () => {
    const setStatus = windows(status('future_state'))
    await openGeneral()
    await screen.findByText('Windows startup status is unavailable. Try again.')
    expect(
      screen.getByRole('switch', { name: 'Open at login' })
    ).toHaveAttribute('aria-disabled', 'true')
    setStatus(status('enabled'))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Enabled in Windows')
    expect(
      screen.getByRole('switch', { name: 'Open at login' })
    ).not.toHaveAttribute('aria-disabled', 'true')
    expect(saves()).toHaveLength(0)
  })
  it('retains explicit startup intent for retry after an already committed effect failure', async () => {
    snapshot.app.launchAtStartup = true
    windows(status('disabled'))
    const invoke = vi.mocked(transport.invoke)
    let failed = false
    invoke.mockImplementation(async (channel) => {
      if (channel === Queries.GetAutoLaunchStatus) return status('disabled')
      if (channel === Commands.SaveGeneralSettings && !failed) {
        failed = true
        return { ok: false, error: { code: 'startupNotApplied' }, snapshot }
      }
      return { ok: true, value: snapshot }
    })
    const close = await openGeneral()
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Open at login' })
      ).toBeEnabled()
    )
    await userEvent.click(screen.getByRole('switch', { name: 'Open at login' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(
      'Settings were saved, but Windows did not apply the startup change. Review Windows startup settings.'
    )
    expect(close).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saves()).toHaveLength(2)
    for (const [, request] of saves())
      expect(request).toMatchObject({ app: { launchAtStartup: true } })
    expect(close).toHaveBeenCalledOnce()
  })
})
