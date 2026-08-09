import type { SupportedLocale } from '@shared/constants/locales'

export interface LocaleCoordinatorOptions {
  initialLocale: SupportedLocale
  onAppliedLocale?: (locale: SupportedLocale) => void
  applyLocale: (
    locale: SupportedLocale,
    isCurrent: () => boolean
  ) => Promise<void> | void
  emitLocaleChanged: (locale: SupportedLocale) => void
}

/** Serializes locale side effects and reconciles targets attached after boot. */
export class LocaleCoordinator {
  private desiredLocale: SupportedLocale
  private tail: Promise<void> = Promise.resolve()
  private revision = 0
  private appliedRevision = -1

  constructor(private readonly options: LocaleCoordinatorOptions) {
    this.desiredLocale = options.initialLocale
  }

  get currentLocale(): SupportedLocale {
    return this.desiredLocale
  }

  update(locale: SupportedLocale, emitChange: boolean): Promise<void> {
    this.desiredLocale = locale
    this.revision += 1
    const revision = this.revision
    return this.enqueue(locale, revision, emitChange)
  }

  /** Apply the newest desired locale to targets that became available late. */
  async reconcile(): Promise<void> {
    for (;;) {
      const appliedRevision = await this.enqueueReconciliation()
      if (appliedRevision === this.revision) return
    }
  }

  private enqueueReconciliation(): Promise<number> {
    const pending = this.tail.then(async () => {
      const appliedRevision = this.revision
      await this.applyIfCurrent(this.desiredLocale, appliedRevision, true)
      return appliedRevision
    })
    this.tail = pending.then(
      () => {},
      () => {}
    )
    return pending
  }

  private enqueue(
    locale: SupportedLocale,
    revision: number,
    emitChange: boolean
  ): Promise<void> {
    const pending = this.tail.then(async () => {
      const applied = await this.applyIfCurrent(locale, revision)
      if (applied && emitChange) this.options.emitLocaleChanged(locale)
    })
    // A failed transition is reported to its caller, while later settings
    // changes remain able to repair the runtime state.
    this.tail = pending.catch(() => {})
    return pending
  }

  private async applyIfCurrent(
    locale: SupportedLocale,
    revision: number,
    force = false
  ): Promise<boolean> {
    const isCurrent = () => revision === this.revision
    if (!isCurrent()) return false
    if (!force && this.appliedRevision === revision) return true
    await this.options.applyLocale(locale, isCurrent)
    if (!isCurrent()) return false
    this.options.onAppliedLocale?.(locale)
    this.appliedRevision = revision
    return true
  }
}
