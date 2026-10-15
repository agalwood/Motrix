import { NotificationOutbox } from '@/background/NotificationOutbox'
import { SafariNotificationTransport } from '@/background/SafariNotificationTransport'
import { extensionBrowser as browser } from '@/shared/browser'
import { getBuildBrowser } from '@/shared/browserKind'
import {
  isSeverityEnabled,
  type NotificationSource,
  type NotificationsConfig,
  type NotificationTaskProgress,
  type Notify,
} from '@/shared/notifications'

export function createNotify(
  store: {
    get(): Promise<NotificationsConfig>
  },
  isCurrentSource: (source: NotificationSource) => boolean = () => false
): Notify & { flush(): Promise<void> } {
  const safari = new SafariNotificationTransport()
  const outbox = new NotificationOutbox({
    storage: browser.storage.local,
    preferences: store,
    transport: safari,
    isCurrentSource,
  })
  const notify: Notify = (n) => {
    void (async () => {
      if (getBuildBrowser() === 'safari') {
        await outbox.enqueue(n)
        return
      }
      const cfg = await store.get()
      if (!isSeverityEnabled(cfg, n.severity) || n.isCurrent?.() === false)
        return
      await browser.notifications
        ?.create({
          type: 'basic',
          iconUrl: browser.runtime.getURL('icons/icon-128.png'),
          title: n.title,
          message: n.message,
        })
        .catch(() => {
          // best-effort: a denied notifications permission must not throw
        })
    })().catch(() => {
      // Notification or preference failures must never reject a task event.
    })
  }
  return Object.assign(notify, {
    taskProgress: (progress: NotificationTaskProgress) => {
      if (getBuildBrowser() === 'safari')
        void outbox.observeTaskProgress(progress).catch(() => {})
    },
    flush: async () => {
      if (getBuildBrowser() === 'safari') await outbox.flush().catch(() => {})
    },
  })
}
