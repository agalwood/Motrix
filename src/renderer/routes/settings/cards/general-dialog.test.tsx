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
    .mockImplementation(async () => ({ ok: true, value: snapshot }))
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
