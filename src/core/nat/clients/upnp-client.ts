import {
  buildMSearch,
  buildSoapEnvelope,
  parseDeviceDescription,
  parseMSearchResponse,
  parseSoapResponse,
  type SoapResult,
  SSDP_IGD_SEARCH_TARGETS,
  SSDP_MULTICAST_ADDR,
  SSDP_MULTICAST_PORT,
} from '@core/nat/codecs'
import {
  isLinkLocalIpv4,
  isPrivateIpv4,
  isValidPort,
} from '@core/nat/codecs/ip-utils'
import {
  type ParseResult,
  parseErr,
  parseOk,
} from '@core/nat/codecs/parse-result'
import { natLogger } from '@core/nat/logger'
import type { HttpClient } from '@core/nat/net/http-client'
import type { UdpRemoteInfo, UdpSocketFactory } from '@core/nat/net/udp-socket'
import { ErrorCode } from '@shared/errors'
import type { NatTransportProtocol } from '@shared/types/nat'

const log = natLogger('upnp')

export interface UpnpClientOptions {
  udpFactory: UdpSocketFactory
  http: HttpClient
  now?: () => number
}

export interface DiscoverOptions {
  timeoutMs?: number
  maxResponses?: number
  mx?: number
  /**
   * SSDP search targets to M-SEARCH for. Defaults to {@link
   * SSDP_IGD_SEARCH_TARGETS} (IGD v1 + v2); one packet is sent per target on
   * the shared discovery socket.
   */
  searchTargets?: readonly string[]
}

export interface DiscoveredGateway {
  gatewayIp: string
  controlUrl: string // Relative path, validated
  controlHost: string // IP for HTTP requests
  controlPort: number
  serviceType: string
  manufacturer: string
  modelName: string
}

export interface MapPortParams {
  internalIp: string
  internalPort: number
  externalPort: number
  protocol: NatTransportProtocol
  ttl: number
  description: string
}

export interface UnmapPortParams {
  externalPort: number
  protocol: NatTransportProtocol
}

export const DEFAULT_DISCOVER_TIMEOUT_MS = 3000
export const DEFAULT_MAX_RESPONSES = 10
export const DEFAULT_MX = 2

export class UpnpClient {
  private readonly udpFactory: UdpSocketFactory
  private readonly http: HttpClient
  private readonly now: () => number

  // At most one in-flight discovery at a time
  private discovering = false

  constructor(opts: UpnpClientOptions) {
    this.udpFactory = opts.udpFactory
    this.http = opts.http
    this.now = opts.now ?? (() => Date.now())
  }

  async discover(
    options: DiscoverOptions = {}
  ): Promise<ParseResult<DiscoveredGateway>> {
    if (this.discovering) {
      return parseErr(
        ErrorCode.NatDiscoveryFailed,
        'discovery already in progress'
      )
    }
    this.discovering = true
    const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS
    const maxResponses = options.maxResponses ?? DEFAULT_MAX_RESPONSES
    const mx = options.mx ?? DEFAULT_MX
    const searchTargets = options.searchTargets ?? SSDP_IGD_SEARCH_TARGETS

    const socket = this.udpFactory({ type: 'udp4' })
    let found: DiscoveredGateway | null = null
    let responsesReceived = 0
    let settled = false
    let processingResponse = false
    const ac = new AbortController()

    const cleanup = async () => {
      await socket.close().catch(() => {})
    }

    return new Promise<ParseResult<DiscoveredGateway>>((resolve) => {
      const settle = async (r: ParseResult<DiscoveredGateway>) => {
        if (settled) return
        settled = true
        ac.abort()
        this.discovering = false
        await cleanup()
        resolve(r)
      }

      const listener = async (msg: Buffer, rinfo: UdpRemoteInfo) => {
        if (found || settled) return
        responsesReceived++
        if (responsesReceived > maxResponses) return
        if (processingResponse) return
        // Synchronously mark that we're processing a response
        processingResponse = true
        try {
          const parsed = parseMSearchResponse(msg)
          if (!parsed.ok) {
            log.debug(
              { from: rinfo.address, err: parsed.error },
              'ssdp response rejected'
            )
            return
          }
          // parseMSearchResponse already validated the LOCATION URL and
          // exposes the decomposed endpoint; reuse it instead of re-validating.
          const endpoint = parsed.value.endpoint
          // Fetch device description
          const descResult = await this.http.request({
            method: 'GET',
            host: endpoint.host,
            port: endpoint.port,
            path: endpoint.path,
            timeoutMs: 5000,
            signal: ac.signal,
          })
          if (!descResult.ok) {
            log.warn(
              { err: descResult.error, host: endpoint.host },
              'device description fetch failed'
            )
            return
          }
          if (descResult.value.statusCode !== 200) {
            log.warn(
              { status: descResult.value.statusCode },
              'unexpected device desc status'
            )
            return
          }
          const desc = parseDeviceDescription(descResult.value.body)
          if (!desc.ok) {
            log.warn(
              { err: desc.error, detail: desc.detail },
              'device description parse failed'
            )
            return
          }
          const service = desc.value.services[0]
          if (!service) {
            log.debug('device has no supported service')
            return
          }
          found = {
            gatewayIp: rinfo.address,
            controlUrl: service.controlUrl,
            controlHost: endpoint.host,
            controlPort: endpoint.port,
            serviceType: service.serviceType,
            manufacturer: desc.value.manufacturer,
            modelName: desc.value.modelName,
          }
          await settle(parseOk(found))
        } finally {
          processingResponse = false
        }
      }

      socket.onMessage(listener)

      const timer = setTimeout(async () => {
        if (!settled) {
          await settle(
            parseErr(ErrorCode.NatDiscoveryFailed, 'discovery timed out')
          )
        }
      }, timeoutMs)
      timer.unref?.()

      ;(async () => {
        try {
          await socket.bind(0)
          for (const st of searchTargets) {
            await socket.send(
              buildMSearch(st, mx),
              SSDP_MULTICAST_PORT,
              SSDP_MULTICAST_ADDR
            )
          }
        } catch (err) {
          clearTimeout(timer)
          await settle(
            parseErr(ErrorCode.NatDiscoveryFailed, (err as Error).message)
          )
        }
      })()
    })
  }

