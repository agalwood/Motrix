import { extensionBrowser as browser } from '@/shared/browser'
import { i18n } from '@/shared/i18n'
import type { Notify } from '@/shared/notifications'

const KEY = 'motrix.takeover.lastPairNudgeAt'
const WINDOW_MS = 24 * 60 * 60 * 1000

export interface PairNudgeDeps {
  notify: Notify
  now?: () => number
}

export class PairNudge {
  private readonly notify: PairNudgeDeps['notify']
  private readonly now: () => number
  constructor(deps: PairNudgeDeps) {
    this.notify = deps.notify
    this.now = deps.now ?? (() => Date.now())
  }

  async maybeNudge(): Promise<void> {
    const obj = await browser.storage.local.get(KEY)
    const last = (obj as Record<string, unknown>)[KEY]
    // lastAt === 0 means "never nudged" — fire immediately regardless of t
    const lastAt = typeof last === 'number' && last > 0 ? last : 0
    const t = this.now()
    if (lastAt > 0 && t - lastAt < WINDOW_MS) return
    await browser.storage.local.set({ [KEY]: t })
    this.notify({
      title: i18n.t('notify.pairNudgeTitle'),
      message: i18n.t('notify.pairNudgeBody'),
      severity: 'reminder',
      kind: 'connection.reminder',
    })
  }
}
