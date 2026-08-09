import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  FALLBACK_LOCALE,
  getLocaleDirection,
  isSupportedLocale,
  type LocaleDirection,
} from '@shared/constants/locales'
import type { ManifestLocaleDict } from '../manifest/i18n-resolve'
import type { I18nSnapshot } from './interface'

export interface I18nCapabilityHostOptions {
  hostLanguage: string
  onListenerError?: (error: unknown) => void
}

export class I18nCapabilityHost {
  private currentLang: string
  private handlers = new Set<(lang: string) => void>()
  private readonly onListenerError?: (error: unknown) => void

  constructor(opts: I18nCapabilityHostOptions) {
    this.currentLang = opts.hostLanguage
    this.onListenerError = opts.onListenerError
  }

  get language(): string {
    return this.currentLang
  }

  get direction(): LocaleDirection {
    return this.directionOf(this.currentLang)
  }

  async snapshot(
    pluginRootDir: string,
    l10nRel?: string
  ): Promise<I18nSnapshot> {
    if (!l10nRel) {
      return {
        language: this.currentLang,
        dir: this.directionOf(this.currentLang),
        currentDict: {},
        fallbackDict: {},
      }
    }
    const fallback = await this.readDict(
      path.join(pluginRootDir, l10nRel, `${FALLBACK_LOCALE}.json`)
    )
    const current = await this.readDict(
      path.join(pluginRootDir, l10nRel, `${this.currentLang}.json`)
    )
    return {
      language: this.currentLang,
      dir: this.directionOf(this.currentLang),
      currentDict: current,
      fallbackDict: fallback,
    }
  }

  private async readDict(p: string): Promise<ManifestLocaleDict> {
    try {
      const text = await readFile(p, 'utf8')
      return flatten(JSON.parse(text) as Record<string, unknown>)
    } catch {
      return {}
    }
  }

  private directionOf(lang: string): LocaleDirection {
    if (isSupportedLocale(lang)) return getLocaleDirection(lang)
    return /^(ar|he|fa|ur)/.test(lang) ? 'rtl' : 'ltr'
  }

  setLanguage(lang: string): void {
    if (lang === this.currentLang) return
    this.currentLang = lang
    for (const handler of this.handlers) {
      try {
        handler(lang)
      } catch (error) {
        // Locale publication is a fan-out boundary: one broken subscriber
        // must not prevent the remaining active plugin VMs from converging.
        try {
          this.onListenerError?.(error)
        } catch {
          // Error reporting is isolated for the same reason.
        }
      }
    }
  }

  onChange(h: (lang: string) => void): () => void {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }
}

// Flatten {nav:{title:'X'}} → {'nav.title':'X'} so resolver + plugin
// i18n.t() see a uniform key space.
function flatten(
  obj: Record<string, unknown>,
  prefix = ''
): ManifestLocaleDict {
  const out: ManifestLocaleDict = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[key] = v
    else if (v && typeof v === 'object')
      Object.assign(out, flatten(v as Record<string, unknown>, key))
  }
  return out
}
