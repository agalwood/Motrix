// Builds the `ConsentPayload` the renderer dialog (Plan F) shows the user
// before a plugin install or upgrade is finalized. This module is the
// single source of truth for which permission descriptions, callee titles,
// and broad-pattern warnings the dialog renders.

import type { PluginManifest } from '@shared/types/plugin'
import type {
  ConsentPayload,
  ConsentPayloadFfmpegRuntime,
  ConsentPayloadInvokesCommand,
  ConsentPayloadPermission,
  ConsentPayloadPublicCommand,
  InstallRecord,
  TrustSurfaceDiff,
} from '@shared/types/plugin-install'
import type { FfmpegDetection } from '../capabilities/ffmpeg-detect'
import { ffmpegSatisfies } from './ffmpeg-semver'

// `i18n` keys; the renderer resolves them through the existing
// `permission.*` namespace. Unknown permissions fall back to a generic
// `permission.<name>.description` key so forward-compat is preserved.
const PERMISSION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  http: 'permission.http.description',
  'http.cookies': 'permission.http.cookies.description',
  'fs.task.read': 'permission.fs.task.read.description',
  'fs.task.write': 'permission.fs.task.write.description',
  'fs.storage': 'permission.fs.storage.description',
  storage: 'permission.storage.description',
  notify: 'permission.notify.description',
  ffmpeg: 'permission.ffmpeg.description',
  exec: 'permission.exec.description',
}

function describePermission(name: string): ConsentPayloadPermission {
  return {
    name,
    description:
      PERMISSION_DESCRIPTIONS[name] ?? `permission.${name}.description`,
  }
}

const BROAD_HOST_PATTERNS = new Set([
  '<all_urls>',
  'https://*/*',
  'http://*/*',
  '*://*/*',
])

export function buildConsentPayload(
  manifest: PluginManifest,
  source: InstallRecord['source'],
  prevRecord: InstallRecord | null,
  diff: TrustSurfaceDiff | null,
  installedCalleeTitles: Record<string, string>,
  ffmpegInput: { ffmpegDetection: FfmpegDetection }
): ConsentPayload {
  void prevRecord // currently unused; reserved for diff-driven UI hints

  const permissions = manifest.permissions.map(describePermission)
  const optionalPermissions = (manifest.optionalPermissions ?? []).map(
    describePermission
  )
  const hostPermissions = (manifest.hostPermissions ?? []).map((pattern) => ({
    pattern,
    broad: BROAD_HOST_PATTERNS.has(pattern),
  }))
  const invokesCommands: ConsentPayloadInvokesCommand[] = (
    manifest.invokesCommands ?? []
  ).map((commandId) => {
    const calleeTitle = installedCalleeTitles[commandId]
    return calleeTitle !== undefined
      ? { commandId, calleeInstalled: true, calleeTitle }
      : { commandId, calleeInstalled: false }
  })
  const publicCommandsExposed: ConsentPayloadPublicCommand[] = (
    manifest.contributes.commands ?? []
  )
    .filter((c) => c.public === true)
    .map((c) => ({ id: c.id, title: c.title }))

  const requiredByPlugin: ConsentPayloadFfmpegRuntime['requiredByPlugin'] =
    manifest.permissions.includes('ffmpeg')
      ? 'required'
      : (manifest.optionalPermissions ?? []).includes('ffmpeg')
        ? 'optional'
        : 'none'

  const det = ffmpegInput.ffmpegDetection
  const ffmpegRuntime: ConsentPayloadFfmpegRuntime = {
    available: det.available,
    version: det.available ? det.version : undefined,
    satisfiesRange:
      requiredByPlugin === 'none'
        ? undefined
        : det.available
          ? ffmpegSatisfies(det.version ?? '', manifest.engines.ffmpeg ?? null)
          : false,
    requiredByPlugin,
  }

  return {
    manifest: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      homepage: manifest.homepage,
    },
    source,
    trustSurface: {
      permissions,
      optionalPermissions,
      hostPermissions,
      invokesCommands,
      publicCommandsExposed,
      requestedHeapMB: manifest.requestedHeapMB,
      enginesMotrix: manifest.engines.motrix,
      notVerified: true,
    },
    diff,
    ffmpegRuntime,
  }
}
