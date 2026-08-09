import { ErrorCode } from '@shared/errors'
import { type ParseResult, parseErr, parseOk } from './parse-result'
import { findChild, findDescendants, localName, parseXml } from './xml-parser'

export const SOAP_MAX_RESPONSE_SIZE = 16 * 1024
export const SOAP_MAX_ELEMENTS = 200
export const SOAP_MAX_DEPTH = 10

export const UPNP_WANIP_V1 = 'urn:schemas-upnp-org:service:WANIPConnection:1'
export const UPNP_WANIP_V2 = 'urn:schemas-upnp-org:service:WANIPConnection:2'
export const UPNP_WANPPP_V1 = 'urn:schemas-upnp-org:service:WANPPPConnection:1'

export const ALLOWED_SOAP_ACTIONS = [
  'AddPortMapping',
  'DeletePortMapping',
  'GetExternalIPAddress',
  'GetGenericPortMappingEntry',
  'AddAnyPortMapping',
  'DeletePortMappingRange',
] as const

const ALLOWED_SOAP_ACTIONS_SET = new Set<string>(ALLOWED_SOAP_ACTIONS)

/**
 * The three UPnP IGD service types Motrix knows how to drive for port
 * mapping. Single source of truth: both the SOAP envelope builder (to reject
 * unknown service types) and the device-description parser (to filter the
 * advertised services) gate on this list.
 */
export const ALLOWED_SERVICE_TYPES_FOR_PORT_MAPPING = [
  UPNP_WANIP_V1,
  UPNP_WANIP_V2,
  UPNP_WANPPP_V1,
] as const

export function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (ch) => {
    switch (ch) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '&':
        return '&amp;'
      case '"':
        return '&quot;'
      case "'":
        return '&apos;'
      default:
        return ch
    }
  })
}

export function buildSoapEnvelope(
  action: string,
  serviceType: string,
  params: Record<string, string>
): string {
  if (!ALLOWED_SOAP_ACTIONS_SET.has(action)) {
    throw new Error(`action not allowed: ${action}`)
  }
  if (
    !(ALLOWED_SERVICE_TYPES_FOR_PORT_MAPPING as readonly string[]).includes(
      serviceType
    )
  ) {
    throw new Error(`serviceType not allowed: ${serviceType}`)
  }
  if (!/^[A-Za-z0-9:._-]+$/.test(serviceType)) {
    throw new Error('invalid characters in serviceType')
  }

  const body = Object.entries(params)
    .map(([k, v]) => {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(k)) {
        throw new Error(`invalid param name: ${k}`)
      }
      return `      <${k}>${xmlEscape(String(v))}</${k}>`
    })
    .join('\n')

  return [
    '<?xml version="1.0"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '  <s:Body>',
    `    <u:${action} xmlns:u="${serviceType}">`,
    body,
    `    </u:${action}>`,
    '  </s:Body>',
    '</s:Envelope>',
  ].join('\n')
}

export type SoapResult =
  | {
      kind: 'result'
      actionName: string
      output: Record<string, string>
    }
  | {
      kind: 'fault'
      faultCode: string
      faultString: string
      upnpErrorCode: number | null
      upnpErrorDescription: string | null
    }

export function parseSoapResponse(xml: string): ParseResult<SoapResult> {
  if (xml.length > SOAP_MAX_RESPONSE_SIZE) {
    return parseErr(ErrorCode.NatSecurityViolation, 'soap response too large')
  }
  const parsed = parseXml(xml, {
    maxSize: SOAP_MAX_RESPONSE_SIZE,
    maxElements: SOAP_MAX_ELEMENTS,
    maxDepth: SOAP_MAX_DEPTH,
  })
  if (!parsed.ok) return parsed

  const envelope = parsed.value
  if (localName(envelope.name) !== 'Envelope') {
    return parseErr(ErrorCode.NatParseError, 'root is not s:Envelope')
  }

  const bodyEl = findChild(envelope, 'Body')
  if (!bodyEl) return parseErr(ErrorCode.NatParseError, 'missing s:Body')

  const faultEl = findChild(bodyEl, 'Fault')
  if (faultEl) {
    const faultCode = findChild(faultEl, 'faultcode')?.text ?? ''
    const faultString = findChild(faultEl, 'faultstring')?.text ?? ''
    let upnpErrorCode: number | null = null
    let upnpErrorDescription: string | null = null
    const errorEl = findDescendants(faultEl, 'UPnPError')[0]
    if (errorEl) {
      const code = findChild(errorEl, 'errorCode')?.text
      if (code && /^\d+$/.test(code)) upnpErrorCode = Number(code)
      upnpErrorDescription =
        findChild(errorEl, 'errorDescription')?.text ?? null
    }
    return parseOk({
      kind: 'fault',
      faultCode,
      faultString,
      upnpErrorCode,
      upnpErrorDescription,
    })
  }

  const actionEl = bodyEl.children[0]
  if (!actionEl) return parseErr(ErrorCode.NatParseError, 'empty body')

  const actionName = localName(actionEl.name)
  const output: Record<string, string> = {}
  for (const child of actionEl.children) {
    output[localName(child.name)] = child.text
  }

  return parseOk({ kind: 'result', actionName, output })
}
