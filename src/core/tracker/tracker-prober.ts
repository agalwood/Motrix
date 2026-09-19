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

  private async probeUdp(url: string, timeoutMs: number): Promise<number> {
    const { createSocket } = await import('node:dgram')
    const parsed = new URL(url)
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const socket = createSocket('udp4')
      let settled = false

      const finish = (error?: Error) => {
        // DNS/send callbacks can arrive after the deadline closed the socket.
        // Every completion path must claim cleanup before calling close().
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('message', onMessage)
        try {
          socket.close()
        } catch (closeError) {
          // A native socket may already be closed after a network failure.
          if (
            (closeError as NodeJS.ErrnoException).code !==
            'ERR_SOCKET_DGRAM_NOT_RUNNING'
          ) {
            reject(closeError)
            return
          }
        }
        if (error) reject(error)
        else resolve(Date.now() - start)
      }
      const onMessage = () => finish()
      const onError = (error: Error) => finish(error)
      const timer = setTimeout(
        () => finish(new Error('UDP probe timeout')),
        timeoutMs
      )

      // Keep the error handler through close so in-flight network errors are
      // contained by this probe instead of reaching uncaughtException.
      socket.on('error', onError)
      socket.once('close', () => socket.off('error', onError))
      socket.once('message', onMessage)

      try {
        // Minimal BT UDP tracker connection request
        const buf = Buffer.alloc(16)
        buf.writeBigInt64BE(0x41727101980n, 0) // protocol_id
        buf.writeInt32BE(0, 8) // action: connect
        buf.writeInt32BE((Math.random() * 0x7fffffff) | 0, 12) // transaction_id
        socket.send(buf, 0, 16, Number(parsed.port), parsed.hostname, (err) => {
          if (err) finish(err)
        })
      } catch (error) {
        finish(error as Error)
      }
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
