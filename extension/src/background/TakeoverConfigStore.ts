import { createOperationQueue } from '@/background/mbp1/operation-queue'
import { extensionBrowser as browser } from '@/shared/browser'
import { withSiteExcluded } from '@/shared/siteExclusion'
import {
  type DownloadMode,
  TAKEOVER_DEFAULT,
  type TakeoverConfig,
  type TakeoverRule,
  type TakeoverSettings,
} from '@/shared/takeover'

const STORAGE_KEY = 'motrix.takeoverConfig'
const enqueue = createOperationQueue()

function isRule(v: unknown): v is TakeoverRule {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.match === 'object' &&
    r.match !== null &&
    (r.action === 'motrix' || r.action === 'chrome' || r.action === 'ask')
  )
}

export class TakeoverConfigStore {
  async get(): Promise<TakeoverConfig> {
    const obj = await browser.storage.local.get(STORAGE_KEY)
    const v = (obj as Record<string, unknown>)[STORAGE_KEY]
    if (!v || typeof v !== 'object') return TAKEOVER_DEFAULT
    const c = v as Partial<TakeoverConfig> & { autoOpenPopup?: unknown }
    if (
      typeof c.enabled !== 'boolean' ||
      typeof c.consentAckVersion !== 'number'
    )
      return TAKEOVER_DEFAULT
    if (c.defaultAction !== 'motrix' && c.defaultAction !== 'chrome')
      return TAKEOVER_DEFAULT
    if (!Array.isArray(c.rules) || !c.rules.every(isRule))
      return TAKEOVER_DEFAULT
    return {
      downloadMode: c.downloadMode === 'confirm' ? 'confirm' : 'direct',
      openTaskPanelAfterSubmit:
        typeof c.openTaskPanelAfterSubmit === 'boolean'
          ? c.openTaskPanelAfterSubmit
          : c.autoOpenPopup === true,
      enabled: c.enabled,
      consentAckVersion: c.consentAckVersion,
      defaultAction: c.defaultAction,
      unknownSizeAction: c.unknownSizeAction === 'motrix' ? 'motrix' : 'chrome',
      rules: c.rules,
    }
  }

  async patchEnabled(
    enabled: boolean,
    consentAckVersion?: number
  ): Promise<TakeoverConfig> {
    return enqueue(async () => {
      if (
        typeof enabled !== 'boolean' ||
        (consentAckVersion !== undefined &&
          (!Number.isInteger(consentAckVersion) || consentAckVersion < 0))
      )
        throw new Error('invalid takeover setting')
      const current = await this.get()
      const next = {
        ...current,
        enabled,
        consentAckVersion:
          consentAckVersion === undefined
            ? current.consentAckVersion
            : Math.max(current.consentAckVersion, consentAckVersion),
      }
      await browser.storage.local.set({ [STORAGE_KEY]: next })
      return next
    })
  }

  async set(config: TakeoverConfig): Promise<void> {
    await enqueue(() => browser.storage.local.set({ [STORAGE_KEY]: config }))
  }

  async patchTakeoverSettings(settings: TakeoverSettings): Promise<void> {
    await enqueue(async () => {
      const current = await this.get()
      await browser.storage.local.set({
        [STORAGE_KEY]: {
          ...current,
          downloadMode:
            settings.downloadMode === 'confirm' ||
            settings.downloadMode === 'direct'
              ? settings.downloadMode
              : current.downloadMode,
          enabled: settings.enabled,
          consentAckVersion: settings.consentAckVersion,
          defaultAction: settings.defaultAction,
          unknownSizeAction:
            settings.unknownSizeAction === 'motrix' ? 'motrix' : 'chrome',
          rules: settings.rules,
        },
      })
    })
  }

  async patchTaskPanelPreference(
    openTaskPanelAfterSubmit: boolean
  ): Promise<TakeoverConfig> {
    return enqueue(async () => {
      if (typeof openTaskPanelAfterSubmit !== 'boolean')
        throw new Error('invalid task panel setting')
      const current = await this.get()
      const next = { ...current, openTaskPanelAfterSubmit }
      await browser.storage.local.set({ [STORAGE_KEY]: next })
      return next
    })
  }

  async patchDownloadMode(downloadMode: DownloadMode): Promise<TakeoverConfig> {
    return enqueue(async () => {
      if (downloadMode !== 'confirm' && downloadMode !== 'direct')
        throw new Error('invalid download mode')
      const next = { ...(await this.get()), downloadMode }
      await browser.storage.local.set({ [STORAGE_KEY]: next })
      return next
    })
  }

  async patchSiteExclusion(
    domain: string,
    excluded: boolean
  ): Promise<TakeoverConfig> {
    return enqueue(async () => {
      const next = withSiteExcluded(await this.get(), domain, excluded)
      await browser.storage.local.set({ [STORAGE_KEY]: next })
      return next
    })
  }
}
