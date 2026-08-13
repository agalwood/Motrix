// §6.3 consistency gate: the packaged manifest must equal the registry
// entry on {id, version, engines.motrix} and must not request permissions
// beyond what the registry entry declared (the directory listing is the
// consent preview the user evaluated).

import { AppError, ErrorCode } from '@shared/errors'
import type { RegistryPlugin } from '@shared/schemas/registry'
import type { PluginManifest } from '@shared/types/plugin'

export interface RegistryExpectation {
  id: string
  version: string
  enginesMotrix: string
  permissions: ReadonlyArray<string>
  optionalPermissions: ReadonlyArray<string>
  hostPermissions: ReadonlyArray<string>
  /** Complete .moext digest verified by the registry download boundary. */
  packageSha256?: string
}

export function buildRegistryExpectation(
  entry: RegistryPlugin
): RegistryExpectation {
  const expectation: RegistryExpectation = {
    id: entry.id,
    version: entry.version,
    enginesMotrix: entry.engines.motrix,
    permissions: entry.permissions,
    optionalPermissions: entry.optionalPermissions,
    hostPermissions: entry.hostPermissions,
  }
  if (entry.package?.sha256) expectation.packageSha256 = entry.package.sha256
  return expectation
}

function isSubset(
  sub: ReadonlyArray<string>,
  sup: ReadonlyArray<string>
): boolean {
  const s = new Set(sup)
  return sub.every((x) => s.has(x))
}

function mismatch(field: string): never {
  throw Object.assign(
    new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.registry_manifest_mismatch'
    ),
    { details: { field } }
  )
}

export function assertMatchesRegistryExpectation(
  manifest: PluginManifest,
  expected: RegistryExpectation
): void {
  if (manifest.id !== expected.id) mismatch('id')
  if (manifest.version !== expected.version) mismatch('version')
  if (manifest.engines.motrix !== expected.enginesMotrix) {
    mismatch('engines.motrix')
  }
  if (!isSubset(manifest.permissions, expected.permissions)) {
    mismatch('permissions')
  }
  if (
    !isSubset(manifest.optionalPermissions ?? [], expected.optionalPermissions)
  ) {
    mismatch('optionalPermissions')
  }
  if (!isSubset(manifest.hostPermissions ?? [], expected.hostPermissions)) {
    mismatch('hostPermissions')
  }
}
