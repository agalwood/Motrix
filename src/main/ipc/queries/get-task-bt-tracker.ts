import type { EngineAdapter } from '@core/engine/engine-adapter'

export interface GetTaskBtTrackerDeps {
  engineAdapter: Pick<EngineAdapter, 'getTaskBtTracker'>
}

export interface GetTaskBtTrackerPayload {
  engineGid: string
}

export function createGetTaskBtTrackerHandler(deps: GetTaskBtTrackerDeps) {
  return async ({ engineGid }: GetTaskBtTrackerPayload): Promise<string[]> => {
    return deps.engineAdapter.getTaskBtTracker(engineGid)
  }
}
