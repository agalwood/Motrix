import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { getLogger } from '@core/logger'
import {
  FALLBACK_LOCALE,
  type SupportedLocale,
} from '@shared/constants/locales'
import { AppError, ErrorCode } from '@shared/errors'
import { semverGt } from '@shared/semver'
import type {
  PluginListDTO,
  PluginManifest,
  PluginSource,
  PluginStateRecord,
} from '@shared/types/plugin'
import { FfmpegStaging } from './hooks/staging-dir'
import { readMoextEntry } from './install/moext-reader'
import {
  flattenLocaleDict,
  type ManifestLocaleDict,
  resolveManifestI18n,
} from './manifest/i18n-resolve'
import { parseManifest } from './manifest/parse'
import { resolveInsidePluginDir } from './manifest/path-safety'
import type { PluginStateStore } from './state/plugin-state-store'
import { verifyBuiltinSignature } from './update/signature'

const log = getLogger('plugin:registry')

export interface PluginRegistryOptions {
  pluginsDir: string // community: <userDataDir>/plugins
  builtinDir: string // built-in: <resourcesDir>/builtin-plugins
  stateStore: PluginStateStore
  hostVersion: string // semver, e.g. '2.5.0'
  // BCP-47 tag (e.g. 'zh-CN'). The registry loads <rootDir>/<l10n>/<lang>.json
  // for placeholder resolution and always falls back to the shared catalog's
  // fallback locale.
  hostLanguage?: SupportedLocale
  // <userDataDir>/builtin-updates — signature-verified hot-update overlay for
  // builtin plugins (BuiltinUpdater's write path). Omitted entirely disables
  // the overlay scan (e.g. tests that don't care about it).
  overlayDir?: string
  /** Injectable for tests; defaults to the pinned build-time keys. */
  signingPubkeys?: ReadonlyArray<string>
  /** Injectable locale reader for deterministic prepare/commit race tests. */
  readLocaleFile?: (filePath: string) => Promise<string>
  /** Host-owned gate for writable community plugin directories. */
  communityDirectoryPolicy?: (
    pluginDir: string
  ) => Promise<{ ok: boolean; reason?: string }>
  /** Shell-provided plugin development directory; omitted outside dev mode. */
  devPath?: string
}

export interface IndexedPlugin {
  manifestRaw: PluginManifest
  manifest: PluginManifest
  origin: 'community' | 'builtin'
  rootDir: string
  state: PluginStateRecord
  /**
   * True when this entry was loaded from MOTRIX_PLUGIN_DEV_PATH. Dev plugins
   * bypass the installer + consent flow (spec §7 L2418-2431) and surface a
   * distinct `PluginSource.type === 'dev'` in PluginListDTO so the renderer
   * can render a "Dev mode" badge.
   */
  dev?: boolean
  /**
   * Present when this builtin's effective code was earned from the
   * signature-verified <overlayDir>/<id> hot-update overlay rather than the
   * read-only seed tree. Drives `deriveListSource`'s `builtin-update` source.
   * `signature` is the validated `_overlay.json.signature` (base64, over
   * bundle.moext) — carried through so PluginHost can re-verify bundle.moext
   * at load time without re-reading _overlay.json (Firefox packed-XPI model:
   * manifest AND executed code both come from the verified bundle, never the
   * separately-tamperable extracted tree).
   */
  overlay?: { packageUrl: string; recordedAt: number; signature: string }
}

export interface LoadError {
  pluginDir: string
  code: string
  message: string
}

export interface PluginLocaleDictionaries {
  currentDict: ManifestLocaleDict
  fallbackDict: ManifestLocaleDict
}

interface PreparedPluginLocaleEntry {
  pluginId: string
  indexed: IndexedPlugin
  manifest: PluginManifest
  dictionaries: PluginLocaleDictionaries
}

interface PreparedPluginLocaleChange {
  owner: PluginRegistry
  language: SupportedLocale
  registryRevision: number
  entries: ReadonlyArray<PreparedPluginLocaleEntry>
}

