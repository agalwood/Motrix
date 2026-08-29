// Resolves `github:owner/repo[@tag]` install specs by hitting the GitHub
// Releases API, locating a `*.moext` asset, and streaming it to disk.
//
// We don't read the manifest here — that happens later in `extractMoext`.
// We just provide a clean tarball-style "bring me the bytes" boundary.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import { request } from 'undici'

export interface GhReleaseSpec {
  owner: string
  repo: string
  tag?: string
}

export function parseGithubSpec(spec: string): GhReleaseSpec {
  const m = spec.match(/^([^/@\s]+)\/([^/@\s]+)(?:@(.+))?$/)
  if (!m) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.invalid_github_spec'
    )
  }
  const [, owner, repo, tag] = m
  return tag ? { owner, repo, tag } : { owner, repo }
}

interface GhReleaseResponse {
  tag_name: string
  assets: Array<{ name: string; browser_download_url: string }>
}

export interface DownloadResult {
  tag: string
  assetName: string
}

const USER_AGENT = 'motrix-plugin-installer'
const MAX_MOEXT_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function requireHttpsUrl(rawUrl: string, errorKey: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AppError(ErrorCode.PluginManifestInvalid, errorKey)
  }
  if (url.protocol !== 'https:') {
    throw new AppError(ErrorCode.PluginManifestInvalid, errorKey)
  }
  return url
}

function responseHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function cancelBody(body: unknown): Promise<void> {
  const stream = body as {
    destroy?: (error?: Error) => unknown
    cancel?: (reason?: unknown) => Promise<void>
    once?: (event: 'error', listener: () => void) => unknown
  }
  try {
    if (typeof stream.destroy === 'function') {
      // Undici BodyReadable emits RequestAbortedError asynchronously for an
      // intentional destroy. Swallow that cleanup signal without waiting for
      // a close event that can itself depend on dispatcher teardown.
      stream.once?.('error', () => undefined)
      stream.destroy()
    } else if (typeof stream.cancel === 'function') {
      await stream.cancel()
    }
  } catch {
    // Response cleanup is best-effort and must not mask the install error.
  }
}

function resolveHttpsRedirect(location: string, current: URL): URL {
  let next: URL
  try {
    next = new URL(location, current)
  } catch {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.invalid_redirect'
    )
  }
  if (next.protocol !== 'https:') {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.redirect_protocol_downgrade'
    )
  }
  return next
}

export async function downloadGithubMoext(
  spec: GhReleaseSpec,
  destFile: string
): Promise<DownloadResult> {
  const apiUrl = spec.tag
    ? `https://api.github.com/repos/${spec.owner}/${spec.repo}/releases/tags/${encodeURIComponent(spec.tag)}`
    : `https://api.github.com/repos/${spec.owner}/${spec.repo}/releases/latest`

  const meta = await request(apiUrl, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/vnd.github+json',
    },
  })
  if (meta.statusCode !== 200) {
    await cancelBody(meta.body)
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      `plugin.install.gh_release_unavailable: ${meta.statusCode}`
    )
  }
  let body: GhReleaseResponse
  try {
    body = (await meta.body.json()) as GhReleaseResponse
  } catch (cause) {
    await cancelBody(meta.body)
    throw cause
  }
  const asset = body.assets.find((a) => a.name.endsWith('.moext'))
  if (!asset) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.no_moext_asset'
    )
  }

  await mkdir(path.dirname(destFile), { recursive: true })
  // GitHub release assets redirect to a CDN. Follow manually so an HTTPS
  // download cannot silently downgrade on a later hop.
  let assetUrl = requireHttpsUrl(
    asset.browser_download_url,
    'plugin.install.gh_asset_insecure_url'
  )
  let dl: Awaited<ReturnType<typeof request>> | undefined
  for (let redirects = 0; ; redirects += 1) {
    const response = await request(assetUrl.href, {
      headers: { 'user-agent': USER_AGENT },
    })
    if (!REDIRECT_STATUSES.has(response.statusCode)) {
      dl = response
      break
    }
    if (redirects >= MAX_REDIRECTS) {
      await cancelBody(response.body)
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.too_many_redirects'
      )
    }
    const location = responseHeader(response.headers, 'location')
    if (!location) {
      await cancelBody(response.body)
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.invalid_redirect'
      )
    }
    await cancelBody(response.body)
    assetUrl = resolveHttpsRedirect(location, assetUrl)
  }
  if (dl.statusCode !== 200) {
    await cancelBody(dl.body)
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      `plugin.install.gh_asset_download_failed: ${dl.statusCode}`
    )
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of dl.body) {
      const bytes = Buffer.from(chunk)
      total += bytes.byteLength
      if (total > MAX_MOEXT_BYTES) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.package_too_large'
        )
      }
      chunks.push(bytes)
    }
    await writeFile(destFile, Buffer.concat(chunks, total), { mode: 0o600 })
  } catch (cause) {
    await cancelBody(dl.body)
    await rm(destFile, { force: true }).catch(() => undefined)
    throw cause
  }
  return { tag: body.tag_name, assetName: asset.name }
}
