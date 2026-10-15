import { adapterRegistry } from '@/adapters/index'
import {
  type AdapterDecl,
  type SiteAdapter,
  urlPatternToRegex,
} from '@/adapters/SiteAdapter'

/**
 * Background-side adapter registry. Holds only adapter metadata —
 * SiteAdapter.resolve() lives in the content script, not here, because
 * extraction needs access to the live tab's DOM/cookies.
 */
export class BgAdapterRegistry {
  private readonly entries: Array<{
    decl: AdapterDecl
    regexes: RegExp[]
  }>

  constructor(adapters: SiteAdapter[] = adapterRegistry) {
    this.entries = adapters.map((a) => ({
      decl: {
        id: a.id,
        version: a.version,
        urlPatterns: a.urlPatterns,
        capabilities: a.capabilities,
      },
      regexes: a.urlPatterns.map(urlPatternToRegex),
    }))
  }

  /** Adapter decls for motrix/initialize.adapters[]. */
  list(): AdapterDecl[] {
    return this.entries.map((e) => e.decl)
  }

  /** Find the adapter that owns this URL, or null if none match. */
  findFor(url: string): AdapterDecl | null {
    for (const e of this.entries) {
      if (e.regexes.some((r) => r.test(url))) return e.decl
    }
    return null
  }
}
