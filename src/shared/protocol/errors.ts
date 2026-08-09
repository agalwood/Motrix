import { AppError, ErrorCode } from '../errors'

export const PROTOCOL_ENVELOPE_VERSION = 'motrix-rpc-v1' as const
export const MAX_PROTOCOL_ERROR_CODE_LENGTH = 128
export const MAX_PROTOCOL_ERROR_MESSAGE_LENGTH = 1_024

export interface ProtocolSuccess<T> {
  protocol: typeof PROTOCOL_ENVELOPE_VERSION
  ok: true
  value: T
}

export interface ProtocolFailure {
  protocol: typeof PROTOCOL_ENVELOPE_VERSION
  ok: false
  error: {
    code: ErrorCode
    message: string
  }
}

export type ProtocolEnvelope<T> = ProtocolSuccess<T> | ProtocolFailure

const KNOWN_ERROR_CODES = new Set<string>(Object.values(ErrorCode))

function isKnownErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PROTOCOL_ERROR_CODE_LENGTH &&
    KNOWN_ERROR_CODES.has(value)
  )
}

function sanitizeMessage(value: unknown): string {
  const raw = typeof value === 'string' ? value : ''
  const sanitized = raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (sanitized || 'Request failed').slice(
    0,
    MAX_PROTOCOL_ERROR_MESSAGE_LENGTH
  )
}

function genericProtocolFailure(): ProtocolFailure {
  return {
    protocol: PROTOCOL_ENVELOPE_VERSION,
    ok: false,
    error: {
      code: ErrorCode.EngineProtocolError,
      message: 'Request failed',
    },
  }
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      return null
    }
    const record: Record<string, unknown> = {}
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return null
      record[key] = descriptor.value
    }
    return record
  } catch {
    return null
  }
}

function hasOwnProtocolMarker(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'protocol')
    return (
      descriptor !== undefined &&
      'value' in descriptor &&
      descriptor.value === PROTOCOL_ENVELOPE_VERSION
    )
  } catch {
    throw new ProtocolEnvelopeError()
  }
}

export function makeProtocolSuccess<T>(value: T): ProtocolSuccess<T> {
  if (value === undefined || hasOwnProtocolMarker(value)) {
    throw new ProtocolEnvelopeError()
  }
  return {
    protocol: PROTOCOL_ENVELOPE_VERSION,
    ok: true,
    value,
  }
}

export function makeProtocolFailure(error: unknown): ProtocolFailure {
  try {
    if (typeof error !== 'object' || error === null) {
      return genericProtocolFailure()
    }
    const code = ownDataValue(error, 'code')
    const message = ownDataValue(error, 'message')
    if (
      (error instanceof AppError || isKnownErrorCode(code)) &&
      isKnownErrorCode(code)
    ) {
      return {
        protocol: PROTOCOL_ENVELOPE_VERSION,
        ok: false,
        error: {
          code,
          message: sanitizeMessage(message),
        },
      }
    }
  } catch {
    return genericProtocolFailure()
  }
  return genericProtocolFailure()
}

export class ProtocolEnvelopeError extends Error {
  constructor(message = 'Malformed RPC response envelope') {
    super(message)
    this.name = 'ProtocolEnvelopeError'
  }
}

export class TransportError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TransportError'
  }
}

function requireEnvelope(value: unknown): ProtocolEnvelope<unknown> {
  const success = exactDataRecord(value, ['protocol', 'ok', 'value'])
  if (
    success?.protocol === PROTOCOL_ENVELOPE_VERSION &&
    success.ok === true &&
    success.value !== undefined &&
    !hasOwnProtocolMarker(success.value)
  ) {
    return value as ProtocolSuccess<unknown>
  }

  const failure = exactDataRecord(value, ['protocol', 'ok', 'error'])
  const error = exactDataRecord(failure?.error, ['code', 'message'])
  if (
    failure?.protocol !== PROTOCOL_ENVELOPE_VERSION ||
    failure.ok !== false ||
    error === null ||
    !isKnownErrorCode(error.code) ||
    typeof error.message !== 'string' ||
    error.message.length === 0 ||
    error.message.length > MAX_PROTOCOL_ERROR_MESSAGE_LENGTH
  ) {
    throw new ProtocolEnvelopeError()
  }
  return value as ProtocolFailure
}

export function parseProtocolEnvelope<T>(value: unknown): T {
  const envelope = requireEnvelope(value)
  if (envelope.ok) return envelope.value as T
  throw new TransportError(envelope.error.code, envelope.error.message)
}

export function unwrapProtocolEnvelope<T>(value: unknown): T {
  return hasOwnProtocolMarker(value)
    ? parseProtocolEnvelope<T>(value)
    : (value as T)
}

export function assertTaskInspectorActivityArguments(
  args: unknown
): asserts args is [unknown] {
  if (!Array.isArray(args) || args.length !== 1) {
    throw new AppError(
      ErrorCode.IpcInvalidPayload,
      'Invalid Task Inspector Activity query arguments'
    )
  }
}
