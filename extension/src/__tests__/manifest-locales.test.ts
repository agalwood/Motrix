import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import manifestConfig from '#manifest-config'

// The Chrome Web Store only offers a language in the listing editor
// (description, screenshots) when the manifest declares it through
// `default_locale` + `_locales/<code>/messages.json`. Keep every locale we
// ship complete so a store or browser never falls back to an empty string.
const LOCALES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../public/_locales'
)
const DEFAULT_LOCALE = 'en'
const SUPPORTED_STORE_LOCALES = [
  'ar',
  'bg',
  'ca',
  'de',
  'el',
  'en',
  'es',
  'fa',
  'fr',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'nl',
  'no',
  'pl',
  'pt_BR',
  'ro',
  'ru',
  'th',
  'tr',
  'uk',
  'vi',
  'zh_CN',
  'zh_TW',
]
const MANIFEST_MESSAGE_LIMITS = {
  appName: 75,
  appDescription: 132,
} as const

type Messages = Record<string, { message: string; description?: string }>

function listLocales(): string[] {
  if (!existsSync(LOCALES_DIR)) return []
  return readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function readMessages(locale: string): Messages {
  return JSON.parse(
    readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8')
  ) as Messages
}

function placeholders(manifest: unknown): string[] {
  return [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)]
    .map((match) => match[1])
    .filter((key): key is string => typeof key === 'string')
}

async function buildManifest(mode: string) {
  return (await manifestConfig({ command: 'build', mode })) as Record<
    string,
    unknown
  >
}

describe('manifest locales', () => {
  it('ships the default locale and every listing language', () => {
    const locales = listLocales()
    expect(locales).toEqual(SUPPORTED_STORE_LOCALES)
    expect(locales).toContain(DEFAULT_LOCALE)
  })

  it('keeps identical, non-empty message keys across locales', () => {
    const locales = listLocales()
    expect(locales).toContain(DEFAULT_LOCALE)
    const reference = Object.keys(readMessages(DEFAULT_LOCALE)).sort()
    expect(reference.length).toBeGreaterThan(0)
    for (const locale of locales) {
      const messages = readMessages(locale)
      expect(Object.keys(messages).sort()).toEqual(reference)
      for (const [key, entry] of Object.entries(messages)) {
        expect(entry.message.trim(), `${locale}:${key}`).not.toBe('')
        if (entry.description !== undefined) {
          expect(
            entry.description.trim(),
            `${locale}:${key}:description`
          ).not.toBe('')
        }
        const limit =
          MANIFEST_MESSAGE_LIMITS[key as keyof typeof MANIFEST_MESSAGE_LIMITS]
        if (limit !== undefined) {
          expect(
            Array.from(entry.message).length,
            `${locale}:${key}`
          ).toBeLessThanOrEqual(limit)
        }
      }
    }
  })

  for (const mode of ['chromium', 'firefox', 'webstore']) {
    it(`localizes name and description in the ${mode} manifest`, async () => {
      const manifest = await buildManifest(mode)
      expect(manifest.default_locale).toBe(DEFAULT_LOCALE)
      expect(manifest.name).toMatch(/^__MSG_[A-Za-z0-9_@]+__$/)
      expect(manifest.description).toMatch(/^__MSG_[A-Za-z0-9_@]+__$/)

      const keys = placeholders(manifest)
      expect(keys.length).toBeGreaterThan(0)
      for (const locale of listLocales()) {
        const messages = readMessages(locale)
        for (const key of keys) {
          expect(messages[key]?.message, `${locale}:${key}`).toBeTruthy()
        }
      }
    })
  }
})
