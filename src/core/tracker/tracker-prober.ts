import type {
  ProxyConfig,
  TrackerHealth,
  TrackerProtocol,
} from '@shared/types/tracker'
import { trackerLogger } from './logger'
import {
  createTrackerHttpClient,
  type TrackerHttpClient,
} from './tracker-http-client'

const log = trackerLogger('prober')

interface ProbeOptions {
  timeoutMs: number
  proxy?: ProxyConfig
  healthyThresholdMs?: number
}

export class TrackerProber {
  async probe(urls: string[], opts: ProbeOptions): Promise<TrackerHealth[]> {
    if (urls.length === 0) return []

    const threshold = opts.healthyThresholdMs ?? 3000
    const start = Date.now()
    log.info(
      {
        urls: urls.length,
        timeoutMs: opts.timeoutMs,
        healthyThresholdMs: threshold,
        proxy: Boolean(opts.proxy),
      },
      'probe start'
    )
    const httpClient = await createTrackerHttpClient(opts.proxy)
    let results: PromiseSettledResult<number>[]
    try {
      results = await Promise.allSettled(
        urls.map((url) => this.probeOne(url, opts, httpClient))
      )
    } finally {
      await httpClient.close()
    }

    const mapped = results.map((r, i) => {
      const url = urls[i]
      const protocol = this.detectProtocol(url)
      const now = Date.now()

      if (r.status === 'fulfilled') {
        const ms = r.value
        const status = ms <= threshold ? 'healthy' : 'slow'
        return {
          url,
          protocol,
          status: status as 'healthy' | 'slow',
          lastProbeMs: ms,
          lastProbeAt: now,
          successCount: 1,
          failCount: 0,
          successRate: 1.0,
        }
      }
      return {
        url,
        protocol,
        status: 'unreachable' as const,
        lastProbeMs: null,
        lastProbeAt: now,
        successCount: 0,
        failCount: 1,
        successRate: 0,
      }
    })

    const counts = { healthy: 0, slow: 0, unreachable: 0 }
    for (const h of mapped) {
      if (h.status === 'healthy') counts.healthy++
      else if (h.status === 'slow') counts.slow++
      else counts.unreachable++
    }
    log.info(
      { total: mapped.length, ...counts, elapsedMs: Date.now() - start },
      'probe done'
    )
    return mapped
  }

  private async probeOne(
    url: string,
    opts: ProbeOptions,
    httpClient: TrackerHttpClient
  ): Promise<number> {
    const protocol = this.detectProtocol(url)
    const start = Date.now()

    if (protocol === 'udp') {
      return this.probeUdp(url, opts.timeoutMs)
    }

    await httpClient.fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
    return Date.now() - start
  }

  private probeUdp(url: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      import('node:dgram').then(({ createSocket }) => {
        const start = Date.now()
        const parsed = new URL(url)
        const socket = createSocket('udp4')
        const timer = setTimeout(() => {
          socket.close()
          reject(new Error('UDP probe timeout'))
        }, timeoutMs)

        // Minimal BT UDP tracker connection request
        const buf = Buffer.alloc(16)
        buf.writeBigInt64BE(0x41727101980n, 0) // protocol_id
        buf.writeInt32BE(0, 8) // action: connect
        buf.writeInt32BE((Math.random() * 0x7fffffff) | 0, 12) // transaction_id
        socket.send(buf, 0, 16, Number(parsed.port), parsed.hostname, (err) => {
          if (err) {
            clearTimeout(timer)
            socket.close()
            reject(err)
            return
          }
          socket.once('message', () => {
            clearTimeout(timer)
            socket.close()
            resolve(Date.now() - start)
          })
        })
      })
    })
  }

  private detectProtocol(url: string): TrackerProtocol {
    if (url.startsWith('udp://')) return 'udp'
    if (url.startsWith('wss://')) return 'wss'
    if (url.startsWith('ws://')) return 'ws'
    if (url.startsWith('https://')) return 'https'
    return 'http'
  }
}