export interface HostLanguageTransactionOptions {
  /** Runs after all plugin files are prepared, immediately before commit. */
  beforeCommit?: () => Promise<void> | void
  /** Must synchronously publish the same locale to the capability host. */
  commitHostLocale: () => void
  /** Restores the host if commitHostLocale unexpectedly throws. */
  rollbackHostLocale: (
    previousLanguage: SupportedLocale
  ) => Promise<void> | void
  /** Cancels stale work before beforeCommit and again before synchronous commit. */
  shouldCommit?: () => boolean
}

export class PluginRegistry {
  private readonly byId = new Map<string, IndexedPlugin>()
  private readonly errors: LoadError[] = []
  private readonly localeDictionaries = new Map<
    string,
    PluginLocaleDictionaries
  >()
  private discoveryTail: Promise<void> = Promise.resolve()
  private registryRevision = 0
  private currentLang: SupportedLocale

  constructor(private readonly opts: PluginRegistryOptions) {
    this.currentLang = opts.hostLanguage ?? FALLBACK_LOCALE
  }

  private async loadLocale(
    rootDir: string,
    l10n: string | undefined,
    lang: string
  ): Promise<ManifestLocaleDict> {
    if (!l10n) return {}
    // Contain l10n to the plugin dir: a "../../etc" l10n must not read JSON
    // from outside the plugin (its strings surface in the manifest UI).
    const localeDir = resolveInsidePluginDir(rootDir, l10n)
    if (!localeDir) return {}
    try {
      const localePath = path.join(localeDir, `${lang}.json`)
      const raw = this.opts.readLocaleFile
        ? await this.opts.readLocaleFile(localePath)
        : await readFile(localePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return {}
      // Flatten nested entries to dotted keys so manifest placeholders like
      // %nav.title% resolve (matching the runtime i18n.t key space) instead of
      // silently failing when only top-level strings were kept.
      return flattenLocaleDict(parsed as Record<string, unknown>)
    } catch {
      return {}
    }
  }

  private async prepareManifestLocale(
    manifest: PluginManifest,
    rootDir: string,
    language: SupportedLocale
  ): Promise<{
    manifest: PluginManifest
    dictionaries: PluginLocaleDictionaries
  }> {
    const l10n = (manifest as { l10n?: string }).l10n
    // When the active language is the fallback locale, both dictionaries come
    // from the same file, so load it once; otherwise fetch both in parallel.
    let current: ManifestLocaleDict
    let fallback: ManifestLocaleDict
    if (language === FALLBACK_LOCALE) {
      current = await this.loadLocale(rootDir, l10n, FALLBACK_LOCALE)
      fallback = current
    } else {
      ;[current, fallback] = await Promise.all([
        this.loadLocale(rootDir, l10n, language),
        this.loadLocale(rootDir, l10n, FALLBACK_LOCALE),
      ])
    }
    const dictionaries = {
      currentDict: current,
      fallbackDict: fallback,
    }
    try {
      return {
        manifest: resolveManifestI18n(manifest, dictionaries),
        dictionaries,
      }
    } catch (e) {
      // resolveManifestI18n throws on mixed-placeholder; leave manifest
      // as-is so the registry still indexes the plugin and the load
      // error surfaces in errors[].
      log.warn(
        { err: e, pluginId: manifest.id },
        'i18n resolution failed; falling back to raw manifest'
      )
      return { manifest, dictionaries }
    }
  }

  private async i18nResolve(
    manifest: PluginManifest,
    rootDir: string
  ): Promise<PluginManifest> {
    const prepared = await this.prepareManifestLocale(
      manifest,
      rootDir,
      this.currentLang
    )
    this.localeDictionaries.set(manifest.id, prepared.dictionaries)
    return prepared.manifest
  }

  discover(): Promise<void> {
    const pending = this.discoveryTail.then(() => this.performDiscover())
    this.discoveryTail = pending.catch(() => {})
    return pending
  }

  private async performDiscover(): Promise<void> {
    this.registryRevision += 1
    try {
      try {
        await FfmpegStaging.cleanupOrphans(this.opts.pluginsDir)
      } catch (e) {
        log.warn({ err: e }, 'ffmpeg staging orphan cleanup failed; continuing')
      }
      this.byId.clear()
      this.errors.length = 0
      this.localeDictionaries.clear()
      await this.scanInto(this.opts.builtinDir, 'builtin')
      if (this.opts.overlayDir) await this.applyOverlay(this.opts.overlayDir)
      await this.scanInto(this.opts.pluginsDir, 'community')
      const devPath = this.opts.devPath
      if (devPath) {
        try {
          const raw = await readFile(
            path.join(devPath, 'motrix-plugin.json'),
            'utf8'
          )
          const { manifest } = parseManifest(raw, {
            hostVersion: this.opts.hostVersion,
            origin: 'community',
          })
          const resolved = await this.i18nResolve(manifest, devPath)
          const state = this.getOrCreateState(resolved.id)
          this.byId.set(resolved.id, {
            manifestRaw: manifest,
            manifest: resolved,
            origin: 'community',
            rootDir: devPath,
            state,
            dev: true,
          })
        } catch (e: unknown) {
          log.warn(
            { err: e, devPath },
            'MOTRIX_PLUGIN_DEV_PATH: failed to load dev plugin manifest'
          )
        }
      }
    } finally {
      this.registryRevision += 1
    }
  }

  /**
   * Read and resolve every plugin locale without mutating observable registry
   * state. Active bridges therefore continue to see a complete old snapshot
   * for the entire asynchronous prepare phase.
   */
  private async prepareHostLanguage(
    language: SupportedLocale
  ): Promise<PreparedPluginLocaleChange> {
    // Wait for any discovery that was already registered. A later discovery
    // invalidates registryRevision, making commitHostLanguage reject + retry.
    await this.discoveryTail
    const registryRevision = this.registryRevision
    if (language === this.currentLang) {
      return {
        owner: this,
        language,
        registryRevision,
        entries: [],
      }
    }

    const indexedEntries = [...this.byId.values()]
    const entries = await Promise.all(
      indexedEntries.map(async (indexed) => ({
        pluginId: indexed.manifestRaw.id,
        indexed,
        ...(await this.prepareManifestLocale(
          indexed.manifestRaw,
          indexed.rootDir,
          language
        )),
      }))
    )
    return {
      owner: this,
      language,
      registryRevision,
      entries,
    }
  }

  private canCommitHostLanguage(
    prepared: PreparedPluginLocaleChange,
    shouldCommit: () => boolean = () => true
  ): boolean {
    return !(
      !shouldCommit() ||
      prepared.owner !== this ||
      prepared.registryRevision !== this.registryRevision ||
      prepared.entries.some(
        ({ pluginId, indexed }) => this.byId.get(pluginId) !== indexed
      )
    )
  }

  /**
   * Synchronously publishes a validated locale and capability snapshot in the
   * same JavaScript turn. The promise is used only to await exceptional
   * rollback; the successful publication itself contains no async boundary.
   */
  private async commitHostLanguage(
    prepared: PreparedPluginLocaleChange,
    onCommit: () => void,
    onRollback: (previousLanguage: SupportedLocale) => Promise<void> | void,
    shouldCommit: () => boolean = () => true
  ): Promise<boolean> {
    if (!this.canCommitHostLanguage(prepared, shouldCommit)) return false

    const previousLanguage = this.currentLang
    const previousEntries = prepared.entries.map(({ pluginId, indexed }) => ({
      pluginId,
      indexed,
      manifest: indexed.manifest,
      dictionaries: this.localeDictionaries.get(pluginId),
    }))
    this.currentLang = prepared.language
    for (const {
      pluginId,
      indexed,
      manifest,
      dictionaries,
    } of prepared.entries) {
      indexed.manifest = manifest
      this.localeDictionaries.set(pluginId, dictionaries)
    }
    this.registryRevision += 1
    try {
      onCommit()
    } catch (error) {
      this.currentLang = previousLanguage
      for (const {
        pluginId,
        indexed,
        manifest,
        dictionaries,
      } of previousEntries) {
        indexed.manifest = manifest
        if (dictionaries) this.localeDictionaries.set(pluginId, dictionaries)
        else this.localeDictionaries.delete(pluginId)
      }
      this.registryRevision += 1
      try {
        await onRollback(previousLanguage)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'plugin locale commit and rollback both failed'
        )
      }
      throw error
    }
    return true
  }

