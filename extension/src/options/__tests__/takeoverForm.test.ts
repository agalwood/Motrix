import { describe, expect, it } from 'vitest'
import { configToForm, formToConfig } from '@/options/takeoverForm'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

describe('takeoverForm', () => {
  it('derives empty form from the default config', () => {
    expect(configToForm(TAKEOVER_DEFAULT)).toEqual({
      downloadMode: 'direct',
      enabled: false,
      thresholdMB: '',
      unknownSizeAction: 'chrome',
      denylist: '',
    })
  })

  it('round-trips threshold + denylist through rules', () => {
    const form = {
      downloadMode: 'direct',
      enabled: true,
      thresholdMB: '10',
      unknownSizeAction: 'motrix' as const,
      denylist: 'ads.example.com\ntracker.test',
    }
    const cfg = formToConfig(form, TAKEOVER_DEFAULT.consentAckVersion)
    expect(cfg.enabled).toBe(true)
    expect(
      cfg.rules.some((r) => r.match.minSizeMB === 10 && r.action === 'chrome')
    ).toBe(true)
    expect(
      cfg.rules
        .filter((r) => r.action === 'chrome' && r.match.domains)
        .flatMap((r) => r.match.domains ?? [])
    ).toEqual(['ads.example.com', 'tracker.test'])
    expect(configToForm(cfg)).toEqual(form)
  })

  it('drops the threshold rule when thresholdMB is empty or 0', () => {
    const cfg = formToConfig(
      {
        downloadMode: 'direct',
        enabled: true,
        thresholdMB: '0',
        unknownSizeAction: 'chrome',
        denylist: '',
      },
      1
    )
    expect(cfg.rules.some((r) => typeof r.match.minSizeMB === 'number')).toBe(
      false
    )
  })
})
