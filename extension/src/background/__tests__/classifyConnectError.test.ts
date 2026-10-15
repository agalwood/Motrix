import { ErrorCodes } from '@motrix/mdxp'
import { describe, expect, it } from 'vitest'
import { classifyConnectError } from '@/background/ConnectionManager'
import { NativeBootstrapError } from '@/background/NativeBootstrap'

describe('classifyConnectError', () => {
  it('treats an unavailable platform Native Messaging API as expected', () => {
    const e = new NativeBootstrapError(
      'Native Messaging is unavailable on this browser',
      'unsupported'
    )
    expect(classifyConnectError(e).level).toBe('info')
  })

  it('treats motrix-not-running as info — the desktop app simply is not open', () => {
    const e = new NativeBootstrapError(
      'motrix-not-running',
      'host-error:motrix-not-running'
    )
    expect(classifyConnectError(e)).toEqual({
      level: 'info',
      reason: 'Motrix is not running',
    })
  })

  it('treats a "host not found" disconnect as info (native host not installed)', () => {
    const e = new NativeBootstrapError(
      'NM host disconnected: Specified native messaging host not found',
      'disconnect'
    )
    expect(classifyConnectError(e).level).toBe('info')
  })

  it('treats a bare disconnect / timeout as warn (transient)', () => {
    expect(
      classifyConnectError(
        new NativeBootstrapError('NM bootstrap timeout', 'timeout')
      ).level
    ).toBe('warn')
    expect(
      classifyConnectError(
        new NativeBootstrapError('NM host disconnected', 'disconnect')
      ).level
    ).toBe('warn')
  })

  it('treats pairing revoked / denied as warn (user-driven, handled separately)', () => {
    expect(classifyConnectError({ code: ErrorCodes.PairRevoked }).level).toBe(
      'warn'
    )
    expect(
      classifyConnectError({ code: ErrorCodes.PermissionDenied }).level
    ).toBe('warn')
  })

  it('treats malformed / unexpected host-error as error (real protocol fault)', () => {
    expect(
      classifyConnectError(
        new NativeBootstrapError('malformed NM response', 'malformed')
      ).level
    ).toBe('error')
    expect(
      classifyConnectError(
        new NativeBootstrapError('boom', 'host-error:something-unexpected')
      ).level
    ).toBe('error')
  })

  it('treats a non-bootstrap error as error', () => {
    expect(classifyConnectError(new Error('socket exploded')).level).toBe(
      'error'
    )
  })
})
