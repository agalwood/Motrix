// Normalizes every shape of plugin source into a canonical
// `{ type, url }` pair Motrix stores in `_install.json.source` (I26).
//
// What we keep:
//   github → https://github.com/<owner>/<repo>                   (no tag)
//   url    → <protocol>//<host>                                  (origin only)
//   local  → local:<fileHash>                                    (file identity, not path)
//   volume → volume:<containerPath>                              (the mount IS the trust)
//   env    → env:<original-url>                                  (declarative install)
//   builtin → builtin:<resourcePath>                             (in-app)
//   registry → registry:<pluginId>                               (from registry)
//
// On upgrade, PluginInstaller.stage compares `normalizeSource(...).url`
// against `_install.json.source.url`. Anything that doesn't string-equal
// triggers `diff.sourceUrlChanged` and forces re-consent.

import { AppError, ErrorCode } from '@shared/errors'
import type {
  InstallRecordSource,
  InstallSourceType,
} from '@shared/types/plugin-install'

export type SourceInput =
  | { type: 'github'; spec: string }
  | { type: 'url'; url: string }
  | { type: 'local'; absPath: string; fileHash: string }
  | { type: 'volume'; containerPath: string }
  | { type: 'env'; url: string }
  | { type: 'builtin'; resourcePath: string }
  // The registry — not the package host — is the trust anchor: the same
  // plugin re-published from a different CDN keeps the same source URL, so
  // upgrades via the registry never trip diff.sourceUrlChanged re-consent.
  | { type: 'registry'; pluginId: string }

export interface NormalizedSource {
  type: InstallSourceType
  url: string
}

export function normalizeSource(s: SourceInput): NormalizedSource {
  switch (s.type) {
    case 'github': {
      const m = s.spec.match(/^([^/@]+)\/([^/@]+)(?:@.+)?$/)
      if (!m) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.invalid_github_spec'
        )
      }
      const [, owner, repo] = m
      return { type: 'github', url: `https://github.com/${owner}/${repo}` }
    }
    case 'url': {
      let u: URL
      try {
        u = new URL(s.url)
      } catch {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.invalid_url'
        )
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.invalid_url'
        )
      }
      return { type: 'url', url: `${u.protocol}//${u.host}` }
    }
    case 'local':
      if (!/^[0-9a-f]{64}$/.test(s.fileHash)) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.invalid_file_hash'
        )
      }
      return { type: 'local', url: `local:${s.fileHash}` }
    case 'volume':
      return { type: 'volume', url: `volume:${s.containerPath}` }
    case 'env':
      return { type: 'env', url: s.url }
    case 'builtin':
      return { type: 'builtin', url: `builtin:${s.resourcePath}` }
    case 'registry':
      return { type: 'registry', url: `registry:${s.pluginId}` }
  }
}

export function sourceUrlEquals(
  a: Pick<InstallRecordSource, 'url'>,
  b: Pick<InstallRecordSource, 'url'>
): boolean {
  return a.url === b.url
}
