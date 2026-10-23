import type { MediaResolver } from '@core/media/ytdlp/media-resolver'
import { isLikelyMediaSite } from '@core/media/ytdlp/media-site-allowlist'
import { throwIfYtdlpAborted } from '@core/media/ytdlp/ytdlp-execution'
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
import { proxyToUrl } from '@core/proxy/serializers'
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
  const result = proxyToUrl({ ...proxy, host: proxy.host.trim() })
  // The shared serializer omits authentication when user is empty. Preserve a
  // password-only configuration so the extractor refuses it instead of direct
  // or unauthenticated access through the selected proxy.
  if (!proxy.user && proxy.password) {
    const url = new URL(result)
    url.password = proxy.password
    return url.href
  }
  return result
}

function publicExtractorProxyOptions(proxy: ProxySettings): {
  proxy?: string
  proxyUnsupportedReason?: 'proxy-bypass-unsupported'
} {
  if (proxy.enabled && proxy.scopes.download && proxy.bypass.length > 0) {
    // yt-dlp networking backends disagree on bypass matching. Do not silently
    // discard the user's routing rule or weaken it to an approximate match.
    return { proxyUnsupportedReason: 'proxy-bypass-unsupported' }
  }
  const url = proxyUrlForDownload(proxy)
  return url ? { proxy: url } : {}
}

export interface YtdlpShellDeps {
  getMediaSettings: () => MediaSettings
  getProxySettings: () => ProxySettings
  /** Whether a mux task can be dispatched (FFmpeg + media pipeline live). */
  isMuxAvailable: () => boolean | Promise<boolean>
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

  const probe = async (
    configuredPath: string,
    signal?: AbortSignal
  ): Promise<YtdlpLocation> => {
    throwIfYtdlpAborted(signal)
    const now = Date.now()
    if (
      cache &&
      cache.configuredPath === configuredPath &&
      (cache.location.available || now - cache.probedAt < NEGATIVE_CACHE_MS)
    ) {
      return cache.location
    }
    const location = await locate({
      configuredPath,
      env,
      ...(signal ? { signal } : {}),
    })
    throwIfYtdlpAborted(signal)
    cache = { configuredPath, location, probedAt: now }
    return location
  }

  const resolveBinaryPath = async (
    signal?: AbortSignal
  ): Promise<string | null> => {
    const configuredPath = deps.getMediaSettings().ytdlpBinaryPath
    const location = await probe(configuredPath, signal)
    if (deps.getMediaSettings().ytdlpBinaryPath !== configuredPath) return null
    return location.binaryPath
  }

  const resolverDeps: YtdlpResolverDeps = {
    resolveBinaryPath,
    readOptions: () => {
      const media = deps.getMediaSettings()
      const proxy = publicExtractorProxyOptions(deps.getProxySettings())
      return {
        enabled: media.ytdlpEnabled,
        configuredBinaryPath: media.ytdlpBinaryPath,
        allUrls: media.ytdlpAllUrls,
        ...(media.ytdlpFormat.trim()
          ? { format: media.ytdlpFormat.trim() }
          : {}),
        ...proxy,
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
      const proxy = publicExtractorProxyOptions(deps.getProxySettings())
      return {
        enabled: media.ytdlpEnabled,
        allUrls: media.ytdlpAllUrls,
        ...proxy,
      }
    },
    isMediaSite: isLikelyMediaSite,
  })

  return {
    resolve: createYtdlpMediaResolver(resolverDeps, isLikelyMediaSite),
    listFormats: async (req, signal) => {
      throwIfYtdlpAborted(signal)
      if (
        req.cookies?.length ||
        !deps.getMediaSettings().ytdlpEnabled ||
        publicExtractorProxyOptions(deps.getProxySettings())
          .proxyUnsupportedReason
      )
        return formatLister(req, signal)
      const pipelineAvailable = await deps.isMuxAvailable()
      throwIfYtdlpAborted(signal)
      return formatLister(
        {
          ...req,
          audioExtractAvailable: req.audioExtractAvailable && pipelineAvailable,
          muxAvailable:
            (req.muxAvailable ?? req.audioExtractAvailable) &&
            pipelineAvailable,
        },
        signal
      )
    },
    invalidate: () => {
      cache = null
    },
    location: () => probe(deps.getMediaSettings().ytdlpBinaryPath),
  }
}
