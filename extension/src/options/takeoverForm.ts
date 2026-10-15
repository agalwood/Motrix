import type {
  DownloadMode,
  TakeoverRule,
  TakeoverSettings,
} from '@/shared/takeover'

export interface TakeoverForm {
  downloadMode: DownloadMode
  enabled: boolean
  thresholdMB: string // '' = none
  unknownSizeAction: TakeoverSettings['unknownSizeAction']
  denylist: string // newline-separated hosts
}

const THRESHOLD_RULE_ID = 'mvp.threshold'

export function configToForm(config: TakeoverSettings): TakeoverForm {
  const threshold = config.rules.find((r) => r.id === THRESHOLD_RULE_ID)?.match
    .minSizeMB
  const denylist = config.rules
    .filter(
      (r) =>
        r.id !== THRESHOLD_RULE_ID && r.action === 'chrome' && r.match.domains
    )
    .flatMap((r) => r.match.domains ?? [])
  return {
    downloadMode: config.downloadMode ?? 'direct',
    enabled: config.enabled,
    thresholdMB: typeof threshold === 'number' ? String(threshold) : '',
    unknownSizeAction: config.unknownSizeAction ?? 'chrome',
    denylist: denylist.join('\n'),
  }
}

export function formToConfig(
  form: TakeoverForm,
  consentAckVersion: number
): TakeoverSettings {
  const rules: TakeoverRule[] = []
  const domains = form.denylist
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const [i, domain] of domains.entries()) {
    rules.push({
      id: `mvp.deny.${i}`,
      match: { domains: [domain] },
      action: 'chrome',
    })
  }
  const mb = Number(form.thresholdMB)
  if (Number.isFinite(mb) && mb > 0) {
    rules.push({
      id: THRESHOLD_RULE_ID,
      match: { minSizeMB: mb },
      action: 'chrome',
    })
  }
  return {
    downloadMode: form.downloadMode ?? 'direct',
    enabled: form.enabled,
    consentAckVersion,
    defaultAction: 'motrix',
    unknownSizeAction: form.unknownSizeAction,
    rules,
  }
}
