import type { EngineSupervisor } from '@core/engine/engine-supervisor'
import { AppError, ErrorCode } from '@shared/errors'
import { EngineState } from '@shared/types/engine'

/** Server recovery requires RPC; start() can resolve in the Failed state. */
export async function startServerEngine(
  supervisor: Pick<EngineSupervisor, 'start' | 'getState' | 'getLastError'>,
  binaryPath: string
): Promise<void> {
  await supervisor.start(binaryPath)
  if (supervisor.getState() !== EngineState.Ready) {
    throw new AppError(
      ErrorCode.EngineStartFailed,
      supervisor.getLastError() ?? ErrorCode.EngineStartFailed
    )
  }
}
