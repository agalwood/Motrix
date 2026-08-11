import { EngineState, type EngineStatusSnapshot } from '@shared/types/engine'

export interface ServerHealthSnapshot {
  ok: boolean
  status: 'ready' | 'degraded' | 'stopping'
  engine: {
    state: EngineState
    failureReason: string | null
  }
}

export function serverHealthSnapshot(options: {
  accepting: boolean
  engine: EngineStatusSnapshot
}): ServerHealthSnapshot {
  const engineReady = options.engine.state === EngineState.Ready
  return {
    ok: options.accepting && engineReady,
    status: !options.accepting
      ? 'stopping'
      : engineReady
        ? 'ready'
        : 'degraded',
    engine: {
      state: options.engine.state,
      failureReason: options.engine.failure?.reason ?? null,
    },
  }
}
