// Resolves `github:owner/repo[@tag]` install specs by hitting the GitHub
// Releases API, locating a `*.moext` asset, and downloading it with a size limit.
//
// We don't read the manifest here — that happens later in `extractMoext`.
// We just provide a clean tarball-style "bring me the bytes" boundary.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import { readPluginResponse } from './read-plugin-response'

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

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
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
  destFile: string,
  fetchImpl: typeof fetch = fetch
): Promise<DownloadResult> {
  const apiUrl = spec.tag
    ? `https://api.github.com/repos/${spec.owner}/${spec.repo}/releases/tags/${encodeURIComponent(spec.tag)}`
    : `https://api.github.com/repos/${spec.owner}/${spec.repo}/releases/latest`

  const meta = await fetchImpl(apiUrl, {
    redirect: 'error',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/vnd.github+json',
    },
  })
  if (meta.status !== 200) {
    await cancelBody(meta)
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      `plugin.install.gh_release_unavailable: ${meta.status}`
    )
  }
  let body: GhReleaseResponse
  try {
    body = JSON.parse(
      (await readPluginResponse(meta)).toString('utf8')
    ) as GhReleaseResponse
  } catch (cause) {
    await cancelBody(meta)
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
  let dl: Response | undefined
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(assetUrl.href, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT },
    })
    if (!REDIRECT_STATUSES.has(response.status)) {
      dl = response
      break
    }
    if (redirects >= MAX_REDIRECTS) {
      await cancelBody(response)
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.too_many_redirects'
      )
    }
    const location = response.headers.get('location')
    if (!location) {
      await cancelBody(response)
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.install.invalid_redirect'
      )
    }
    await cancelBody(response)
    assetUrl = resolveHttpsRedirect(location, assetUrl)
  }
  if (dl.status !== 200) {
    await cancelBody(dl)
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      `plugin.install.gh_asset_download_failed: ${dl.status}`
    )
  }
  try {
    await writeFile(destFile, await readPluginResponse(dl, MAX_MOEXT_BYTES), {
      mode: 0o600,
    })
  } catch (cause) {
    await cancelBody(dl)
    await rm(destFile, { force: true }).catch(() => undefined)
    throw cause
  }
  return { tag: body.tag_name, assetName: asset.name }
}
