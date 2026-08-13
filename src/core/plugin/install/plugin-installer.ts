// Orchestrates the install / upgrade / uninstall lifecycle for a plugin.
//
// The install flow is two-phase:
//   1. `stage(moextPath, sourceInput)` — extracts to a staging dir, parses
//      the manifest, computes the consent payload (and any diff against an
//      existing install), and returns `{stagingId, consent}`. The renderer
//      then shows a dialog.
//   2. `commit(stagingId, grants)` — finalizes the install. On upgrade we
//      run onDeactivate, rename the old dir to a backup, swap in the new
//      one, write `_install.json`, refresh the registry, and remove the
//      backup. On failure mid-swap, the backup is restored.
//
// `uninstall(pluginId)` is the I14 cascade: deactivate → drop plugin state
// row → purge plugin_storage + plugin_task_metadata + plugin_cookie_jar →
// remove the install directory → refresh registry.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { FALLBACK_LOCALE } from '@shared/constants/locales'
import { AppError, ErrorCode } from '@shared/errors'
import { REGISTRY_PLUGIN_ID_RE } from '@shared/schemas/registry'
import type { PluginManifest } from '@shared/types/plugin'
import type {
  ConsentPayload,
  ConsentSnapshot,
  GrantsMap,
  InstallRecord,
  InstallRecordSource,
} from '@shared/types/plugin-install'
import type { FfmpegDetection } from '../capabilities/ffmpeg-detect'
import type { CapabilityHost } from '../capabilities/interface'
import {
  type ManifestLocaleDict,
  resolveManifestI18n,
} from '../manifest/i18n-resolve'
import { parseManifest } from '../manifest/parse'
import { resolveInsidePluginDir } from '../manifest/path-safety'
import type { PluginRegistry } from '../plugin-registry'
import type { PluginStateStore } from '../state/plugin-state-store'
import { buildConsentPayload } from './consent-payload'
import { ffmpegSatisfies } from './ffmpeg-semver'
import {
  diffTrustSurface,
  readInstallRecord,
  requiresConsent,
  writeInstallRecord,
} from './install-record'
import { extractLoadedMoext, loadMoext } from './moext-reader'
import { computePublicCommandHashes } from './public-command-hash'
import {
  assertMatchesRegistryExpectation,
  type RegistryExpectation,
} from './registry-expectation'
import {
  normalizeSource,
  type SourceInput,
  sourceUrlEquals,
} from './source-resolver'

// Plan D will provide a real `SchemaCache`. Until then, the installer accepts
// any object exposing this minimal shape. When Plan D lands, swap the import.
export interface CommandSchemaCacheLike {
  installCommandSchemas(
    pluginId: string,
    commands: ReadonlyArray<{
      id: string
      argsSchema?: unknown
      resultSchema?: unknown
      public?: boolean
    }>
  ): void
  uninstall(pluginId: string): void
}

/**
 * Runtime teardown seam shared by the Electron and server plugin hosts.
 * `deactivate()` does not resolve until the worker bridge has been disposed.
 */
export interface PluginRuntimeHostLike {
  isQuiescent(pluginId: string): boolean
  deactivate(pluginId: string): Promise<void>
}

export interface PluginInstallerOptions {
  pluginsDir: string
  registry: PluginRegistry
  stateStore: PluginStateStore
  capabilityHost: CapabilityHost
  hostVersion: string
  /**
   * Optional Plan D dependency. Until Plan D lands, the installer falls
   * back to local hash computation only.
   */
  schemaCache?: CommandSchemaCacheLike
  /**
   * Server-only hook. Returns `{ok:false, reason}` to reject installation
   * before the consent payload is built. Inject `isServerAckSatisfied` here
   * on the server runtime; leave undefined on Electron.
   */
  serverAck?: (
    source: InstallRecordSource,
    prevRecord: InstallRecord | null
  ) => { ok: boolean; reason?: string }
  /**
   * Snapshots ffmpeg availability at install time. Required when manifests
   * declaring `ffmpeg` permission/optionalPermission are installed; optional
   * otherwise (the gate becomes a no-op).
   */
  ffmpegDetect?: () => Promise<FfmpegDetection>
}

