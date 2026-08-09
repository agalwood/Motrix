import { type Browser, makeSessionKey } from '@shared/protocol/bridge'

export type TrustSource = 'builtin' | 'user-added' | 'imported'

export interface TrustedExtension {
  id: string
  browser: Browser
  source: TrustSource
  label?: string
  addedAt: number
}

export interface RegistryStore {
  read(): Promise<string | null>
  write(content: string): Promise<void>
}

const CHROME_ID_RE = /^[a-p]{32}$/
const FIREFOX_ID_RE = /^([^@\s]+@[^@\s]+|\{[0-9a-fA-F-]{36}\})$/

function validateId(id: string, browser: Browser): void {
  if (browser === 'chromium') {
    if (!CHROME_ID_RE.test(id)) {
      throw new Error(`invalid Chrome extension ID: ${id}`)
    }
  } else {
    if (!FIREFOX_ID_RE.test(id)) {
      throw new Error(`invalid Firefox extension ID: ${id}`)
    }
  }
}

export class TrustedExtensionRegistry {
  private entries = new Map<string, TrustedExtension>()
  private builtinIds = new Set<string>()

  constructor(
    private store: RegistryStore,
    private builtin: Array<{ id: string; browser: Browser }>
  ) {}

  async load(): Promise<void> {
    this.entries.clear()
    this.builtinIds.clear()
    for (const b of this.builtin) {
      const e: TrustedExtension = {
        id: b.id,
        browser: b.browser,
        source: 'builtin',
        addedAt: 0,
      }
      this.entries.set(this.key(b.id, b.browser), e)
      this.builtinIds.add(this.key(b.id, b.browser))
    }
    const raw = await this.store.read()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as TrustedExtension[]
      for (const e of parsed) {
        if (e.source === 'builtin') continue
        if (this.builtinIds.has(this.key(e.id, e.browser))) continue
        try {
          validateId(e.id, e.browser)
        } catch {
          continue
        }
        this.entries.set(this.key(e.id, e.browser), e)
      }
    } catch {
      // ignore corrupted store
    }
  }

  list(): TrustedExtension[] {
    return [...this.entries.values()]
  }

  has(id: string, browser: Browser): boolean {
    return this.entries.has(this.key(id, browser))
  }

  async add(
    id: string,
    browser: Browser,
    source: TrustSource,
    label?: string
  ): Promise<void> {
    validateId(id, browser)
    if (source === 'builtin') {
      throw new Error('cannot manually add a builtin entry')
    }
    const k = this.key(id, browser)
    this.entries.set(k, {
      id,
      browser,
      source,
      label,
      addedAt: Date.now(),
    })
    await this.persist()
  }

  async remove(id: string, browser: Browser): Promise<void> {
    const k = this.key(id, browser)
    if (this.builtinIds.has(k)) {
      throw new Error('cannot remove a builtin entry')
    }
    this.entries.delete(k)
    await this.persist()
  }

  listManifestIds(browser: Browser): string[] {
    return [...this.entries.values()]
      .filter((e) => e.browser === browser)
      .map((e) => e.id)
  }

  private key(id: string, browser: Browser): string {
    return makeSessionKey(browser, id)
  }

  private async persist(): Promise<void> {
    const nonBuiltin = [...this.entries.values()].filter(
      (e) => e.source !== 'builtin'
    )
    await this.store.write(JSON.stringify(nonBuiltin))
  }
}
