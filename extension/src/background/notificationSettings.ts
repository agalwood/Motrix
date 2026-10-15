import { z } from 'zod'
import type { MessageBusHandler } from '@/background/MessageBus'
import type { SafariNotificationTransport } from '@/background/SafariNotificationTransport'
import type { Browser } from '@/shared/browser'
import type { NotificationsConfig } from '@/shared/notifications'

const configSchema = z
  .object({
    master: z.boolean(),
    confirm: z.boolean(),
    error: z.boolean(),
    reminder: z.boolean(),
  })
  .strict()

interface Dependencies {
  extensionId: string
  pageURLs: string[]
  native: Pick<
    SafariNotificationTransport,
    'capability' | 'test' | 'openSettings'
  >
  isSafari(): boolean
  browserNotificationsSupported(): boolean
  store: {
    get(): Promise<NotificationsConfig>
    set(config: NotificationsConfig): Promise<void>
  }
}

/** Settings pages may be tabs; content frames and unrelated extension URLs may not call these actions. */
export function createNotificationSettingsHandlers(deps: Dependencies) {
  const assertSender = (sender: Browser.runtime.MessageSender) => {
    if (
      sender.id !== deps.extensionId ||
      typeof sender.url !== 'string' ||
      (sender.frameId !== undefined && sender.frameId !== 0)
    )
      throw new Error('notification-settings.forbidden')
    let url: URL
    try {
      url = new URL(sender.url)
    } catch {
      throw new Error('notification-settings.forbidden')
    }
    url.search = ''
    url.hash = ''
    if (!deps.pageURLs.includes(url.href))
      throw new Error('notification-settings.forbidden')
  }
  const assertEmpty = (
    payload: unknown,
    sender: Browser.runtime.MessageSender
  ) => {
    assertSender(sender)
    if (payload !== undefined)
      throw new Error('notification-settings.invalid-request')
  }
  const capability: MessageBusHandler<'bg.getNotificationCapability'> = async (
    payload,
    sender
  ) => {
    assertEmpty(payload, sender)
    return deps.isSafari()
      ? deps.native.capability()
      : {
          available: deps.browserNotificationsSupported(),
          authorization: deps.browserNotificationsSupported()
            ? 'authorized'
            : 'unavailable',
        }
  }
  const test: MessageBusHandler<'bg.testNotification'> = async (
    payload,
    sender
  ) => {
    assertEmpty(payload, sender)
    // The explicit test button is independent of unsaved category preferences.
    return { status: deps.isSafari() ? await deps.native.test() : 'suppressed' }
  }
  const openSettings: MessageBusHandler<'bg.openNotificationSettings'> = async (
    payload,
    sender
  ) => {
    assertEmpty(payload, sender)
    return { opened: deps.isSafari() && (await deps.native.openSettings()) }
  }
  const get: MessageBusHandler<'bg.getNotificationsConfig'> = async (
    payload,
    sender
  ) => {
    assertEmpty(payload, sender)
    return deps.store.get()
  }
  const set: MessageBusHandler<'bg.setNotificationsConfig'> = async (
    payload,
    sender
  ) => {
    assertSender(sender)
    const parsed = configSchema.safeParse(payload)
    if (!parsed.success)
      throw new Error('notification-settings.invalid-request')
    await deps.store.set(parsed.data)
    return { ok: true }
  }
  return { capability, test, openSettings, get, set }
}
