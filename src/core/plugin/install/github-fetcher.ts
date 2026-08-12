// Resolves `github:owner/repo[@tag]` install specs by hitting the GitHub
// Releases API, locating a `*.moext` asset, and streaming it to disk.
//
// We don't read the manifest here — that happens later in `extractMoext`.
// We just provide a clean tarball-style "bring me the bytes" boundary.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import { Agent, interceptors, request } from 'undici'

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

export async function downloadGithubMoext(
  spec: GhReleaseSpec,
  destFile: string
): Promise<DownloadResult> {
  const apiUrl = spec.tag
    ? `https://api.github.com/repos/${spec.owner}/${spec.repo}/releases/tags/${spec.tag}`
    : `https://api.github.com/repos/${spec.owner}/${spec.repo}/releases/latest`

  const meta = await request(apiUrl, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/vnd.github+json',
    },
  })
  if (meta.statusCode !== 200) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      `plugin.install.gh_release_unavailable: ${meta.statusCode}`
    )
  }
  const body = (await meta.body.json()) as GhReleaseResponse
  const asset = body.assets.find((a) => a.name.endsWith('.moext'))
  if (!asset) {
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.no_moext_asset'
    )
  }

  await mkdir(path.dirname(destFile), { recursive: true })
  // undici v8 removed the `maxRedirections` request option; redirect handling
  // now lives in a composed dispatcher. A GitHub asset's browser_download_url
  // 302-redirects to a CDN, so this download MUST follow redirects or it
  // returns the redirect status instead of the bytes.
  const dispatcher = new Agent().compose(
    interceptors.redirect({ maxRedirections: 5 })
  )
  const dl = await request(asset.browser_download_url, {
    headers: { 'user-agent': USER_AGENT },
    dispatcher,
  })
  if (dl.statusCode !== 200) {
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
    await rm(destFile, { force: true }).catch(() => undefined)
    throw cause
  }
  return { tag: body.tag_name, assetName: asset.name }
}
