import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/shared/i18n'
import { GeneralTab } from '@/options/tabs/GeneralTab'
import { extensionBrowser as browser } from '@/shared/browser'
import type {
  NotificationCapability,
  NotificationsConfig,
} from '@/shared/notifications'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

let capability: NotificationCapability
let config: NotificationsConfig
beforeEach(() => {
  vi.stubGlobal('__BROWSER__', 'safari')
  Object.assign(browser, { action: { openPopup: vi.fn(async () => {}) } })
  capability = { available: true, authorization: 'authorized' }
  config = { master: false, confirm: true, error: true, reminder: true }
  browser.runtime.sendMessage = vi.fn(async (env) => {
    if (env.kind === 'bg.getNotificationCapability') return capability
    if (env.kind === 'bg.getNotificationsConfig') return config
    if (env.kind === 'bg.getTakeoverConfig') return TAKEOVER_DEFAULT
    if (env.kind === 'bg.testNotification') return { status: 'accepted' }
    if (env.kind === 'bg.openNotificationSettings') return { opened: true }
    if (env.kind === 'bg.setNotificationsConfig') {
      config = env.payload
      return { ok: true }
    }
    return { ok: true }
  }) as never
})
afterEach(() => vi.unstubAllGlobals())

it('hides unavailable native notifications without explanatory placeholders', async () => {
  capability = { available: false, authorization: 'unavailable' }
  render(<GeneralTab />)
  await waitFor(() =>
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      kind: 'bg.getNotificationCapability',
      payload: undefined,
    })
  )
  expect(
    screen.queryByRole('heading', { name: 'System notifications' })
  ).toBeNull()
  expect(
    screen.queryByRole('switch', { name: 'Enable system notifications' })
  ).toBeNull()
  expect(
    screen.queryByText(/not supported|not available|unavailable/i)
  ).toBeNull()
})

it('saves opt-in only through Apply and sends a fixed test independently of unsaved settings', async () => {
  render(<GeneralTab />)
  const master = await screen.findByRole('switch', {
    name: 'Enable system notifications',
  })
  await waitFor(() => expect(master.getAttribute('aria-checked')).toBe('false'))
  fireEvent.click(master)
  fireEvent.click(
    screen.getByRole('button', { name: 'Send test notification' })
  )
  expect(await screen.findByText('Test notification submitted.')).toBeTruthy()
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
    kind: 'bg.testNotification',
    payload: undefined,
  })
  expect(config.master).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  await waitFor(() => expect(config.master).toBe(true))
})

it('allows disabling a saved preference after permission revocation and preserves edits on focus refresh', async () => {
  config.master = true
  capability.authorization = 'denied'
  render(<GeneralTab />)
  const master = await screen.findByRole('switch', {
    name: 'Enable system notifications',
  })
  await waitFor(() => expect(master.getAttribute('aria-checked')).toBe('true'))
  expect(master.hasAttribute('data-disabled')).toBe(false)
  fireEvent.click(master)
  expect(master.getAttribute('aria-checked')).toBe('false')
  expect(master.hasAttribute('data-disabled')).toBe(true)
  expect(
    screen
      .getByRole('button', { name: 'Send test notification' })
      .hasAttribute('disabled')
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Notification settings' }))
  await waitFor(() =>
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      kind: 'bg.openNotificationSettings',
      payload: undefined,
    })
  )
  capability = { available: true, authorization: 'authorized' }
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  await waitFor(() => expect(master.hasAttribute('data-disabled')).toBe(false))
  expect(master.getAttribute('aria-checked')).toBe('false')
  expect(config.master).toBe(true)
})

it('reports controlled feedback without exposing native errors', async () => {
  const original = browser.runtime.sendMessage
  browser.runtime.sendMessage = vi.fn(async (env) =>
    env.kind === 'bg.testNotification'
      ? { error: '/private/secret/native-failure' }
      : original(env)
  ) as never
  render(<GeneralTab />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Send test notification' })
  )
  expect(
    await screen.findByText('Could not confirm test notification delivery.')
  ).toBeTruthy()
  expect(screen.queryByText(/private\/secret/)).toBeNull()
})
