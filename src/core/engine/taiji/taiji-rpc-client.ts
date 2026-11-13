import { AppError, ErrorCode } from '@shared/errors'
import { z } from 'zod'
import { Aria2RpcClient } from '../aria2/aria2-rpc-client'
import type { JsonRpcProtocol } from '../aria2/json-rpc-protocol'
import type { WebSocketTransport } from '../aria2/web-socket-transport'
import type { HttpOutput } from '../engine-adapter'

const versionSchema = z.object({
  version: z.string().regex(/^taiji\/\d+\.\d+\.\d+(?:[-+].*)?$/),
  enabledFeatures: z.array(z.string()),
})

// These belong to the Motrix aria2 fork, not the shared RPC contract.
// Reject locally, including in batches, instead of interpreting absence as
// success or sending recovery operations to a different persistence model.
const FORK_ONLY_METHODS = new Set([
  'getDownloadResultCount',
  'searchDownloadResult',
  'exportSession',
  'requeueDownloadResult',
  'getCheckpointStatus',
  'getHttpRetryStatusV1',
  'retryHttpDownloadV1',
  'inspectLegacyCheckpointV1',
  'addLegacyTorrentV1',
  'importLegacyCheckpointV1',
  'reconcileLegacyCheckpointV1',
])

/** Native taiji RPC; never enables the daemon's aria2 compatibility mode. */
export class TaijiRpcClient extends Aria2RpcClient {
  constructor(
    transport: WebSocketTransport,
    protocol: JsonRpcProtocol,
    secret: string
  ) {
    super(transport, protocol, secret, 'taiji')
  }

  protected override wireMethod(method: string): string {
    const name = method.replace(/^(?:aria2|taiji)\./, '')
    if (FORK_ONLY_METHODS.has(name)) {
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        `taiji does not implement the legacy engine method ${name}`
      )
    }
    return super.wireMethod(method)
  }

  protected override wireParams(method: string, params: unknown[]): unknown[] {
    const name = method.replace(/^(?:aria2|taiji)\./, '')
    const optionIndex =
      name === 'changeGlobalOption'
        ? 0
        : name === 'addUri' || name === 'changeOption'
          ? 1
          : name === 'addTorrent' || name === 'addUriWithCookies'
            ? 2
            : -1
    if (optionIndex < 0) return params
    const input = params[optionIndex]
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return params
    const options = { ...input } as Record<string, unknown>
    for (const [key, value] of Object.entries(options)) {
      if (!Array.isArray(value)) continue
      if (
        key !== 'header' ||
        !value.every((line) => typeof line === 'string' && !/[\r\n]/.test(line))
      )
        throw new TypeError('Unsupported native taiji option array')
      options[key] = value.join('\n')
    }

    if (name === 'addUri' && Array.isArray(params[0])) {
      const uris = params[0] as unknown[]
      if (uris.some((uri) => typeof uri === 'string' && /^magnet:/i.test(uri)))
        options['bt-save-metadata'] ??= 'true'
      else if (options['bt-metadata-only'] === 'true') {
        options['follow-torrent'] = 'false'
        options.out ??=
          typeof options.gid === 'string' && /^[a-f0-9]{16}$/i.test(options.gid)
            ? `${options.gid}.torrent`
            : 'metadata.torrent'
      }
    }
    const endpoint = options['all-proxy']
    if (
      typeof endpoint === 'string' &&
      endpoint &&
      ('all-proxy-user' in options || 'all-proxy-passwd' in options)
    ) {
      try {
        const proxy = new URL(endpoint)
        if (typeof options['all-proxy-user'] === 'string')
          proxy.username = options['all-proxy-user']
        if (typeof options['all-proxy-passwd'] === 'string')
          proxy.password = options['all-proxy-passwd']
        options['all-proxy'] = proxy.toString()
      } catch {
        throw new TypeError('Invalid taiji proxy configuration')
      }
    }
    delete options['all-proxy-user']
    delete options['all-proxy-passwd']
    const result = [...params]
    result[optionIndex] = options
    return result
  }

  protected override wireResult(method: string, result: unknown): unknown {
    const name = method.replace(/^(?:aria2|taiji)\./, '')
    const normalizeStatus = (value: unknown): unknown => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return value
      const row = value as Record<string, unknown>
      // The shared polling model represents active seeds with a seeder flag.
      // Native taiji separates seed/check scheduling pools in its wire status.
      if (row.status === 'seeding')
        return { ...row, status: 'active', seeder: 'true' }
      if (row.status === 'checking') return { ...row, status: 'waiting' }
      return value
    }
    if (name === 'tellStatus') return normalizeStatus(result)
    if (
      ['tellActive', 'tellWaiting', 'tellStopped'].includes(name) &&
      Array.isArray(result)
    ) {
      return result.map(normalizeStatus)
    }
    if (name === 'getGlobalStat' && result && typeof result === 'object') {
      const stats = result as Record<string, unknown>
      const counts = ['numActive', 'numSeeding', 'numChecking'].map((key) =>
        Number(stats[key] ?? 0)
      )
      if (counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
        return {
          ...stats,
          numActive: String(counts.reduce((sum, count) => sum + count, 0)),
        }
      }
    }
    return result
  }

  override async getVersion() {
    const result = versionSchema.safeParse(await super.getVersion())
    if (!result.success) {
      throw new AppError(
        ErrorCode.EngineProtocolError,
        'The download engine did not identify itself as taiji'
      )
    }
    return result.data
  }

  override onDownloadComplete(
    handler: (event: { gid: string }) => void
  ): () => void {
    const complete = super.onDownloadComplete(handler)
    const ready = this.addHandler('aria2.onHttpOutputReady', handler)
    return () => {
      complete()
      ready()
    }
  }

  async getHttpOutput(gid: string): Promise<HttpOutput> {
    const raw = await this.call('taiji.getHttpOutput', [gid])
    return z
      .object({
        state: z.enum(['downloading', 'ready', 'publishing', 'published']),
        hostControlled: z
          .enum(['true', 'false'])
          .transform((value) => value === 'true'),
        paused: z
          .enum(['true', 'false'])
          .transform((value) => value === 'true'),
        sourcePath: z.string().optional(),
        finalPath: z.string().optional(),
        length: z.coerce.number().int().nonnegative().optional(),
        error: z.string().optional(),
      })
      .parse(raw)
  }

  async finalizeHttpOutput(
    gid: string,
    action: 'publish' | 'external' | 'hold',
    path?: string
  ): Promise<void> {
    await this.call('taiji.finalizeHttp', [
      gid,
      { action, ...(path ? { path } : {}) },
    ])
  }

  forceRecheck(gid: string): Promise<string> {
    return this.call('taiji.forceRecheck', [gid])
  }
}
