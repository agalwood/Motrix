// §6.3 download boundary for registry packages: https + host allowlist on
// the INITIAL url (GitHub assets 302 to a CDN — integrity past the redirect
// is anchored by sha256, not hostname), then size + sha256 verified fully
// in memory BEFORE anything is written to disk.

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import type { RegistryPluginDTO } from '@shared/schemas/registry'

export const REGISTRY_PACKAGE_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'dl.motrix.app',
])

export function assertAllowlistedPackageUrl(rawUrl: string): URL {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.registry_url_not_allowlisted'
    )
  }
  if (u.protocol !== 'https:' || !REGISTRY_PACKAGE_HOSTS.has(u.hostname)) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.registry_url_not_allowlisted'
    )
  }
  return u
}

export async function fetchVerifiedPackageBytes(
  entry: RegistryPluginDTO,
  fetchImpl: typeof fetch = fetch
): Promise<Buffer> {
  const pkg = entry.package
  if (!pkg) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.registry_no_package'
    )
  }
  const url = assertAllowlistedPackageUrl(pkg.url)
  const res = await fetchImpl(url)
  if (!res.ok) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      `plugin.install.registry_download_failed: ${res.status}`
    )
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.byteLength !== pkg.size) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.registry_size_mismatch'
    )
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== pkg.sha256) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.registry_sha256_mismatch'
    )
  }
  return bytes
}

export async function downloadRegistryMoext(
  entry: RegistryPluginDTO,
  destFile: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const bytes = await fetchVerifiedPackageBytes(entry, fetchImpl)
  await mkdir(path.dirname(destFile), { recursive: true })
  await writeFile(destFile, bytes)
}
