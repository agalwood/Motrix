import {
  buildBindingRequest,
  parseBindingResponse,
  type StunResult,
} from '@core/nat/codecs'
import {
  type ParseResult,
  parseErr,
  parseOk,
} from '@core/nat/codecs/parse-result'
import { natLogger } from '@core/nat/logger'
import type { UdpSocketFactory } from '@core/nat/net/udp-socket'
import { ErrorCode } from '@shared/errors'

const log = natLogger('stun')
const MAX_SERVERS = 10

export interface StunClientOptions {
  udpFactory: UdpSocketFactory
}

export interface DetectNatTypeOptions {
  servers: string[] // host:port strings — caller validates format
  timeoutMs: number
  signal?: AbortSignal
}

export class StunClient {
  private readonly udpFactory: UdpSocketFactory

  constructor(opts: StunClientOptions) {
    this.udpFactory = opts.udpFactory
  }

  async detectNatType(
    options: DetectNatTypeOptions
  ): Promise<ParseResult<StunResult>> {
    if (options.servers.length === 0) {
      return parseErr(
        ErrorCode.StunDetectionFailed,
        'no STUN servers configured'
      )
    }
    if (options.servers.length > MAX_SERVERS) {
      return parseErr(ErrorCode.StunDetectionFailed, 'too many STUN servers')
    }
    // Query first server; subsequent servers are tried only if first fails.
    // Phase 1 heuristic: mappedIp is sufficient to report — NAT type
    // classification (Symmetric vs FullCone) requires two-server comparison;
    // that's future work.
    for (const server of options.servers) {
      const parsed = this.parseServer(server)
      if (!parsed.ok) {
        log.warn({ server }, 'ignoring invalid STUN server format')
        continue
      }
      const result = await this.queryServer(
        parsed.value.host,
        parsed.value.port,
        options.timeoutMs,
        options.signal
      )
      if (result.ok) {
        log.debug(
          { server, mappedIp: result.value.mappedIp },
          'STUN detection succeeded'
        )
        return result
      }
      log.warn(
        { server, err: result.error },
        'STUN server query failed, trying next'
      )
    }
    return parseErr(ErrorCode.StunDetectionFailed, 'all STUN servers failed')
  }

  private parseServer(s: string): ParseResult<{ host: string; port: number }> {
    const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(s)
    if (!m)
      return parseErr(ErrorCode.NatParseError, 'invalid STUN server format')
    // biome-ignore lint/style/noNonNullAssertion: regex guarantees group 1
    const host = m[1]!
    // biome-ignore lint/style/noNonNullAssertion: regex guarantees group 2
    const port = Number(m[2]!)
    if (port < 1 || port > 65535) {
      return parseErr(ErrorCode.NatParseError, 'STUN port out of range')
    }
    return parseOk({ host, port })
  }

  private queryServer(
    host: string,
    port: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ParseResult<StunResult>> {
    const { buffer, transactionId } = buildBindingRequest()
    const socket = this.udpFactory({ type: 'udp4' })
    let settled = false
    const safeTimeout = Math.max(1, timeoutMs)

    return new Promise<ParseResult<StunResult>>((resolve) => {
      const finish = async (r: ParseResult<StunResult>) => {
        if (settled) return
        settled = true
        await socket.close().catch(() => {})
        resolve(r)
      }

      const timer = setTimeout(
        () => void finish(parseErr(ErrorCode.NatTimeout, 'stun timeout')),
        safeTimeout
      )
      timer.unref?.()

      socket.onMessage((msg, _rinfo) => {
        if (settled) return
        const parsed = parseBindingResponse(msg, transactionId)
        if (!parsed.ok) return
        clearTimeout(timer)
        void finish(parsed)
      })

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer)
          void finish(parseErr(ErrorCode.NatTimeout, 'aborted'))
          return
        }
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            void finish(parseErr(ErrorCode.NatTimeout, 'aborted'))
          },
          { once: true }
        )
      }

      ;(async () => {
        try {
          await socket.bind(0)
          await socket.send(buffer, port, host)
        } catch (err) {
          clearTimeout(timer)
          void finish(
            parseErr(ErrorCode.NatGatewayUnreachable, (err as Error).message)
          )
        }
      })()
    })
  }
}
