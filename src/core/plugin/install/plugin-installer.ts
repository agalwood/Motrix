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

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { FALLBACK_LOCALE } from '@shared/constants/locales'
import { AppError, ErrorCode } from '@shared/errors'
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
import { extractMoext } from './moext-reader'
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

export class PluginInstaller {
  private readonly pending = new Map<string, StagedInstall>()

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
    const { bundleSha256, manifestRaw } = await extractMoext(
      moextPath,
      stagingDir
    )
    const localFileHash =
      sourceInput.type === 'local'
        ? createHash('sha256')
            .update(await readFile(moextPath))
            .digest('hex')
        : null
    if (
      sourceInput.type === 'local' &&
      sourceInput.fileHash !== localFileHash
    ) {
      await rm(stagingDir, { recursive: true, force: true })
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.local_file_hash_mismatch'
      )
    }

    let parsedManifest: PluginManifest
    try {
      const result = parseManifest(manifestRaw, {
        hostVersion: this.opts.hostVersion,
      })
      parsedManifest = await resolveManifestForInstall(
        result.manifest as PluginManifest,
        stagingDir
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
    const finalDir = path.join(this.opts.pluginsDir, parsedManifest.id)
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

    const stagingId = path.basename(stagingDir)
    const staged: StagedInstall = {
      pluginId: parsedManifest.id,
      newManifest: parsedManifest,
      source,
      stagingDir,
      consent,
    }
    this.pending.set(stagingId, staged)

    if (!needConsent) {
      const committed = await this.commit(stagingId, prev?.grants ?? {})
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
    grants: GrantsMap
  ): Promise<{ pluginId: string }> {
    const staged = this.pending.get(stagingId)
    if (!staged) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.staging_not_found'
      )
    }
    const finalDir = path.join(this.opts.pluginsDir, staged.pluginId)
    const prev = await readInstallRecord(finalDir)

    if (prev) {
      // Upgrade: deactivate first, then atomic dir swap with rollback.
      await this.opts.capabilityHost.lifecycle.runDeactivate(staged.pluginId)
      const backup = `${finalDir}.bak-${Date.now()}`
      await rename(finalDir, backup)
      try {
        await rename(staged.stagingDir, finalDir)
      } catch (e) {
        await rename(backup, finalDir).catch(() => {})
        throw e
      }
      await rm(backup, { recursive: true, force: true })
    } else {
      await mkdir(this.opts.pluginsDir, { recursive: true })
      await rename(staged.stagingDir, finalDir)
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
    await writeInstallRecord(finalDir, record)

    if (this.opts.schemaCache) {
      this.opts.schemaCache.installCommandSchemas(
        staged.pluginId,
        (staged.newManifest.contributes.commands ?? []) as ReadonlyArray<{
          id: string
          argsSchema?: unknown
          resultSchema?: unknown
          public?: boolean
        }>
      )
    }

    await this.opts.registry.discover()
    this.pending.delete(stagingId)
    return { pluginId: staged.pluginId }
  }

  async cancel(stagingId: string): Promise<void> {
    const staged = this.pending.get(stagingId)
    if (!staged) return
    await rm(staged.stagingDir, { recursive: true, force: true })
    this.pending.delete(stagingId)
  }

  async uninstall(pluginId: string): Promise<void> {
    const finalDir = path.join(this.opts.pluginsDir, pluginId)
    // Best-effort deactivate — uninstalling something that failed to
    // activate shouldn't block teardown.
    await this.opts.capabilityHost.lifecycle
      .runDeactivate(pluginId)
      .catch(() => {})
    this.opts.stateStore.remove(pluginId)
    await this.opts.capabilityHost.storage.deleteAll(pluginId)
    await this.opts.capabilityHost.metadata.deleteAllForPlugin(pluginId)
    this.opts.capabilityHost.cookieJarFor(pluginId).clear()
    await rm(finalDir, { recursive: true, force: true })
    if (this.opts.schemaCache) this.opts.schemaCache.uninstall(pluginId)
    await this.opts.registry.discover()
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
