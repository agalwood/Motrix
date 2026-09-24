import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EngineTaskOptions } from '@shared/types/engine-task-options'

interface Deps {
  engine: Pick<EngineAdapter, 'getEngineTaskOptions'>
}

export function createGetEngineTaskOptionsHandler(deps: Deps) {
  return async function getEngineTaskOptions(
    engineTaskId: string
  ): Promise<EngineTaskOptions | null> {
    return deps.engine.getEngineTaskOptions(engineTaskId)
  }
}
