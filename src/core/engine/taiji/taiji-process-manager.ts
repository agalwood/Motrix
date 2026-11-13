import type { EngineFeatureReport } from '@shared/types/engine'
import {
  Aria2ProcessManager,
  type Aria2ProcessManagerOptions,
} from '../aria2/aria2-process-manager'

export function taijiFeatureReport(version: string): EngineFeatureReport {
  return {
    version,
    features: ['HTTP', 'HTTPS', 'BitTorrent', 'Metalink'],
    hasSqlitePersistence: true,
    hasBtSeedUnverified: false,
    hasBtSaveMetadata: true,
    hasMoveStorage: false,
  }
}

export class TaijiProcessManager extends Aria2ProcessManager {
  protected override readonly engineName = 'taiji'
  constructor(options: Aria2ProcessManagerOptions = {}) {
    super({ ...options, parentPipe: true })
  }

  protected override parseVersionOutput(
    stdout: string
  ): EngineFeatureReport | null {
    const match =
      /^taiji (taiji\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/.exec(
        stdout.trim()
      )
    return match ? taijiFeatureReport(match[1]) : null
  }

  override spawn(
    binaryPath: string,
    args: string[],
    env?: NodeJS.ProcessEnv
  ): Promise<void> {
    return super.spawn(binaryPath, args, {
      ...(env ?? process.env),
      MOTRIX_TAIJI_STARTUP_HOLD: '1',
      MOTRIX_TAIJI_PARENT_PIPE: '1',
    })
  }
}