  /** Atomically switch registry-only consumers such as manifest list tests. */
  async setHostLanguage(language: SupportedLocale): Promise<void> {
    await this.setHostLanguageTransaction(language, {
      commitHostLocale: () => {},
      rollbackHostLocale: () => {},
    })
  }

  /** Prepare asynchronously, then atomically commit registry + host locale. */
  async setHostLanguageTransaction(
    language: SupportedLocale,
    options: HostLanguageTransactionOptions
  ): Promise<boolean> {
    const shouldCommit = options.shouldCommit ?? (() => true)
    for (;;) {
      if (!shouldCommit()) return false
      const prepared = await this.prepareHostLanguage(language)
      if (!this.canCommitHostLanguage(prepared, shouldCommit)) {
        if (!shouldCommit()) return false
        continue
      }

      const previousLanguage = this.currentLang
      try {
        await options.beforeCommit?.()
      } catch (error) {
        try {
          await options.rollbackHostLocale(previousLanguage)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'plugin locale prepare-commit and rollback both failed'
          )
        }
        throw error
      }

      if (!this.canCommitHostLanguage(prepared, shouldCommit)) {
        await options.rollbackHostLocale(previousLanguage)
        if (!shouldCommit()) return false
        continue
      }
      const committed = await this.commitHostLanguage(
        prepared,
        options.commitHostLocale,
        options.rollbackHostLocale,
        shouldCommit
      )
      if (committed) return true
      await options.rollbackHostLocale(previousLanguage)
      if (!shouldCommit()) return false
    }
  }

  private getOrCreateState(pluginId: string): PluginStateRecord {
    const existing = this.opts.stateStore.get(pluginId)
    if (existing) return existing
    const state: PluginStateRecord = {
      pluginId,
      enabled: true,
      status: 'inactive',
      errorCount: 0,
      installedAt: Date.now(),
    }
    this.opts.stateStore.upsert(state)
    return state
  }

  private async scanInto(
    root: string,
    origin: 'community' | 'builtin'
  ): Promise<void> {
    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      throw e
    }
    for (const name of entries) {
      if (origin === 'community' && name.startsWith('_')) continue
      const dir = path.join(root, name)
      try {
        if (origin === 'community' && this.opts.communityDirectoryPolicy) {
          const policy = await this.opts.communityDirectoryPolicy(dir)
          if (!policy.ok) {
            this.errors.push({
              pluginDir: dir,
              code: ErrorCode.PluginManifestInvalid,
              message: policy.reason ?? 'plugin.lifecycle.unsigned_not_allowed',
            })
            continue
          }
        }
        const raw = await readFile(path.join(dir, 'motrix-plugin.json'), 'utf8')
        const { manifest } = parseManifest(raw, {
          hostVersion: this.opts.hostVersion,
          origin,
        })
        if (manifest.id !== name) {
          this.errors.push({
            pluginDir: dir,
            code: 'plugin.manifest.id_mismatch_with_dir',
            message: `manifest id "${manifest.id}" does not match directory name "${name}"`,
          })
          continue
        }
        if (this.byId.has(manifest.id)) {
          this.errors.push({
            pluginDir: dir,
            code: 'plugin.manifest.duplicate_id',
            message: `duplicate plugin id "${manifest.id}"`,
          })
          continue
        }
        const resolved = await this.i18nResolve(manifest, dir)
        const state = this.getOrCreateState(resolved.id)
        this.byId.set(resolved.id, {
          manifestRaw: manifest,
          manifest: resolved,
          origin,
          rootDir: dir,
          state,
        })
      } catch (e: unknown) {
        // For AppError (PluginManifestInvalid / PluginEngineVersionTooOld),
        // surface the enum string value (e.g. 'PLUGIN_ENGINE_VERSION_TOO_OLD').
        // For unknown errors, fall back to 'PLUGIN_MANIFEST_INVALID'.
        const code =
          e instanceof AppError ? e.code : ErrorCode.PluginManifestInvalid
        this.errors.push({
          pluginDir: dir,
          code,
          message: (e as Error).message,
        })
      }
    }
  }

  /**
   * Signature-gated builtin hot-update overlay pass (2026-07-18 design §3
   * consumer half). Runs after the builtin seed scan and before the
   * community scan. CRITICAL INVARIANT: origin 'builtin' is EARNED here by
   * re-verifying the stored bundle.moext against _overlay.json.signature and
   * the pinned keys on EVERY scan — the overlay lives in OS-writable
   * userData, so an unverified entry is an attack, not a plugin.
   */
  private async applyOverlay(root: string): Promise<void> {
    let names: string[] = []
    try {
      names = await readdir(root)
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    for (const name of names) {
      if (name.startsWith('.tmp-') || name.startsWith('.bak-')) continue
      const dir = path.join(root, name)
      const drop = () => rm(dir, { recursive: true, force: true })

      // Every step below runs inside this per-entry guard: the overlay dir
      // is OS-writable userData, so ANY unexpected throw here (a shape we
      // didn't anticipate, a downstream helper misbehaving, ...) must be
      // treated the same as a known-corrupt entry — log + drop + keep
      // scanning — rather than escaping applyOverlay and failing the whole
      // discover() call. The deliberate PluginEngineVersionTooOld
      // ignore-not-delete branch below uses a bare `continue`, which skips
      // this catch entirely (as intended — that path is not corruption).
      try {
        // 1. Signature gate — origin 'builtin' is EARNED here, never assumed
        //    from directory location (the overlay lives in OS-writable
        //    userData; an unsigned entry is an attack, not a plugin).
        let meta: unknown
        let bundle: Buffer
        try {
          meta = JSON.parse(
            await readFile(path.join(dir, '_overlay.json'), 'utf8')
          )
          bundle = await readFile(path.join(dir, 'bundle.moext'))
        } catch {
          await drop()
          continue
        }
        // JSON.parse succeeds on plenty of non-object input (`null`, `42`,
        // `"str"`, ...) — validate SHAPE before touching meta.signature /
        // meta.packageUrl / meta.recordedAt, or a malformed-but-parseable
        // file crashes the property access outside any try/catch.
        if (!isValidOverlayMeta(meta)) {
          log.warn({ dir }, 'malformed overlay metadata dropped')
          await drop()
          continue
        }
        if (
          !verifyBuiltinSignature(
            bundle,
            meta.signature,
            this.opts.signingPubkeys
          )
        ) {
          log.warn({ dir }, 'unsigned/tampered builtin overlay dropped')
          await drop()
          continue
        }

        // 2. Orphan gate — a builtin retired from the seed set retires its
        //    overlay. Uses the seed DIRECTORY, not the parsed map: a corrupt
        //    seed manifest must never trigger overlay deletion.
        let seedDirExists = true
        try {
          await readFile(
            path.join(this.opts.builtinDir, name, 'motrix-plugin.json'),
            'utf8'
          )
        } catch {
          seedDirExists = false
        }
        if (!seedDirExists) {
          await drop()
          continue
        }

        // 3. Parse the manifest from the VERIFIED BUNDLE, never the tree
        //    (Firefox packed-XPI model — 2026-07-18 design §4). The
        //    extracted tree is OS-writable and, from here on, serves
        //    display-only assets (l10n) only; the signature gate above only
        //    proves bundle.moext's bytes are untampered, so the manifest we
        //    trust must come from those same bytes, not a sibling file an
        //    attacker could edit independently. Engine incompatibility is
        //    IGNORED (not deleted — an app upgrade may revalidate it); a
        //    missing entry or parse failure is corruption (deleted — seed is
        //    the availability floor).
        let manifest: PluginManifest
        try {
          const manifestBytes = await readMoextEntry(
            bundle,
            'motrix-plugin.json'
          )
          if (!manifestBytes) {
            log.warn(
              { dir },
              'overlay bundle missing motrix-plugin.json; dropped'
            )
            await drop()
            continue
          }
          manifest = parseManifest(manifestBytes.toString('utf8'), {
            hostVersion: this.opts.hostVersion,
            origin: 'builtin',
          }).manifest as PluginManifest
        } catch (e: unknown) {
          if (
            e instanceof AppError &&
            e.code === ErrorCode.PluginEngineVersionTooOld
          ) {
            continue
          }
          log.warn({ dir }, 'corrupt overlay manifest dropped')
          await drop()
          continue
        }
        if (manifest.id !== name) {
          log.warn({ dir }, 'overlay manifest id mismatch dropped')
          await drop()
          continue
        }

        // 4. Arbitration vs the parsed seed (if the seed parsed at all).
        const seed = this.byId.get(manifest.id)
        if (seed && !semverGt(manifest.version, seed.manifest.version)) {
          // seed >= overlay → Chrome-style retirement of the stale overlay
          await drop()
          continue
        }

        const resolved = await this.i18nResolve(manifest, dir)
        const state = this.getOrCreateState(resolved.id)
        this.byId.set(resolved.id, {
          manifestRaw: manifest,
          manifest: resolved,
          origin: 'builtin',
          rootDir: dir,
          state,
          overlay: {
            packageUrl: meta.packageUrl,
            recordedAt: meta.recordedAt,
            signature: meta.signature,
          },
        })
      } catch (e: unknown) {
        log.warn(
          { err: e, dir },
          'unexpected error scanning builtin overlay entry; dropped'
        )
        await drop()
      }
    }
  }

  get(pluginId: string): IndexedPlugin | undefined {
    return this.byId.get(pluginId)
  }

  /**
   * Return the dictionaries loaded while resolving a plugin manifest. The
   * runtime capability host consumes this cache so manifest placeholders and
   * `motrix.i18n.t()` always switch from the same locale snapshot.
   */
  getLocaleDictionaries(pluginId: string): PluginLocaleDictionaries {
    return (
      this.localeDictionaries.get(pluginId) ?? {
        currentDict: {},
        fallbackDict: {},
      }
    )
  }

  /**
   * Re-read the plugin's row from the PluginStateStore and write it back into
   * the in-memory IndexedPlugin.state. Call after any external mutation of the
   * state store (Commands.Enable/DisablePlugin, PluginHost lifecycle writes)
   * so downstream readers — list(), PluginHost.activate gating,
   * ActivationDispatcher, CrossPluginInvoker — see fresh values without
   * waiting for a process restart / re-discover.
   */
  refreshState(pluginId: string): void {
    const entry = this.byId.get(pluginId)
    if (!entry) return
    const fresh = this.opts.stateStore.get(pluginId)
    if (fresh) entry.state = fresh
  }

  /**
   * Minimal indexed view consumed by the query helpers in @core/plugin/queries.
   * Decouples those helpers from `IndexedPlugin`'s state row, which is heavier
   * than they need (they care only about `manifest`, `origin`, `enabled`).
   */
  entries(): Array<{
    manifest: PluginManifest
    origin: 'community' | 'builtin'
    enabled: boolean
  }> {
    const out: Array<{
      manifest: PluginManifest
      origin: 'community' | 'builtin'
      enabled: boolean
    }> = []
    for (const p of this.byId.values()) {
      out.push({
        manifest: p.manifest,
        origin: p.origin,
        enabled: p.state.enabled,
      })
    }
    return out
  }

  list(): PluginListDTO[] {
    const out: PluginListDTO[] = []
    for (const p of this.byId.values()) {
      out.push({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        status: p.state.status,
        enabled: p.state.enabled,
        permissions: p.manifest.permissions,
        optionalPermissions: p.manifest.optionalPermissions ?? [],
        errorCount: p.state.errorCount,
        lastError: p.state.lastError,
        source: deriveListSource(p),
      })
    }
    return out
  }

  loadErrors(): ReadonlyArray<LoadError> {
    return this.errors
  }
}

/**
 * Type guard for `_overlay.json` contents. JSON.parse alone is not enough —
 * it happily accepts `null`, `42`, `"str"`, `{}`, etc. as valid JSON, and an
 * unguarded `meta.signature` access on any of those throws a TypeError that
 * would otherwise escape applyOverlay's per-entry try/catch.
 */
function isValidOverlayMeta(
  value: unknown
): value is { packageUrl: string; signature: string; recordedAt: number } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.signature === 'string' &&
    typeof v.packageUrl === 'string' &&
    typeof v.recordedAt === 'number'
  )
}

function deriveListSource(p: IndexedPlugin): PluginSource | undefined {
  if (p.origin === 'builtin') {
    return p.overlay
      ? {
          type: 'builtin-update',
          url: p.overlay.packageUrl,
          recordedAt: p.overlay.recordedAt,
        }
      : { type: 'builtin', url: 'builtin', recordedAt: 0 }
  }
  if (p.dev) {
    return { type: 'dev', url: p.rootDir, recordedAt: 0 }
  }
  return undefined
}
