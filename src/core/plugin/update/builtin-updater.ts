// The builtin hot-update write path (2026-07-18 design §3). All-or-nothing:
// every gate runs against bytes/dirs OUTSIDE the overlay; only commit()'s
// final rename mutates it. The ed25519 signature is the trust decision;
// sha256/size (inside fetchVerifiedPackageBytes) are pre-checks.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { semverGt } from '@shared/semver'
import type { PluginManifest } from '@shared/types/plugin'
import { extractMoext } from '../install/moext-reader'
import { parseManifest } from '../manifest/parse'
import type { PluginExecutableIdentity } from '../post/delivery-types'
import { fetchVerifiedPackageBytes } from '../registry/registry-fetcher'
import { verifyBuiltinSignature } from './signature'
import { builtinTrustSurfaceChanged } from './trust-diff'

export interface BuiltinUpdaterOptions {
  overlayDir: string
  hostVersion: string
  pubkeys?: ReadonlyArray<string>
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface BuiltinStageResult {
  stagingId: string
  trustChanged: boolean
  added: string[]
  newVersion: string
}

/**
 * Host-owned lifecycle boundary for executable mutations. The updater only
 * swaps bytes while admission is closed and the previous worker/leases have
 * drained; durable deliveries are terminalized only after the new executable
 * has become the effective registry policy.
 */
export interface BuiltinUpdaterLifecycleSink {
  applyPolicyMutation<T>(
    pluginId: string,
    publish: () => Promise<T> | T
  ): Promise<T>
  currentExecutable(pluginId: string): PluginExecutableIdentity | undefined
  refreshRegistry(): Promise<void>
  supersede(executable: PluginExecutableIdentity, at: number): Promise<number>
}

interface StagedUpdate {
  pluginId: string
  stagingDir: string
}

const OVERLAY_META = '_overlay.json'

export class BuiltinUpdater {
  private readonly pending = new Map<string, StagedUpdate>()
  private lifecycleSink: BuiltinUpdaterLifecycleSink | undefined

  constructor(private readonly opts: BuiltinUpdaterOptions) {}

  bindLifecycleSink(sink: BuiltinUpdaterLifecycleSink): void {
    if (this.lifecycleSink && this.lifecycleSink !== sink) {
      throw new Error('builtin updater lifecycle sink already bound')
    }
    this.lifecycleSink = sink
  }

  pluginIdForStaging(stagingId: string): string | undefined {
    return this.pending.get(stagingId)?.pluginId
  }

