import { WindowsPackageRuntimeIdentitySchema } from '../src/shared/schemas/windows-package-identity.ts'
import { validateWindowsStoreMetadata } from './windows-store-metadata.mjs'

/** The family comes from the Windows API or the reviewed Partner Center record. */
export function createWindowsStoreRuntimeIdentity(raw, packageFamilyName) {
  const { metadata } = validateWindowsStoreMetadata(raw)
  return WindowsPackageRuntimeIdentitySchema.parse({
    schemaVersion: 1,
    profile: metadata.profile,
    productVersion: metadata.productVersion,
    sourceCommit: metadata.source.commit,
    expected: {
      name: metadata.identity.name,
      publisher: metadata.identity.publisher,
      familyName: packageFamilyName,
      version: metadata.packageVersion,
      architecture: metadata.architecture,
      resourceId: '',
    },
  })
}
