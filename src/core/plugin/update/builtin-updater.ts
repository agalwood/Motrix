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

interface StagedUpdate {
  pluginId: string
  stagingDir: string
}

const OVERLAY_META = '_overlay.json'

export class BuiltinUpdater {
  private readonly pending = new Map<string, StagedUpdate>()

  constructor(private readonly opts: BuiltinUpdaterOptions) {}

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
    const finalDir = path.join(this.opts.overlayDir, staged.pluginId)
    const now = this.opts.now ?? Date.now
    const backup = path.join(
      this.opts.overlayDir,
      `.bak-${staged.pluginId}-${now()}`
    )
    let hadPrevious = true
    try {
      await rename(finalDir, backup)
    } catch {
      hadPrevious = false
    }
    try {
      await rename(staged.stagingDir, finalDir)
    } catch (e) {
      if (hadPrevious) await rename(backup, finalDir).catch(() => {})
      throw e
    }
    if (hadPrevious) await rm(backup, { recursive: true, force: true })
    this.pending.delete(stagingId)
    return { pluginId: staged.pluginId }
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
}