  async mapPort(
    gateway: DiscoveredGateway,
    params: MapPortParams,
    signal?: AbortSignal
  ): Promise<ParseResult<void>> {
    // Validate externalPort
    if (!isValidPort(params.externalPort)) {
      return parseErr(
        ErrorCode.NatProtocolRejected,
        'externalPort out of range'
      )
    }
    // Validate internalPort
    if (!isValidPort(params.internalPort)) {
      return parseErr(
        ErrorCode.NatProtocolRejected,
        'internalPort out of range'
      )
    }
    // Validate ttl
    if (
      !Number.isInteger(params.ttl) ||
      params.ttl < 0 ||
      params.ttl > 604800
    ) {
      return parseErr(
        ErrorCode.NatProtocolRejected,
        'ttl out of range (0..604800)'
      )
    }
    // Validate internalIp is private or link-local
    if (
      !isPrivateIpv4(params.internalIp) &&
      !isLinkLocalIpv4(params.internalIp)
    ) {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'internalIp must be private or link-local IPv4'
      )
    }

    let envelope: string
    try {
      envelope = buildSoapEnvelope('AddPortMapping', gateway.serviceType, {
        NewRemoteHost: '',
        NewExternalPort: String(params.externalPort),
        NewProtocol: params.protocol,
        NewInternalPort: String(params.internalPort),
        NewInternalClient: params.internalIp,
        NewEnabled: '1',
        NewPortMappingDescription: params.description,
        NewLeaseDuration: String(params.ttl),
      })
    } catch (err) {
      return parseErr(ErrorCode.NatProtocolRejected, (err as Error).message)
    }
    const r = await this.soapCall(gateway, 'AddPortMapping', envelope, signal)
    return r.ok ? parseOk(undefined) : r
  }

  async unmapPort(
    gateway: DiscoveredGateway,
    params: UnmapPortParams,
    signal?: AbortSignal
  ): Promise<ParseResult<void>> {
    // Validate externalPort
    if (!isValidPort(params.externalPort)) {
      return parseErr(
        ErrorCode.NatProtocolRejected,
        'externalPort out of range'
      )
    }

    let envelope: string
    try {
      envelope = buildSoapEnvelope('DeletePortMapping', gateway.serviceType, {
        NewRemoteHost: '',
        NewExternalPort: String(params.externalPort),
        NewProtocol: params.protocol,
      })
    } catch (err) {
      return parseErr(ErrorCode.NatProtocolRejected, (err as Error).message)
    }
    const r = await this.soapCall(
      gateway,
      'DeletePortMapping',
      envelope,
      signal
    )
    return r.ok ? parseOk(undefined) : r
  }

  async getExternalIp(
    gateway: DiscoveredGateway,
    signal?: AbortSignal
  ): Promise<ParseResult<string>> {
    let envelope: string
    try {
      envelope = buildSoapEnvelope(
        'GetExternalIPAddress',
        gateway.serviceType,
        {}
      )
    } catch (err) {
      return parseErr(ErrorCode.NatProtocolRejected, (err as Error).message)
    }
    const result = await this.soapCall(
      gateway,
      'GetExternalIPAddress',
      envelope,
      signal
    )
    if (!result.ok) return result
    const ip = result.value.output.NewExternalIPAddress
    if (!ip) {
      return parseErr(ErrorCode.NatParseError, 'missing NewExternalIPAddress')
    }
    return parseOk(ip)
  }

  private async soapCall(
    gateway: DiscoveredGateway,
    action: string,
    envelope: string,
    signal?: AbortSignal
  ): Promise<ParseResult<Extract<SoapResult, { kind: 'result' }>>> {
    const res = await this.http.request({
      method: 'POST',
      host: gateway.controlHost,
      port: gateway.controlPort,
      path: gateway.controlUrl,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${gateway.serviceType}#${action}"`,
      },
      body: envelope,
      signal,
    })
    if (!res.ok) return res
    const parsed = parseSoapResponse(res.value.body)
    if (!parsed.ok) return parsed
    if (parsed.value.kind === 'fault') {
      return parseErr(
        mapUpnpErrorCode(parsed.value.upnpErrorCode),
        `SOAP fault ${parsed.value.upnpErrorCode}: ${parsed.value.upnpErrorDescription ?? parsed.value.faultString}`
      )
    }
    return parseOk(parsed.value)
  }
}

function mapUpnpErrorCode(code: number | null): ErrorCode {
  switch (code) {
    case 718:
      return ErrorCode.NatMappingConflict // ConflictInMappingEntry
    case 725:
      return ErrorCode.NatProtocolRejected // OnlyPermanentLeasesSupported
    case 727:
      return ErrorCode.NatProtocolRejected // ExternalPortOnlySupportsWildcard
    default:
      return ErrorCode.NatProtocolRejected
  }
}
