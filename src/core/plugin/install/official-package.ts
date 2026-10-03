import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import type { OfficialPackageProof } from '@shared/types/plugin-install'
import { verifyBuiltinSignature } from '../update/signature'
import { type LoadedMoext, loadMoext } from './moext-reader'

export const OFFICIAL_ARCHIVE_FILENAME = '_official.moext'

export function verifyOfficialPackage(
  archive: LoadedMoext,
  signature: string | undefined,
  pubkeys?: readonly string[]
): OfficialPackageProof {
  if (
    !signature ||
    !verifyBuiltinSignature(archive.bytes, signature, pubkeys)
  ) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.official_signature_invalid'
    )
  }
  return { signature, archiveSha256: archive.archiveSha256 }
}

/** Read and verify the same bytes used for manifest parsing and execution. */
export async function loadOfficialPackage(
  pluginDir: string,
  proof: OfficialPackageProof,
  pubkeys?: readonly string[]
): Promise<LoadedMoext> {
  const archive = await loadMoext(
    path.join(pluginDir, OFFICIAL_ARCHIVE_FILENAME)
  )
  verifyOfficialPackage(archive, proof.signature, pubkeys)
  if (archive.archiveSha256 !== proof.archiveSha256) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.official_signature_invalid'
    )
  }
  return archive
}