  async stage(
    entry: RegistryPluginDTO,
    effective: PluginManifest
  ): Promise<BuiltinStageResult> {
    const pkg = entry.package
    if (!pkg) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.update.builtin_no_package'
      )
    }
    if (!pkg.signature) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.update.builtin_no_signature'
      )
    }
    if (!semverGt(entry.version, effective.version)) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.update.builtin_not_newer'
      )
    }

    const bytes = await fetchVerifiedPackageBytes(entry, this.opts.fetchImpl)
    if (!verifyBuiltinSignature(bytes, pkg.signature, this.opts.pubkeys)) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.update.builtin_bad_signature'
      )
    }

    const now = this.opts.now ?? Date.now
    const stagingDir = path.join(
      this.opts.overlayDir,
      `.tmp-${entry.id}-${now()}`
    )
    const bundlePath = path.join(stagingDir, 'bundle.moext')

    try {
      await mkdir(stagingDir, { recursive: true })
      await writeFile(bundlePath, bytes)
      const { manifestRaw } = await extractMoext(bundlePath, stagingDir)
      const { manifest } = parseManifest(manifestRaw, {
        hostVersion: this.opts.hostVersion,
        origin: 'builtin',
      })
      const parsed = manifest as PluginManifest
      if (
        parsed.id !== entry.id ||
        !parsed.id.startsWith('motrix.') ||
        parsed.version !== entry.version
      ) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.update.builtin_wrong_id'
        )
      }
      if (!semverGt(parsed.version, effective.version)) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.update.builtin_not_newer'
        )
      }

      await writeFile(
        path.join(stagingDir, OVERLAY_META),
        JSON.stringify({
          version: 1,
          packageUrl: pkg.url,
          sha256: pkg.sha256,
          signature: pkg.signature,
          recordedAt: now(),
        })
      )

      const diff = builtinTrustSurfaceChanged(effective, parsed)
      const stagingId = path.basename(stagingDir)
      this.pending.set(stagingId, {
        pluginId: entry.id,
        stagingDir,
      })
      return {
        stagingId,
        trustChanged: diff.changed,
        added: diff.added,
        newVersion: parsed.version,
      }
    } catch (e) {
      await rm(stagingDir, { recursive: true, force: true })
      throw e
    }
  }

  async commit(stagingId: string): Promise<{ pluginId: string }> {
    const staged = this.pending.get(stagingId)
    if (!staged) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.update.builtin_staging_not_found'
      )
    }
    if (this.lifecycleSink) {
      await this.lifecycleSink.applyPolicyMutation(staged.pluginId, () =>
        this.commitWithLifecycle(staged)
      )
    } else {
      await this.commitWithoutLifecycle(staged)
    }
    this.pending.delete(stagingId)
    return { pluginId: staged.pluginId }
  }

  /** Revert a hot-update overlay to the bundled executable. */
  async revert(
    pluginId: string
  ): Promise<{ pluginId: string; changed: boolean }> {
    const changed = this.lifecycleSink
      ? await this.lifecycleSink.applyPolicyMutation(pluginId, () =>
          this.revertWithLifecycle(pluginId)
        )
      : await this.revertWithoutLifecycle(pluginId)
    return { pluginId, changed }
  }

  async cancel(stagingId: string): Promise<void> {
    const staged = this.pending.get(stagingId)
    if (!staged) return
    await rm(staged.stagingDir, { recursive: true, force: true })
    this.pending.delete(stagingId)
  }

  async cleanupOrphans(): Promise<void> {
    const { readdir } = await import('node:fs/promises')
    let names: string[] = []
    try {
      names = await readdir(this.opts.overlayDir)
    } catch {
      return
    }
    await Promise.all(
      names
        .filter((n) => n.startsWith('.tmp-') || n.startsWith('.bak-'))
        .map((n) =>
          rm(path.join(this.opts.overlayDir, n), {
            recursive: true,
            force: true,
          })
        )
    )
  }

  private async commitWithLifecycle(staged: StagedUpdate): Promise<void> {
    const lifecycle = this.lifecycleSink
    if (!lifecycle) throw new Error('builtin updater lifecycle sink missing')
    const previous = lifecycle.currentExecutable(staged.pluginId)
    if (!previous) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.update.builtin_entry_missing'
      )
    }
    const finalDir = path.join(this.opts.overlayDir, staged.pluginId)
    const backup = this.backupPath(staged.pluginId, 'update')
    const hadPrevious = await moveIfPresent(finalDir, backup)
    let published = false
    try {
      await rename(staged.stagingDir, finalDir)
      published = true
      await lifecycle.refreshRegistry()
      await lifecycle.supersede(previous, this.now())
    } catch (error) {
      await this.rollbackPublishedOverlay({
        finalDir,
        recoveryDir: staged.stagingDir,
        backup,
        hadPrevious,
        published,
        refreshRegistry: () => lifecycle.refreshRegistry(),
      })
      throw error
    }
    if (hadPrevious) {
      await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async commitWithoutLifecycle(staged: StagedUpdate): Promise<void> {
    const finalDir = path.join(this.opts.overlayDir, staged.pluginId)
    const backup = this.backupPath(staged.pluginId, 'update')
    const hadPrevious = await moveIfPresent(finalDir, backup)
    try {
      await rename(staged.stagingDir, finalDir)
    } catch (error) {
      if (hadPrevious) await rename(backup, finalDir).catch(() => undefined)
      throw error
    }
    if (hadPrevious) await rm(backup, { recursive: true, force: true })
  }

  private async revertWithLifecycle(pluginId: string): Promise<boolean> {
    const lifecycle = this.lifecycleSink
    if (!lifecycle) throw new Error('builtin updater lifecycle sink missing')
    const previous = lifecycle.currentExecutable(pluginId)
    if (!previous) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.update.builtin_entry_missing'
      )
    }
    const finalDir = path.join(this.opts.overlayDir, pluginId)
    const backup = this.backupPath(pluginId, 'revert')
    const changed = await moveIfPresent(finalDir, backup)
    if (!changed) return false
    try {
      await lifecycle.refreshRegistry()
      await lifecycle.supersede(previous, this.now())
    } catch (error) {
      await rename(backup, finalDir).catch(() => undefined)
      await lifecycle.refreshRegistry().catch(() => undefined)
      throw error
    }
    await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    return true
  }

  private async revertWithoutLifecycle(pluginId: string): Promise<boolean> {
    const finalDir = path.join(this.opts.overlayDir, pluginId)
    const backup = this.backupPath(pluginId, 'revert')
    const changed = await moveIfPresent(finalDir, backup)
    if (!changed) return false
    await rm(backup, { recursive: true, force: true })
    return true
  }

  private async rollbackPublishedOverlay(input: {
    finalDir: string
    recoveryDir: string
    backup: string
    hadPrevious: boolean
    published: boolean
    refreshRegistry: () => Promise<void>
  }): Promise<void> {
    if (input.published) {
      await rename(input.finalDir, input.recoveryDir).catch(async () => {
        await rm(input.finalDir, { recursive: true, force: true })
      })
    }
    if (input.hadPrevious) {
      await rename(input.backup, input.finalDir)
    }
    await input.refreshRegistry().catch(() => undefined)
  }

  private backupPath(pluginId: string, operation: 'update' | 'revert'): string {
    return path.join(
      this.opts.overlayDir,
      `.bak-${operation}-${pluginId}-${this.now()}`
    )
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }
}

async function moveIfPresent(
  source: string,
  destination: string
): Promise<boolean> {
  try {
    await rename(source, destination)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
