import { ErrorCode } from '@shared/errors'
import { type ParseResult, parseErr, parseOk } from './parse-result'
import { ALLOWED_SERVICE_TYPES_FOR_PORT_MAPPING } from './soap-codec'
import {
  findChild,
  findDescendants,
  localName,
  parseXml,
  type XmlElement,
} from './xml-parser'

export const DEVICE_DESC_MAX_SIZE = 64 * 1024
export const DEVICE_DESC_MAX_ELEMENTS = 1500
export const DEVICE_DESC_MAX_DEPTH = 10
export const CONTROL_URL_MAX_LENGTH = 200

export interface ServiceDescription {
  serviceType: string
  controlUrl: string
}

export interface DeviceDescription {
  friendlyName: string
  manufacturer: string
  modelName: string
  services: ServiceDescription[]
}

export function parseDeviceDescription(
  xml: string
): ParseResult<DeviceDescription> {
  if (xml.length > DEVICE_DESC_MAX_SIZE) {
    return parseErr(
      ErrorCode.NatSecurityViolation,
      'device description too large'
    )
  }
  const parsed = parseXml(xml, {
    maxSize: DEVICE_DESC_MAX_SIZE,
    maxElements: DEVICE_DESC_MAX_ELEMENTS,
    maxDepth: DEVICE_DESC_MAX_DEPTH,
  })
  if (!parsed.ok) return parsed

  const root = parsed.value
  if (localName(root.name) !== 'root') {
    return parseErr(ErrorCode.NatParseError, 'root element is not <root>')
  }

  const topDevice = findChild(root, 'device')
  if (!topDevice) {
    return parseErr(ErrorCode.NatParseError, 'missing device element')
  }

  const friendlyName = findFirstText(topDevice, 'friendlyName')
  const manufacturer = findFirstText(topDevice, 'manufacturer')
  const modelName = findFirstText(topDevice, 'modelName')

  const services: ServiceDescription[] = []

  const allServices = findDescendants(topDevice, 'service')
  for (const svc of allServices) {
    const serviceType = findFirstText(svc, 'serviceType')
    if (!serviceType) continue
    if (
      !(ALLOWED_SERVICE_TYPES_FOR_PORT_MAPPING as readonly string[]).includes(
        serviceType
      )
    ) {
      continue
    }

    const controlUrlRaw = findFirstText(svc, 'controlURL')
    if (!controlUrlRaw) continue

    const validated = validateControlUrl(controlUrlRaw)
    if (!validated.ok) return validated
    services.push({ serviceType, controlUrl: validated.value })
  }

  return parseOk({
    friendlyName: friendlyName ?? '',
    manufacturer: manufacturer ?? '',
    modelName: modelName ?? '',
    services,
  })
}

function findFirstText(el: XmlElement, name: string): string | null {
  const child = findChild(el, name)
  if (child) return child.text
  const descendants = findDescendants(el, name)
  return descendants[0]?.text ?? null
}

function validateControlUrl(url: string): ParseResult<string> {
  if (url.length === 0 || url.length > CONTROL_URL_MAX_LENGTH) {
    return parseErr(ErrorCode.NatSecurityViolation, 'controlURL length')
  }
  if (!url.startsWith('/')) {
    return parseErr(
      ErrorCode.NatSecurityViolation,
      'controlURL must be a relative absolute path starting with /'
    )
  }
  if (/^https?:\/\//i.test(url)) {
    return parseErr(
      ErrorCode.NatSecurityViolation,
      'controlURL must not be absolute'
    )
  }
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c < 0x20 || c > 0x7e) {
      return parseErr(
        ErrorCode.NatSecurityViolation,
        'controlURL has disallowed byte'
      )
    }
  }
  if (!/^[A-Za-z0-9/_.:\-~%]+$/.test(url)) {
    return parseErr(
      ErrorCode.NatSecurityViolation,
      'controlURL has disallowed character'
    )
  }
  if (url.includes('..')) {
    return parseErr(ErrorCode.NatSecurityViolation, 'controlURL contains ..')
  }
  return parseOk(url)
}
