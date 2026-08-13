// §6.3 download boundary for registry packages: https + host allowlist on
// the INITIAL url (GitHub assets 302 to a CDN — integrity past the redirect
// is anchored by sha256, not hostname), then size + sha256 verified through
// a bounded stream BEFORE anything is written to disk.

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import type { RegistryPluginDTO } from '@shared/schemas/registry'

export const REGISTRY_PACKAGE_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'dl.motrix.app',
])

export const MAX_REGISTRY_PACKAGE_BYTES = 5 * 1024 * 1024

function packageError(message: string, cause?: unknown): AppError {
  return new AppError(ErrorCode.PluginManifestInvalid, message, cause)
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
  reason: unknown
): Promise<void> {
  await body?.cancel(reason).catch(() => undefined)
}

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
  if (!Number.isSafeInteger(pkg.size) || pkg.size <= 0) {
    throw packageError('plugin.install.registry_size_mismatch')
  }
  if (pkg.size > MAX_REGISTRY_PACKAGE_BYTES) {
    throw packageError('plugin.install.package_too_large')
  }
  const url = assertAllowlistedPackageUrl(pkg.url)
  const res = await fetchImpl(url)
  if (!res.ok) {
    const error = new AppError(
      ErrorCode.PluginManifestInvalid,
      `plugin.install.registry_download_failed: ${res.status}`
    )
    await cancelBody(res.body, error)
    throw error
  }

  const contentLength = res.headers.get('content-length')?.trim()
  // Content-Length is only an early resource-limit hint. Proxies and
  // transparent encoding can omit or rewrite it, so integrity relies on the
  // bounded stream, final byte count, and SHA-256 below.
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredLength = BigInt(contentLength)
    if (declaredLength > BigInt(MAX_REGISTRY_PACKAGE_BYTES)) {
      const error = packageError('plugin.install.package_too_large')
      await cancelBody(res.body, error)
      throw error
    }
  }

  if (!res.body) {
    throw packageError('plugin.install.registry_download_failed: empty body')
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = res.body.getReader()
  } catch (cause) {
    throw packageError(
      'plugin.install.registry_download_failed: stream error',
      cause
    )
  }
  const chunks: Buffer[] = []
  const hash = createHash('sha256')
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      total += value.byteLength
      if (total > MAX_REGISTRY_PACKAGE_BYTES || total > pkg.size) {
        const error = packageError(
          total > MAX_REGISTRY_PACKAGE_BYTES
            ? 'plugin.install.package_too_large'
            : 'plugin.install.registry_size_mismatch'
        )
        await reader.cancel(error).catch(() => undefined)
        throw error
      }

      const chunk = Buffer.from(value)
      hash.update(chunk)
      chunks.push(chunk)
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined)
    if (cause instanceof AppError) throw cause
    throw packageError(
      'plugin.install.registry_download_failed: stream error',
      cause
    )
  } finally {
    reader.releaseLock()
  }

  if (total !== pkg.size) {
    throw packageError('plugin.install.registry_size_mismatch')
  }
  const digest = hash.digest('hex')
  if (digest !== pkg.sha256) {
    throw packageError('plugin.install.registry_sha256_mismatch')
  }
  return Buffer.concat(chunks, total)
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