interface StagedInstall {
  pluginId: string
  newManifest: PluginManifest
  source: InstallRecordSource
  stagingDir: string
  consent: ConsentPayload
  archivePath: string
  archiveSha256: string
  previousRecord: InstallRecord | null
  runtimeHost?: PluginRuntimeHostLike
}

export interface StageResult {
  stagingId: string
  consent: ConsentPayload
  /** True when a trust-equivalent upgrade committed without another prompt. */
  committed: boolean
  /** Present when `committed` is true. */
  pluginId?: string
}

export interface StageOptions {
  /** §6.3 registry↔manifest consistency gate; checked before any commit. */
  expect?: RegistryExpectation
  /** Digest pinned by a non-registry source such as server bootstrap. */
  expectedSha256?: string
  /** Runtime teardown seam supplied by the shell command boundary. */
  runtimeHost?: PluginRuntimeHostLike
}

async function loadManifestLocale(
  rootDir: string,
  l10n: string | undefined,
  lang: string
): Promise<ManifestLocaleDict> {
  if (!l10n) return {}
  const localeDir = resolveInsidePluginDir(rootDir, l10n)
  if (!localeDir) return {}
  try {
    const raw = await readFile(path.join(localeDir, `${lang}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    const out: ManifestLocaleDict = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

async function resolveManifestForInstall(
  manifest: PluginManifest,
  rootDir: string
): Promise<PluginManifest> {
  const l10n = (manifest as { l10n?: string }).l10n
  const fallback = await loadManifestLocale(rootDir, l10n, FALLBACK_LOCALE)
  return resolveManifestI18n(manifest, {
    currentDict: fallback,
    fallbackDict: fallback,
  })
}

function resolvePluginInstallDir(pluginsDir: string, pluginId: string): string {
  if (!REGISTRY_PLUGIN_ID_RE.test(pluginId)) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.invalid_plugin_id'
    )
  }

  const root = path.resolve(pluginsDir)
  const candidate = path.resolve(root, pluginId)
  const relative = path.relative(root, candidate)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.invalid_plugin_id'
    )
  }
  return candidate
}

function sameInstallRecord(
  left: InstallRecord | null,
  right: InstallRecord | null
): boolean {
  if (left === null || right === null) return left === right
  return JSON.stringify(left) === JSON.stringify(right)
}

export class PluginInstaller {
  private readonly pending = new Map<string, StagedInstall>()
  private readonly mutationTails = new Map<string, Promise<void>>()

  constructor(private readonly opts: PluginInstallerOptions) {}

  async stage(
    moextPath: string,
    sourceInput: SourceInput,
    options?: StageOptions
  ): Promise<StageResult> {
    const stagingDir = path.join(
      this.opts.pluginsDir,
      '_staging',
      `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    )
    const extractedDir = path.join(stagingDir, 'tree')
    const archivePath = path.join(stagingDir, 'archive.moext')
    const loadedMoext = await loadMoext(moextPath)
    const pinnedSha256 =
      sourceInput.type === 'local'
        ? sourceInput.fileHash
        : (options?.expectedSha256 ?? options?.expect?.packageSha256)
    if (pinnedSha256 && loadedMoext.archiveSha256 !== pinnedSha256) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        sourceInput.type === 'local'
          ? 'plugin.install.local_file_hash_mismatch'
          : 'plugin.install.sha256_mismatch'
      )
    }

    let manifestRaw: string
    let bundleSha256: string
    try {
      const extracted = await extractLoadedMoext(loadedMoext, extractedDir)
      manifestRaw = extracted.manifestRaw
      bundleSha256 = extracted.bundleSha256
      // Consent can remain open indefinitely. Keep the exact package on disk
      // instead of retaining up to 5 MiB in the installer's pending Map.
      await writeFile(archivePath, loadedMoext.bytes, {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true })
      throw error
    }

    let parsedManifest: PluginManifest
    try {
      const result = parseManifest(manifestRaw, {
        hostVersion: this.opts.hostVersion,
      })
      parsedManifest = await resolveManifestForInstall(
        result.manifest as PluginManifest,
        extractedDir
      )
    } catch (e) {
      await rm(stagingDir, { recursive: true, force: true })
      throw e
    }

    if (options?.expect) {
      try {
        assertMatchesRegistryExpectation(parsedManifest, options.expect)
      } catch (e) {
        await rm(stagingDir, { recursive: true, force: true })
        throw e
      }
    }

    const normalized = normalizeSource(sourceInput)
    const source: InstallRecordSource = {
      type: normalized.type,
      url: normalized.url,
      bundleSha256,
      recordedAt: Date.now(),
    }
    const finalDir = resolvePluginInstallDir(
      this.opts.pluginsDir,
      parsedManifest.id
    )
    const prev = await readInstallRecord(finalDir)

    if (this.opts.serverAck) {
      const r = this.opts.serverAck(source, prev)
      if (!r.ok) {
        await rm(stagingDir, { recursive: true, force: true })
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          r.reason ?? 'plugin.lifecycle.unsigned_not_allowed'
        )
      }
    }

    // I6 — plugin id is immutable across upgrades.
    if (prev && prev.pluginId !== parsedManifest.id) {
      await rm(stagingDir, { recursive: true, force: true })
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.manifest.id_collision_with_builtin'
      )
    }

    const nextSnapshot: ConsentSnapshot = {
      permissions: parsedManifest.permissions,
      optionalPermissions: parsedManifest.optionalPermissions ?? [],
      invokesCommands: parsedManifest.invokesCommands ?? [],
      publicCommands: computePublicCommandHashes(parsedManifest),
      requestedHeapMB: parsedManifest.requestedHeapMB ?? 32,
      enginesMotrix: parsedManifest.engines.motrix,
      hostPermissions: parsedManifest.hostPermissions ?? [],
    }

    let diff = prev ? diffTrustSurface(prev, nextSnapshot) : null
    if (prev && diff) {
      if (!sourceUrlEquals(prev.source, source)) {
        diff = {
          ...diff,
          sourceUrlChanged: { from: prev.source.url, to: source.url },
        }
      }
    }
    const needConsent = !prev || (diff !== null && requiresConsent(diff))

    const needsFfmpeg =
      parsedManifest.permissions.includes('ffmpeg') ||
      (parsedManifest.optionalPermissions ?? []).includes('ffmpeg')

    let ffmpegDetection: FfmpegDetection = { available: false }
    if (needsFfmpeg && this.opts.ffmpegDetect) {
      ffmpegDetection = await this.opts.ffmpegDetect()
    }

    if (parsedManifest.permissions.includes('ffmpeg')) {
      const range = parsedManifest.engines.ffmpeg ?? null
      if (!ffmpegDetection.available) {
        await rm(stagingDir, { recursive: true, force: true })
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.manifest.permissions.unsupported_on_runtime'
        )
      }
      if (range && !ffmpegSatisfies(ffmpegDetection.version ?? '', range)) {
        await rm(stagingDir, { recursive: true, force: true })
        throw Object.assign(
          new AppError(
            ErrorCode.PluginManifestInvalid,
            'plugin.manifest.engines.ffmpeg_too_old'
          ),
          {
            details: {
              required: range,
              detected: ffmpegDetection.version,
            },
            message: `ffmpeg ${ffmpegDetection.version} below required ${range}`,
          }
        ) as AppError & {
          details: { required: string; detected: string | undefined }
        }
      }
    }

    const installedCalleeTitles = this.collectCalleeTitles(
      parsedManifest.invokesCommands ?? []
    )
    const consent = buildConsentPayload(
      parsedManifest,
      source,
      prev,
      diff,
      installedCalleeTitles,
      { ffmpegDetection }
    )

    // Locale/manifest resolution is complete. A pending consent transaction
    // only needs the protected archive, so do not retain a second extracted
    // copy indefinitely alongside it.
    await rm(extractedDir, { recursive: true, force: true })

    const stagingId = path.basename(stagingDir)
    const staged: StagedInstall = {
      pluginId: parsedManifest.id,
      newManifest: parsedManifest,
      source,
      stagingDir,
      consent,
      archivePath,
      archiveSha256: loadedMoext.archiveSha256,
      previousRecord: prev,
      runtimeHost: options?.runtimeHost,
    }
    this.pending.set(stagingId, staged)

    if (!needConsent) {
      const committed = await this.commit(
        stagingId,
        prev?.grants ?? {},
        options?.runtimeHost
      )
      return {
        stagingId,
        consent,
        committed: true,
        pluginId: committed.pluginId,
      }
    }
    return { stagingId, consent, committed: false }
  }

  async commit(
    stagingId: string,
    grants: GrantsMap,
    runtimeHost?: PluginRuntimeHostLike
  ): Promise<{ pluginId: string }> {
    const staged = this.pending.get(stagingId)
    if (!staged) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.staging_not_found'
      )
    }

    return this.withPluginMutation(staged.pluginId, async () => {
      // A second commit may have consumed this staging entry while this call
      // waited for the per-plugin mutation lock.
      if (this.pending.get(stagingId) !== staged) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.staging_not_found'
        )
      }

      const finalDir = resolvePluginInstallDir(
        this.opts.pluginsDir,
        staged.pluginId
      )
      const prev = await readInstallRecord(finalDir)
      if (!sameInstallRecord(prev, staged.previousRecord)) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.changed_since_staging'
        )
      }

      const record: InstallRecord = {
        version: 1,
        pluginId: staged.pluginId,
        source: staged.source,
        grants,
        consentSnapshot: {
          permissions: staged.newManifest.permissions,
          optionalPermissions: staged.newManifest.optionalPermissions ?? [],
          invokesCommands: staged.newManifest.invokesCommands ?? [],
          publicCommands: computePublicCommandHashes(staged.newManifest),
          requestedHeapMB: staged.newManifest.requestedHeapMB ?? 32,
          enginesMotrix: staged.newManifest.engines.motrix,
          hostPermissions: staged.newManifest.hostPermissions ?? [],
        },
      }
      const commitDir = path.join(
        this.opts.pluginsDir,
        '_staging',
        `c_${randomUUID()}`
      )
      let backupDir: string | null = null
      let swapped = false

      try {
        // Never commit the long-lived staging tree: it was visible while the
        // consent dialog was open. Re-read through one file descriptor, verify
        // the staged archive digest, then extract those exact bytes into the
        // one-shot swap directory.
        const loadedMoext = await loadMoext(staged.archivePath)
        if (loadedMoext.archiveSha256 !== staged.archiveSha256) {
          throw new AppError(
            ErrorCode.PluginManifestInvalid,
            'plugin.install.sha256_mismatch'
          )
        }
        await extractLoadedMoext(loadedMoext, commitDir)
        await writeInstallRecord(commitDir, record)
        await mkdir(this.opts.pluginsDir, { recursive: true })

        if (prev) {
          // PluginHost.deactivate waits for the worker-side handler, tears
          // down the bridge, and terminates the worker before disk changes.
          await this.stopRuntime(
            staged.pluginId,
            runtimeHost ?? staged.runtimeHost
          )
          backupDir = `${finalDir}.bak-${randomUUID()}`
          await rename(finalDir, backupDir)
        }
        await rename(commitDir, finalDir)
        swapped = true

        this.installCommandSchemas(staged.pluginId, staged.newManifest)
        await this.opts.registry.discover()

        this.pending.delete(stagingId)
        await rm(staged.stagingDir, { recursive: true, force: true }).catch(
          () => undefined
        )
        if (backupDir) {
          await rm(backupDir, { recursive: true, force: true }).catch(
            () => undefined
          )
        }
        return { pluginId: staged.pluginId }
      } catch (error) {
        if (backupDir) {
          if (swapped) {
            await rm(finalDir, { recursive: true, force: true }).catch(
              () => undefined
            )
          }
          await rename(backupDir, finalDir).catch(() => undefined)
        } else if (swapped) {
          await rm(finalDir, { recursive: true, force: true }).catch(
            () => undefined
          )
        }
        if (backupDir || swapped) {
          await this.opts.registry
            .discover()
            .then(() => {
              const restored = this.opts.registry.get(staged.pluginId)
              if (restored) {
                this.installCommandSchemas(staged.pluginId, restored.manifest)
              } else if (this.opts.schemaCache) {
                this.opts.schemaCache.uninstall(staged.pluginId)
              }
            })
            .catch(() => undefined)
        }
        throw error
      } finally {
        await rm(commitDir, { recursive: true, force: true }).catch(
          () => undefined
        )
      }
    })
  }

  async cancel(stagingId: string): Promise<void> {
    const staged = this.pending.get(stagingId)
    if (!staged) return
    await this.withPluginMutation(staged.pluginId, async () => {
      if (this.pending.get(stagingId) !== staged) return
      this.pending.delete(stagingId)
      await rm(staged.stagingDir, { recursive: true, force: true })
    })
  }

  async uninstall(
    pluginId: string,
    runtimeHost?: PluginRuntimeHostLike
  ): Promise<void> {
    const finalDir = resolvePluginInstallDir(this.opts.pluginsDir, pluginId)
    await this.withPluginMutation(pluginId, async () => {
      // A worker retaining old code must not survive removal of its durable
      // files. Unlike handler failures (which PluginHost handles internally),
      // a bridge-disposal failure aborts the uninstall.
      if (runtimeHost) {
        await this.stopRuntime(pluginId, runtimeHost)
      } else {
        // Preserve the legacy direct-installer behavior for embedders that do
        // not yet supply a PluginHost. Production IPC always passes it.
        await this.opts.capabilityHost.lifecycle
          .runDeactivate(pluginId)
          .catch(() => undefined)
      }
      this.opts.stateStore.remove(pluginId)
      await this.opts.capabilityHost.storage.deleteAll(pluginId)
      await this.opts.capabilityHost.metadata.deleteAllForPlugin(pluginId)
      this.opts.capabilityHost.cookieJarFor(pluginId).clear()
      await rm(finalDir, { recursive: true, force: true })
      if (this.opts.schemaCache) this.opts.schemaCache.uninstall(pluginId)
      await this.opts.registry.discover()
    })
  }

  private installCommandSchemas(
    pluginId: string,
    manifest: PluginManifest
  ): void {
    if (!this.opts.schemaCache) return
    this.opts.schemaCache.installCommandSchemas(
      pluginId,
      (manifest.contributes.commands ?? []) as ReadonlyArray<{
        id: string
        argsSchema?: unknown
        resultSchema?: unknown
        public?: boolean
      }>
    )
  }

  private async stopRuntime(
    pluginId: string,
    runtimeHost?: PluginRuntimeHostLike
  ): Promise<void> {
    if (!runtimeHost) {
      await this.opts.capabilityHost.lifecycle.runDeactivate(pluginId)
      return
    }
    await runtimeHost.deactivate(pluginId)
    if (!runtimeHost.isQuiescent(pluginId)) {
      throw new AppError(
        ErrorCode.PluginRuntimeFault,
        'plugin.install.runtime_still_active'
      )
    }
  }

  private async withPluginMutation<T>(
    pluginId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.mutationTails.get(pluginId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => current,
      () => current
    )
    this.mutationTails.set(pluginId, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.mutationTails.get(pluginId) === tail) {
        this.mutationTails.delete(pluginId)
      }
    }
  }

  private collectCalleeTitles(
    invokes: ReadonlyArray<string>
  ): Record<string, string> {
    const titles: Record<string, string> = {}
    for (const cmd of invokes) {
      // Convention: `<pluginId>.<commandShortName>` — first two dot segments
      // identify the callee plugin. This matches Plan D's command-id format.
      const segments = cmd.split('.')
      if (segments.length < 3) continue
      const calleePluginId = segments.slice(0, 2).join('.')
      const callee = this.opts.registry.get(calleePluginId)
      const declared = callee?.manifest.contributes.commands
      const found = declared?.find((d) => d.id === cmd)
      if (found) titles[cmd] = found.title
    }
    return titles
  }
}
