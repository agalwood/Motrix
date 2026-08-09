import type { DiskProbeResult, ProbeConfidence } from './probe'

export type FileAllocation = 'none' | 'prealloc' | 'trunc' | 'falloc'

export interface TuningReason {
  code: string
  params?: Record<string, string | number>
}

export interface TuningAlternative {
  fileAllocation: FileAllocation
  condition: string
  params?: Record<string, string | number>
}

export interface TuningRecommendation {
  fileAllocation: FileAllocation
  diskCache: number
  split: number
  minSplitSize: number
  reasons: TuningReason[]
  confidence: ProbeConfidence
  alternatives: TuningAlternative[]
  detectedEnv: DiskProbeResult
}

export interface TuningContext {
  downloadPath: string
  totalSizeBytes: number | null
  protocol: 'http' | 'ftp' | 'sftp' | 'bt' | 'magnet' | 'metalink'
  isMultiFile: boolean | null
}
