import {
  ErrorCodes,
  makeMdxpError,
  type UrlProbeResult,
  type UrlResolveParams,
  type UrlResolveResult,
} from '@motrix/mdxp'
import type { CancellationToken } from 'vscode-jsonrpc'
import type { BridgeConnection } from './bridge-connection'

export type ResolveOptions = NonNullable<UrlResolveParams['preferences']>

/**
 * Orchestrates `url/probe` + `url/resolve` against the active
 * BridgeConnections. v0.2.0 strategy: first-positive-probe wins
 * (spec §10.5). Multi-session priority routing is a future iteration.
 */
export class UrlResolutionService {
  constructor(private readonly getSessions: () => BridgeConnection[]) {}

  /**
   * First-positive-probe-wins scan: probe each active session in order and
   * return the first that reports `handled`, along with its probe result.
   * Probe failures are swallowed and skipped. Shared by `probe()` and
   * `resolve()` so the two can never diverge on iteration/short-circuit.
   */
  private async findHandlingSession(url: string): Promise<{
    session: BridgeConnection
    result: UrlProbeResult
  } | null> {
    for (const session of this.getSessions()) {
      try {
        const result = await session.sendRequest('url/probe', { url })
        if (result.handled) return { session, result }
      } catch {
        // probe failure → try next session
      }
    }
    return null
  }

  async probe(url: string): Promise<UrlProbeResult | null> {
    return (await this.findHandlingSession(url))?.result ?? null
  }

  async resolve(
    url: string,
    options: ResolveOptions,
    token?: CancellationToken
  ): Promise<UrlResolveResult> {
    if (this.getSessions().length === 0) {
      throw makeMdxpError(
        ErrorCodes.CapabilityNotSupported,
        'no extension session available',
        { appCode: 'bridge.no_session' }
      )
    }

    const chosen = await this.findHandlingSession(url)
    if (!chosen) {
      throw makeMdxpError(
        ErrorCodes.ResourceUnavailable,
        'no adapter handles this URL',
        { appCode: 'bridge.no_adapter', context: { url } }
      )
    }

    // Build preferences carefully — exactOptionalPropertyTypes means we
    // must NOT include keys with undefined values. The explicit whitelist
    // also drops any stray keys the (IPC-sourced) options object carries.
    const preferences: NonNullable<UrlResolveParams['preferences']> = {}
    if (options.maxQuality !== undefined)
      preferences.maxQuality = options.maxQuality
    if (options.preferContainer !== undefined)
      preferences.preferContainer = options.preferContainer
    if (options.includeAudio !== undefined)
      preferences.includeAudio = options.includeAudio
    if (options.includeSubtitles !== undefined)
      preferences.includeSubtitles = options.includeSubtitles

    const params: UrlResolveParams = Object.keys(preferences).length
      ? { url, preferences }
      : { url }

    return chosen.session.sendRequest('url/resolve', params, token)
  }
}
