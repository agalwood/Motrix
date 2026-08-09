export type DiskType = 'ssd' | 'hdd' | 'removable' | 'network' | 'unknown'
export type ProbeConfidence = 'high' | 'medium' | 'low'

export interface DiskProbeResult {
  platform: 'darwin' | 'linux' | 'win32'
  mountPoint: string
  fsType: string | null
  diskType: DiskType
  isInternal: boolean | null
  isNetworkFs: boolean
  freeBytes: number | null
  confidence: ProbeConfidence
}
