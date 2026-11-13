import type { EngineConnectionSnapshot } from '@shared/schemas/engine-connection'
import type {
  EngineFeatureReport,
  EngineProcessInfo,
} from '@shared/types/engine'
import type { EngineSettings } from '@shared/types/settings'
import type { DownloadProxyOptions } from '../proxy/serializers'
import type { DirectResourceMetadataProfile } from './engine-adapter'

export interface EngineRuntimeControl {
  applySettings(
    settings: EngineSettings,
    previous?: EngineSettings
  ): Promise<void>
  setSpeedLimits(limits: { download: number; upload: number }): Promise<void>
  setDefaultSaveDirectory(directory: string): Promise<void>
  setDownloadProxy(proxy: DownloadProxyOptions | null): Promise<void>
  connect(): Promise<void>
  setFeatureReport(report: EngineFeatureReport): void
  inspectDirectResourceMetadataProfile(): Promise<DirectResourceMetadataProfile | null>
  setDirectResourceMetadataProfile(
    profile: DirectResourceMetadataProfile | null
  ): void
}

export interface EngineConnection {
  connect(port: number): Promise<void>
  disconnect(): void
  setSecret(secret: string): void
  healthCheck(): Promise<void>
  getConnectionStatus(): EngineConnectionSnapshot
}

export interface ExpectedEngineProcess {
  binaryPath: string
  args: string[]
}
export interface EngineProcess {
  onExit: ((code: number | null, signal: string | null) => void) | null
  probe(binaryPath: string): Promise<EngineFeatureReport>
  spawn(
    binaryPath: string,
    args: string[],
    env?: NodeJS.ProcessEnv
  ): Promise<void>
  isRunning(): boolean
  getPid(): number | null
  getRecentStderr(): string
  gracefulStop(timeout?: number): Promise<void>
  inspectPort(
    port: number,
    expected: ExpectedEngineProcess
  ): Promise<EngineProcessInfo | null>
  forceTerminateVerified(
    pid: number,
    port: number,
    expected: ExpectedEngineProcess
  ): Promise<void>
}

export interface EngineConfiguration {
  prepare(): Promise<void>
  buildStartupArgs(
    settings: EngineSettings,
    limits: { download: number; upload: number },
    directory: string
  ): string[]
  migrateSession?(
    binaryPath: string,
    settings: EngineSettings,
    directory: string,
    signal?: AbortSignal
  ): Promise<void>
}
export interface EngineTrust {
  prepareEnvironment(): Promise<NodeJS.ProcessEnv | undefined>
}
