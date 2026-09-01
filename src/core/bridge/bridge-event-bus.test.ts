import { describe, expect, it } from 'vitest'
import { BridgeEventBus } from './bridge-event-bus'

describe('BridgeEventBus', () => {
  it('emits PairRequested with serializable payload', () => {
    const bus = new BridgeEventBus()
    const received: unknown[] = []
    bus.on('PairRequested', (p) => received.push(p))
    bus.emitPairRequested({
      kind: 'extension',
      pairingNonce: 'nonce-1',
      extensionId: 'ext-1',
      identity: 'official',
      code: '1234-5678',
      browser: 'chromium',
    })
    expect(received).toHaveLength(1)
  })

  it('emits Paired and Revoked', () => {
    const bus = new BridgeEventBus()
    const r: unknown[] = []
    bus.on('Paired', (p) => r.push({ kind: 'paired', p }))
    bus.on('Revoked', (p) => r.push({ kind: 'revoked', p }))
    bus.emitPaired({
      identity: { kind: 'extension', browser: 'chromium', extensionId: 'a' },
    })
    bus.emitRevoked({
      identity: { kind: 'extension', browser: 'chromium', extensionId: 'a' },
    })
    expect(r).toHaveLength(2)
  })

  it.each(['allowed', 'denied', 'aborted'] as const)(
    'emits PairRequestSettled with the %s outcome',
    (outcome) => {
      const bus = new BridgeEventBus()
      const received: unknown[] = []
      bus.on('PairRequestSettled', (p) => received.push(p))
      bus.emitPairRequestSettled({
        key: 'chromium:ext-1:nonce-1',
        outcome,
      })
      expect(received).toEqual([{ key: 'chromium:ext-1:nonce-1', outcome }])
    }
  )

  it('emits PairRequestExpired with key', () => {
    const bus = new BridgeEventBus()
    const received: unknown[] = []
    bus.on('PairRequestExpired', (p) => received.push(p))
    bus.emitPairRequestExpired({ key: 'chromium:ext-1:nonce-1' })
    expect(received).toEqual([{ key: 'chromium:ext-1:nonce-1' }])
  })
})

describe('TaskProgress / TaskCompleted / TaskError', () => {
  it('emits TaskProgress with sessionKey routing envelope', () => {
    const bus = new BridgeEventBus()
    const seen: unknown[] = []
    bus.on('TaskProgress', (e) => seen.push(e))
    bus.emitTaskProgress({
      sessionKey: 'chromium:e',
      params: {
        taskId: 't1',
        bytesDone: 100,
        bytesTotal: 1000,
        speedBps: 50,
        etaSec: 18,
        phase: 'downloading',
      },
    })
    expect(seen).toHaveLength(1)
  })

  it('emits TaskCompleted and TaskError', () => {
    const bus = new BridgeEventBus()
    const completed: unknown[] = []
    const errors: unknown[] = []
    bus.on('TaskCompleted', (e) => completed.push(e))
    bus.on('TaskError', (e) => errors.push(e))
    bus.emitTaskCompleted({
      sessionKey: 'chromium:e',
      params: {
        taskId: 't1',
        filePath: '/tmp/x.mp4',
        durationMs: 1234,
      },
    })
    bus.emitTaskError({
      sessionKey: 'chromium:e',
      params: {
        taskId: 't1',
        code: 'not-found',
        message: 'Resource not found',
      },
    })
    expect(completed).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })
})
