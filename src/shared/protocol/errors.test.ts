import { describe, expect, it } from 'vitest'
import { AppError, ErrorCode } from '../errors'
import {
  makeProtocolFailure,
  makeProtocolSuccess,
  PROTOCOL_ENVELOPE_VERSION,
  ProtocolEnvelopeError,
  parseProtocolEnvelope,
  TransportError,
} from './errors'

describe('protocol error envelopes', () => {
  it('round-trips success values', () => {
    expect(parseProtocolEnvelope(makeProtocolSuccess({ revision: 7 }))).toEqual(
      {
        revision: 7,
      }
    )
  })

  it('reconstructs a typed transport error from AppError', () => {
    const envelope = makeProtocolFailure(
      new AppError(ErrorCode.TaskNotFound, 'task missing')
    )

    expect(() => parseProtocolEnvelope(envelope)).toThrowError(
      expect.objectContaining({
        name: 'TransportError',
        code: ErrorCode.TaskNotFound,
        message: 'task missing',
      })
    )
  })

  it('bounds and sanitizes messages without exposing generic framework text', () => {
    const message = `\u0000secret\n${'x'.repeat(2_000)}`
    const envelope = makeProtocolFailure(
      new AppError(ErrorCode.TaskNotFound, message)
    )
    expect(envelope.ok).toBe(false)
    if (envelope.ok) throw new Error('expected failure')
    expect(envelope.error.message).not.toContain('\u0000')
    expect(envelope.error.message.length).toBeLessThanOrEqual(1_024)
  })

  it('maps unknown exceptions to a bounded known code', () => {
    const envelope = makeProtocolFailure(new Error('sqlite exploded'))
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: ErrorCode.EngineProtocolError },
    })
  })

  it('maps invalid and hostile error objects without invoking getters', () => {
    const invalidAppError = new AppError(
      ErrorCode.TaskNotFound,
      'must not escape'
    )
    Object.defineProperty(invalidAppError, 'code', {
      value: 'NOT_A_REAL_CODE',
    })
    const hostile = {
      get code(): string {
        throw new Error('poison getter')
      },
    }

    expect(makeProtocolFailure(invalidAppError)).toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.EngineProtocolError,
        message: 'Request failed',
      },
    })
    expect(() => makeProtocolFailure(hostile)).not.toThrow()
    expect(makeProtocolFailure(hostile)).toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.EngineProtocolError,
        message: 'Request failed',
      },
    })
  })

  it.each([
    null,
    {},
    { protocol: 'motrix-rpc-v1', ok: true },
    {
      protocol: 'motrix-rpc-v1',
      ok: false,
      error: { code: 'NOT_A_REAL_CODE', message: 'bad' },
    },
    {
      protocol: 'motrix-rpc-v1',
      ok: false,
      error: { code: ErrorCode.TaskNotFound, message: 'x'.repeat(1_025) },
    },
    {
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: true,
      value: { revision: 1 },
      error: { code: ErrorCode.TaskNotFound, message: 'ambiguous' },
    },
    {
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: false,
      error: { code: ErrorCode.TaskNotFound, message: 'missing' },
      value: { revision: 1 },
    },
    {
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: true,
      value: undefined,
    },
  ])('rejects malformed envelopes: %j', (value) => {
    expect(() => parseProtocolEnvelope(value)).toThrow(ProtocolEnvelopeError)
  })

  it('rejects inherited, accessor, and nested envelopes deterministically', () => {
    const inherited = Object.create({
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: true,
    }) as { value: unknown }
    inherited.value = { revision: 1 }
    const accessor = {
      protocol: PROTOCOL_ENVELOPE_VERSION,
      get ok(): boolean {
        throw new Error('poison getter')
      },
      value: { revision: 1 },
    }
    const nested = {
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: true,
      value: {
        protocol: PROTOCOL_ENVELOPE_VERSION,
        ok: true,
        value: { revision: 1 },
      },
    }

    expect(() => parseProtocolEnvelope(inherited)).toThrow(
      ProtocolEnvelopeError
    )
    expect(() => parseProtocolEnvelope(accessor)).toThrow(ProtocolEnvelopeError)
    expect(() => parseProtocolEnvelope(nested)).toThrow(ProtocolEnvelopeError)
    expect(() => makeProtocolSuccess(undefined)).toThrow(ProtocolEnvelopeError)
    expect(() =>
      makeProtocolSuccess(makeProtocolSuccess({ revision: 1 }))
    ).toThrow(ProtocolEnvelopeError)
  })

  it('exports TransportError as a stable instanceof target', () => {
    const error = new TransportError(ErrorCode.TaskNotFound, 'gone')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(ErrorCode.TaskNotFound)
  })
})
