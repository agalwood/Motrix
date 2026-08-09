// Server-runtime bootstrap install path (I27).
//
// Runs once at server startup. Two install vectors:
//
//   1. `MOTRIX_PLUGIN_INSTALL_URLS` — comma- or JSON-array-of- declarative
//      install specs (github: or https://) the operator wants applied at boot.
//      Each entry is fetched, staged, and committed unattended (operator
//      already consented by setting the env var).
//
//   2. Volume-mounted plugin dirs already on disk under `pluginsDir`. Each
//      directory is checked against `isServerAckSatisfied` (existing
//      `_install.json` OR allowlist hit OR blanket bypass). Mismatched dirs
//      are rejected and reported; they do NOT get registered.
//
// Default is fail-closed.

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  downloadGithubMoext,
  parseGithubSpec,
} from '@core/plugin/install/github-fetcher'
import { readInstallRecord } from '@core/plugin/install/install-record'
import type { PluginInstaller } from '@core/plugin/install/plugin-installer'
import {
  isServerAckSatisfied,
  parseAllowlist,
} from '@core/plugin/install/server-ack'
import type {
  InstallRecord,
  InstallSourceType,
} from '@shared/types/plugin-install'

export interface BootstrapInstallResult {
  accepted: string[]
  rejected: Array<{ id: string; reason: string }>
}

export interface ServerBootstrapEnv {
  MOTRIX_PLUGIN_ALLOWLIST?: string
  MOTRIX_PLUGIN_INSTALL_URLS?: string
}

export interface ServerBootstrapFlags {
  blanketBypass: boolean
}

export async function serverBootstrapInstall(
  installer: PluginInstaller,
  pluginsDir: string,
  env: ServerBootstrapEnv,
  flags: ServerBootstrapFlags
): Promise<BootstrapInstallResult> {
  const ackCtx = {
    allowlist: parseAllowlist(env.MOTRIX_PLUGIN_ALLOWLIST),
    blanketBypass: flags.blanketBypass,
  }
  const accepted: string[] = []
  const rejected: BootstrapInstallResult['rejected'] = []

  // 1) declarative install: env URLs
  const urls = parseAllowlist(env.MOTRIX_PLUGIN_INSTALL_URLS)
  for (const url of urls) {
    try {
      let moextPath: string
      if (url.startsWith('github:')) {
        const spec = parseGithubSpec(url.slice('github:'.length))
        moextPath = path.join(
          pluginsDir,
          '_dl',
          `${spec.owner}-${spec.repo}-${Date.now()}.moext`
        )
        await downloadGithubMoext(spec, moextPath)
      } else if (url.endsWith('.moext')) {
        moextPath = url
      } else {
        rejected.push({ id: url, reason: 'plugin.install.invalid_env_url' })
        continue
      }
      await installer.stage(moextPath, { type: 'env', url })
      accepted.push(url)
    } catch (e) {
      rejected.push({ id: url, reason: (e as Error).message })
    }
  }

  // 2) volume-mounted plugins (existing dirs under pluginsDir)
  let entries: string[] = []
  try {
    entries = await readdir(pluginsDir)
  } catch {
    // pluginsDir does not exist — nothing mounted, fine.
    return { accepted, rejected }
  }
  for (const id of entries) {
    if (id.startsWith('_')) continue // skip _staging, _dl
    const dir = path.join(pluginsDir, id)
    const rec = await readInstallRecord(dir)
    const source: InstallRecord['source'] = rec?.source ?? {
      type: 'volume' as InstallSourceType,
      url: `volume:${dir}`,
      bundleSha256: '0'.repeat(64),
      recordedAt: 0,
    }
    const ack = isServerAckSatisfied(source, rec, ackCtx)
    if (!ack.ok) {
      rejected.push({
        id,
        reason: ack.reason ?? 'plugin.lifecycle.unsigned_not_allowed',
      })
    } else {
      accepted.push(id)
    }
  }

  return { accepted, rejected }
}
