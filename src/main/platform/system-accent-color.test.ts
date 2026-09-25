import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { beforeEach, expect, it, vi } from 'vitest'

const { prefs, app, nativeTheme } = vi.hoisted(() => ({
  prefs: {
    getAccentColor: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    subscribeLocalNotification: vi.fn<
      (_event: string, _callback: () => void) => number
    >(() => 7),
    unsubscribeLocalNotification: vi.fn(),
  },
  app: { on: vi.fn(), off: vi.fn() },
  nativeTheme: { on: vi.fn(), off: vi.fn() },
}))
vi.mock('electron', () => ({ systemPreferences: prefs, app, nativeTheme }))

import {
  getSystemAccentColor,
  setupSystemAccentColorSync,
} from './system-accent-color'

beforeEach(() => {
  vi.resetAllMocks()
  prefs.subscribeLocalNotification.mockReturnValue(7)
  prefs.getAccentColor.mockReturnValue('ff8800ff')
})
it('reads native RGB on desktop and falls back for unavailable or invalid accents', () => {
  expect(getSystemAccentColor('darwin')).toBe('#ff8800')
  expect(getSystemAccentColor('win32')).toBe('#ff8800')
  expect(getSystemAccentColor('linux')).toBe('#ff8800')
  expect(getSystemAccentColor('freebsd')).toBeNull()
  prefs.getAccentColor.mockReturnValue('invalid')
  expect(getSystemAccentColor('darwin')).toBeNull()
  prefs.getAccentColor.mockImplementation(() => {
    throw new Error('unavailable')
  })
  expect(getSystemAccentColor('win32')).toBeNull()
})
it.each(['darwin', 'win32', 'linux'] as const)(
  'broadcasts color changes and releases native listeners on %s',
  (platform) => {
    const bus = new EventBus()
    const changed = vi.fn()
    bus.on(Events.SystemAccentColorChanged, changed)
    const handle = setupSystemAccentColorSync(bus, platform)
    const refresh =
      platform === 'darwin'
        ? prefs.subscribeLocalNotification.mock.calls[0]?.[1]
        : prefs.on.mock.calls[0]?.[1]
    prefs.getAccentColor.mockReturnValue('007affff')
    refresh?.()
    expect(changed).toHaveBeenCalledWith({ color: '#007aff' })
    refresh?.()
    expect(changed).toHaveBeenCalledOnce()
    handle.destroy()
    expect(nativeTheme.off).toHaveBeenCalled()
    expect(app.off).toHaveBeenCalled()
    if (platform === 'darwin')
      expect(prefs.unsubscribeLocalNotification).toHaveBeenCalledWith(7)
    else expect(prefs.off).toHaveBeenCalledWith('accent-color-changed', refresh)
  }
)

it.each(['', 'invalid', '123456', 'gg8800ff'])(
  'falls back when the Linux desktop returns an unavailable accent (%j)',
  (color) => {
    prefs.getAccentColor.mockReturnValue(color)
    expect(getSystemAccentColor('linux')).toBeNull()
  }
)

it('recovers from an unavailable Linux accent and clears it when support disappears', () => {
  prefs.getAccentColor.mockImplementation(() => {
    throw new Error('unavailable')
  })
  const bus = new EventBus()
  const changed = vi.fn()
  bus.on(Events.SystemAccentColorChanged, changed)
  const handle = setupSystemAccentColorSync(bus, 'linux')
  const accentChanged = prefs.on.mock.calls.find(
    ([event]) => event === 'accent-color-changed'
  )?.[1]
  const focused = app.on.mock.calls.find(
    ([event]) => event === 'browser-window-focus'
  )?.[1]
  const themeUpdated = nativeTheme.on.mock.calls.find(
    ([event]) => event === 'updated'
  )?.[1]

  prefs.getAccentColor.mockReturnValue('3584E4ff')
  focused?.()
  expect(changed).toHaveBeenLastCalledWith({ color: '#3584E4' })
  accentChanged?.()
  expect(changed).toHaveBeenCalledOnce()

  prefs.getAccentColor.mockReturnValue('')
  accentChanged?.()
  expect(changed).toHaveBeenLastCalledWith({ color: null })
  expect(changed).toHaveBeenCalledTimes(2)

  prefs.getAccentColor.mockReturnValue('26a269ff')
  themeUpdated?.()
  expect(changed).toHaveBeenLastCalledWith({ color: '#26a269' })
  expect(changed).toHaveBeenCalledTimes(3)
  handle.destroy()
  expect(prefs.off).toHaveBeenCalledWith('accent-color-changed', accentChanged)
  expect(app.off).toHaveBeenCalledWith('browser-window-focus', focused)
  expect(nativeTheme.off).toHaveBeenCalledWith('updated', themeUpdated)
})
