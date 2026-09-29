import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIP } from 'node:net'
import type {
  ProxyConfig,
  TrackerHealth,
  TrackerProtocol,
} from '@shared/types/tracker'
import {
  createTrackerHttpClient,
  type TrackerHttpClient,
} from './tracker-http-client'

interface ProbeOptions {
  timeoutMs: number
  proxy?: ProxyConfig
  healthyThresholdMs?: number
  signal?: AbortSignal
  routeKey?: string
}

export class TrackerProber {
  async probe(urls: string[], opts: ProbeOptions): Promise<TrackerHealth[]> {
    if (!urls.length) return []
    const client = await createTrackerHttpClient(opts.proxy)
    const groups = new Map<string, { url: string; index: number }[]>()
    urls.forEach((url, index) => {
      let host: string
      try {
        host = new URL(url).hostname
      } catch {
        host = url
      }
      const group = groups.get(host) ?? []
      group.push({ url, index })
      groups.set(host, group)
    })
    const queue = [...groups.values()]
    const results: TrackerHealth[] = new Array(urls.length)
    try {
      await Promise.all(
        Array.from({ length: Math.min(8, queue.length) }, async () => {
          while (queue.length) {
            const group = queue.shift()
            if (!group) return
            for (const { url, index } of group) {
              if (opts.signal?.aborted) throw opts.signal.reason
              const protocol = url.split(':', 1)[0] as TrackerProtocol
              const record: TrackerHealth = {
                url,
                protocol,
                status: 'unknown',
                lastProbeMs: null,
                lastProbeAt: Date.now(),
                successCount: 0,
                failCount: 0,
                successRate: 0,
                routeKey: opts.routeKey,
                evidence: 'none',
              }
              // HTTP proxies cannot carry UDP announces; never silently bypass them.
              if (
                protocol !== 'ws' &&
                protocol !== 'wss' &&
                !(protocol === 'udp' && opts.proxy)
              ) {
                try {
                  const ms = await this.probeOne(url, opts, client)
                  record.status =
                    ms <= (opts.healthyThresholdMs ?? 3000) ? 'healthy' : 'slow'
                  record.lastProbeMs = ms
                  record.successCount = 1
                  record.successRate = 1
                  record.evidence = protocol === 'udp' ? 'udp' : 'http'
                } catch {
                  if (opts.signal?.aborted) throw opts.signal.reason
                  record.status = 'unreachable'
                  record.failCount = 1
                }
              }
              results[index] = record
            }
          }
        })
      )
    } finally {
      await client.close()
    }
    return results
  }

  private async probeOne(
    url: string,
    opts: ProbeOptions,
    client: TrackerHttpClient
  ): Promise<number> {
    if (url.startsWith('udp:'))
      return this.probeUdp(url, opts.timeoutMs, opts.signal)
    const start = performance.now()
    const response = await client.fetch(url, {
      method: 'HEAD',
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
        : AbortSignal.timeout(opts.timeoutMs),
    })
    await response.body
      ?.getReader()
      .cancel()
      .catch(() => undefined)
    if ((response.status ?? 200) >= 500)
      throw new Error('HTTP tracker unavailable')
    // A 401/403/405 is still HTTP connectivity evidence, not announce success.
    return Math.round(performance.now() - start)
  }

  private async probeUdp(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<number> {
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    const port = Number(parsed.port)
    if (!port || port > 65535) throw new Error('Invalid tracker port')
    return new Promise((resolve, reject) => {
      const start = performance.now()
      const socket = createSocket(isIP(hostname) === 6 ? 'udp6' : 'udp4')
      const transaction = randomBytes(4).readUInt32BE()
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        socket.off('message', onMessage)
        try {
          socket.close()
        } catch (closeError) {
          if (
            (closeError as NodeJS.ErrnoException).code !==
            'ERR_SOCKET_DGRAM_NOT_RUNNING'
          ) {
            reject(closeError)
            return
          }
        }
        if (error) reject(error)
        else resolve(Math.round(performance.now() - start))
      }
      const onMessage = (message: Buffer) => {
        if (message.length < 8 || message.readUInt32BE(4) !== transaction)
          return
        const action = message.readUInt32BE(0)
        if (action === 3) finish(new Error('UDP tracker error'))
        else if (action === 0 && message.length === 16) finish()
      }
      const onAbort = () => finish(new Error('Tracker probe cancelled'))
      const onError = (error: Error) => finish(error)
      const timer = setTimeout(
        () => finish(new Error('UDP probe timeout')),
        timeoutMs
      )
      socket.on('error', onError)
      socket.once('close', () => socket.off('error', onError))
      socket.on('message', onMessage)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      try {
        // A connected UDP socket only accepts datagrams from this endpoint.
        socket.connect(port, hostname, () => {
          if (settled) return
          const request = Buffer.alloc(16)
          request.writeBigUInt64BE(0x41727101980n, 0)
          request.writeUInt32BE(0, 8)
          request.writeUInt32BE(transaction, 12)
          try {
            socket.send(request, (error) => {
              if (error) finish(error)
            })
          } catch (error) {
            finish(error as Error)
          }
        })
      } catch (error) {
        finish(error as Error)
      }
    })
  }
}
