import { EngineFailureReason, EngineState } from '@shared/types/engine'
import { describe, expect, it } from 'vitest'
import { serverHealthSnapshot } from './runtime-health'

describe('serverHealthSnapshot', () => {
  it('is ready only while ingress is accepting and aria2 is ready', () => {
    expect(
      serverHealthSnapshot({
        accepting: true,
        engine: {
          state: EngineState.Ready,
          featureReport: null,
          failure: null,
          managedPid: 42,
        },
      })
    ).toEqual({
      ok: true,
      status: 'ready',
      engine: { state: EngineState.Ready, failureReason: null },
    })
  })

  it('reports engine failure and shutdown as unhealthy', () => {
    expect(
      serverHealthSnapshot({
        accepting: true,
        engine: {
          state: EngineState.Failed,
          featureReport: null,
          failure: {
            reason: EngineFailureReason.SpawnFailed,
            occurredAt: 1,
            technicalMessage: 'spawn failed',
          },
          managedPid: null,
        },
      })
    ).toMatchObject({
      ok: false,
      status: 'degraded',
      engine: { failureReason: EngineFailureReason.SpawnFailed },
    })
    expect(
      serverHealthSnapshot({
        accepting: false,
        engine: {
          state: EngineState.Ready,
          featureReport: null,
          failure: null,
          managedPid: 42,
        },
      }).status
    ).toBe('stopping')
  })
})
