import { describe, expect, it } from 'vitest'
import en from '@/shared/locales/en-US.json'
import { SUPPORTED_LOCALES } from '@/shared/supportedLocales'

const locales = import.meta.glob('../*.json', {
  eager: true,
  import: 'default',
})

function entries(value: unknown, prefix = ''): [string, unknown][] {
  if (value === null || typeof value !== 'object') return [[prefix, value]]
  return Object.entries(value).flatMap(([key, child]) =>
    entries(child, prefix ? `${prefix}.${key}` : key)
  )
}

function placeholders(value: string): string[] {
  return (value.match(/{{\s*[^{}]+\s*}}/g) ?? []).sort()
}

function keys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object') return [prefix]
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    keys(v, prefix ? `${prefix}.${k}` : k)
  )
}

describe('locale parity', () => {
  it('ships exactly the supported UI languages', () => {
    expect(
      Object.keys(locales)
        .map((path) => path.slice(3, -5))
        .sort()
    ).toEqual([...SUPPORTED_LOCALES].sort())
  })
  it.each(SUPPORTED_LOCALES)(
    '%s has complete strings and matching placeholders',
    (locale) => {
      const translated = locales[`../${locale}.json`]
      expect(new Set(keys(translated))).toEqual(new Set(keys(en)))
      const reference = new Map(entries(en))
      for (const [key, value] of entries(translated)) {
        expect(typeof value, `${locale}:${key}`).toBe('string')
        expect((value as string).trim(), `${locale}:${key}`).not.toBe('')
        expect(placeholders(value as string), `${locale}:${key}`).toEqual(
          placeholders(reference.get(key) as string)
        )
      }
    }
  )
  it('has the new options.tabs keys', () => {
    const k = new Set(keys(en))
    for (const t of [
      'options.tabs.general',
      'options.tabs.download',
      'options.tabs.integration',
      'options.tabs.help',
      'options.common.apply',
      'options.appearance.theme.label',
      'options.help.title',
      'options.about.website',
      'options.notifications.title',
      'options.notifications.masterLabel',
      'options.notifications.confirmLabel',
      'options.notifications.errorLabel',
      'options.notifications.reminderLabel',
      'notify.pairRevokedTitle',
      'notify.pairRevokedBody',
      'badge.tooltip.connected',
      'badge.tooltip.disconnected',
      'badge.tooltip.connecting',
      'badge.tooltip.downloading',
      'badge.tooltip.denied',
      'badge.tooltip.error',
    ]) {
      expect(k.has(t)).toBe(true)
    }
  })
})
