import type { MediaResolver } from '@core/media/ytdlp/media-resolver'
import { isLikelyMediaSite } from '@core/media/ytdlp/media-site-allowlist'
import {
  createYtdlpFormatLister,
  type YtdlpFormatLister,
} from '@core/media/ytdlp/ytdlp-formats'
import {
  locateYtdlp,
  type YtdlpLocation,
} from '@core/media/ytdlp/ytdlp-locator'
import {
  createYtdlpMediaResolver,
  type YtdlpResolverDeps,
} from '@core/media/ytdlp/ytdlp-resolver'
import type { MediaSettings, ProxySettings } from '@shared/types/settings'

/**
 * Electron shell wiring for the yt-dlp media resolver.
 *
 * Owns the three shell-specific concerns the core resolver deliberately does
 * not: reading persisted Settings live, locating the binary (with a cache so
 * a media URL never pays a fresh probe), and turning the download-scoped
 * proxy setting into a yt-dlp `--proxy` URL.
 */

const NEGATIVE_CACHE_MS = 60_000

/**
 * Proxy URL for the download scope, or null when the proxy does not apply.
 * Only the `download` scope matters here: this URL is handed to yt-dlp to
 * fetch stream metadata, not to the app's update or plugin traffic.
 */
export function proxyUrlForDownload(proxy: ProxySettings): string | null {
  if (!proxy.enabled || !proxy.scopes.download) return null
  if (!proxy.host.trim()) return null
  const scheme =
    proxy.protocol === 'socks5'
      ? 'socks5'
      : proxy.protocol === 'https'
        ? 'https'
        : 'http'
  const credentials =
    proxy.user.trim() || proxy.password
      ? `${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.password)}@`
      : ''
  return `${scheme}://${credentials}${proxy.host.trim()}:${proxy.port}`
}

export interface YtdlpShellDeps {
  getMediaSettings: () => MediaSettings
  getProxySettings: () => ProxySettings
  /** Whether a mux task can be dispatched (FFmpeg + media pipeline live). */
  isMuxAvailable: () => boolean
  env?: Record<string, string | undefined>
  locate?: typeof locateYtdlp
}

export interface ShellYtdlpResolver {
  resolve: MediaResolver
  /** List the qualities a URL offers — the grab overlay's picker backend. */
  listFormats: YtdlpFormatLister
  /** Drop the cached binary location; used after Settings change. */
  invalidate: () => void
  /** Current probe result, for the Settings "detected" indicator. */
  location: () => Promise<YtdlpLocation>
}

export function createShellYtdlpResolver(
  deps: YtdlpShellDeps
): ShellYtdlpResolver {
  const env = deps.env ?? process.env
  let cache: {
    configuredPath: string
    location: YtdlpLocation
    probedAt: number
  } | null = null

  const locate = deps.locate ?? locateYtdlp

  const probe = async (configuredPath: string): Promise<YtdlpLocation> => {
    const now = Date.now()
    if (
      cache &&
      cache.configuredPath === configuredPath &&
      (cache.location.available || now - cache.probedAt < NEGATIVE_CACHE_MS)
    ) {
      return cache.location
    }
    const location = await locate({ configuredPath, env })
    cache = { configuredPath, location, probedAt: now }
    return location
  }

  const resolveBinaryPath = async (): Promise<string | null> => {
    const media = deps.getMediaSettings()
    const location = await probe(media.ytdlpBinaryPath)
    return location.binaryPath
  }

  const resolverDeps: YtdlpResolverDeps = {
    resolveBinaryPath,
    readOptions: () => {
      const media = deps.getMediaSettings()
      const proxy = proxyUrlForDownload(deps.getProxySettings())
      return {
        enabled: media.ytdlpEnabled,
        allUrls: media.ytdlpAllUrls,
        ...(media.ytdlpFormat.trim()
          ? { format: media.ytdlpFormat.trim() }
          : {}),
        ...(proxy ? { proxy } : {}),
      }
    },
    isMuxAvailable: deps.isMuxAvailable,
  }

  // Same policy gates and probe as the resolver — a URL the submit path
  // would decline is also a URL this lister declines (and vice versa), so
  // the picker never promises a quality the submit would refuse.
  const formatLister = createYtdlpFormatLister({
    resolveBinaryPath,
    readOptions: () => {
      const media = deps.getMediaSettings()
      const proxy = proxyUrlForDownload(deps.getProxySettings())
      return {
        enabled: media.ytdlpEnabled,
        allUrls: media.ytdlpAllUrls,
        ...(proxy ? { proxy } : {}),
      }
    },
    isMediaSite: isLikelyMediaSite,
  })

  return {
    resolve: createYtdlpMediaResolver(resolverDeps, isLikelyMediaSite),
    listFormats: formatLister,
    invalidate: () => {
      cache = null
      formatLister.clearCache()
    },
    location: () => probe(deps.getMediaSettings().ytdlpBinaryPath),
  }
}
