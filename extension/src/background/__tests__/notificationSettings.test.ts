import { expect, it, vi } from 'vitest'
import { createNotificationSettingsHandlers } from '@/background/notificationSettings'
import type { Browser } from '@/shared/browser'

function fixture() {
  const native = {
    capability: vi.fn(async () => ({
      available: true,
      authorization: 'authorized' as const,
    })),
    test: vi.fn(async () => 'accepted' as const),
    openSettings: vi.fn(async () => true),
  }
  const config = { master: false, confirm: true, error: true, reminder: true }
  const store = { get: vi.fn(async () => config), set: vi.fn(async () => {}) }
  const deps = {
    extensionId: 'motrix',
    pageURLs: [
      'safari-web-extension://abc/options.html',
      'safari-web-extension://abc/popup.html',
    ],
    native,
    store,
    isSafari: () => true,
    browserNotificationsSupported: () => false,
  }
  return {
    handlers: createNotificationSettingsHandlers(deps),
    deps,
    native,
    store,
    config,
  }
}
const options = {
  id: 'motrix',
  url: 'safari-web-extension://abc/options.html#general',
  tab: { id: 5 },
  frameId: 0,
} as Browser.runtime.MessageSender

it('accepts the real settings tab and popup without requesting permission or saving test preferences', async () => {
  const f = fixture()
  expect(await f.handlers.capability(undefined, options)).toEqual({
    available: true,
    authorization: 'authorized',
  })
  expect(await f.handlers.get(undefined, options)).toEqual(f.config)
  expect(await f.handlers.test(undefined, options)).toEqual({
    status: 'accepted',
  })
  expect(
    await f.handlers.openSettings(undefined, {
      id: 'motrix',
      url: f.deps.pageURLs[1],
    })
  ).toEqual({ opened: true })
  expect(f.store.set).not.toHaveBeenCalled()
  await f.handlers.set({ ...f.config, master: true }, options)
  expect(f.store.set).toHaveBeenCalledWith({ ...f.config, master: true })
})

it.each([
  { url: 'https://example.com/options.html' },
  { url: 'safari-web-extension://abc/options.html/extra' },
  { url: 'safari-web-extension://abc/other.html' },
  { url: 'safari-web-extension://other/options.html' },
  { url: 'safari-web-extension://abc/options.html', id: 'other' },
  { frameId: 1 },
])(
  'rejects non-settings senders before native actions: %j',
  async (override) => {
    const f = fixture()
    const sender = { ...options, ...override }
    for (const handler of [
      f.handlers.capability,
      f.handlers.test,
      f.handlers.openSettings,
      f.handlers.get,
    ]) {
      await expect(handler(undefined, sender)).rejects.toThrow(
        'notification-settings.forbidden'
      )
    }
    await expect(f.handlers.set(f.config, sender)).rejects.toThrow(
      'notification-settings.forbidden'
    )
    expect(f.native.test).not.toHaveBeenCalled()
    expect(f.native.openSettings).not.toHaveBeenCalled()
    expect(f.store.set).not.toHaveBeenCalled()
  }
)

it('rejects caller-controlled test content, settings URLs and invalid preferences', async () => {
  const f = fixture()
  await expect(
    f.handlers.test({ title: 'injected' } as never, options)
  ).rejects.toThrow('invalid-request')
  await expect(
    f.handlers.openSettings({ url: 'file:///tmp/other.app' } as never, options)
  ).rejects.toThrow('invalid-request')
  for (const value of [
    { ...f.config, master: 'true' },
    { ...f.config, safariNativeOptIn: true },
    {},
  ]) {
    await expect(f.handlers.set(value as never, options)).rejects.toThrow(
      'invalid-request'
    )
  }
  expect(f.native.test).not.toHaveBeenCalled()
  expect(f.store.set).not.toHaveBeenCalled()
})
