import { computeBadge, type IconVariant } from '@/background/badge/computeBadge'
import type { ConnectionState } from '@/background/ConnectionManager'
import { extensionBrowser as browser } from '@/shared/browser'
import { i18n } from '@/shared/i18n'
import type { Notify } from '@/shared/notifications'

const ICONS: Record<IconVariant, Record<number, string>> = {
  color: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
  grey: { 16: 'icons/icon-16-grey.png', 32: 'icons/icon-32-grey.png' },
}

export interface BadgeDeps {
  getState(): ConnectionState
  hasActiveTasks(): boolean
  errorStore: { get(): Promise<boolean>; set(v: boolean): Promise<void> }
}

export class BadgeController {
  constructor(private readonly deps: BadgeDeps) {}

  async refresh(): Promise<void> {
    try {
      const hasUnackError = await this.deps.errorStore.get()
      const visual = computeBadge({
        connection: this.deps.getState(),
        hasActivity: this.deps.hasActiveTasks(),
        hasUnackError,
      })
      // Badge/tooltip first, icon last: if setIcon ever fails, the primary
      // error/activity signal (e.g. the red `!`) has already been applied.
      await browser.action.setBadgeText({ text: visual.badge?.text ?? '' })
      if (visual.badge) {
        await browser.action.setBadgeBackgroundColor({ color: visual.badge.bg })
        await browser.action.setBadgeTextColor?.({ color: visual.badge.fg })
      }
      await browser.action.setTitle({ title: i18n.t(visual.tooltipKey) })
      await browser.action.setIcon({ path: ICONS[visual.icon] })
    } catch {
      // best-effort: action failures must never throw into the SW
    }
  }

  async markError(): Promise<void> {
    await this.deps.errorStore.set(true)
    await this.refresh()
  }

  async clearError(): Promise<void> {
    await this.deps.errorStore.set(false)
    await this.refresh()
  }
}

/**
 * Wrap the injected `notify` so an `error` severity lights the badge and a
 * `confirm` (a success) clears it — ungated by NotificationsConfig, so the
 * badge lights even when OS notifications are muted.
 */
export function makeBadgeNotify(
  base: Notify,
  badge: Pick<BadgeController, 'markError' | 'clearError'>
): Notify {
  const notify: Notify = (n) => {
    base(n)
    if (n.severity === 'error') void badge.markError()
    else if (n.severity === 'confirm') void badge.clearError()
  }
  return Object.assign(
    notify,
    base.taskProgress ? { taskProgress: base.taskProgress } : {}
  )
}
