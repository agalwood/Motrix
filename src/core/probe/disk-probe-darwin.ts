import type { DiskProbeResult } from '@shared/types/probe'
import { defaultExec, type ExecFn } from './types'

const NETWORK_FS = new Set(['nfs', 'smbfs', 'afpfs', 'webdavfs'])

function parseField(stdout: string, field: string): string | null {
  const regex = new RegExp(`^\\s*${field}:\\s*(.+)$`, 'm')
  const match = stdout.match(regex)
  return match ? match[1].trim() : null
}

function parseFreeBytes(stdout: string): number | null {
  const raw = parseField(stdout, 'Volume Free Space')
  if (!raw) return null
  const match = raw.match(/^(\d+)/)
  return match ? Number(match[1]) : null
}

function darwinFallback(): DiskProbeResult {
  return {
    platform: 'darwin',
    mountPoint: '/',
    fsType: 'apfs',
    diskType: 'ssd',
    isInternal: true,
    isNetworkFs: false,
    freeBytes: null,
    confidence: 'low',
  }
}

export async function probeDarwin(
  downloadPath: string,
  exec: ExecFn = defaultExec
): Promise<DiskProbeResult> {
  try {
    const stdout = await exec('diskutil', ['info', downloadPath])

    const fsPersonality = parseField(stdout, 'File System Personality')
    const fsBundle = parseField(stdout, 'Type \\(Bundle\\)')
    const solidState = parseField(stdout, 'Solid State')
    const internal = parseField(stdout, 'Internal')
    const mountPoint = parseField(stdout, 'Mount Point')
    const freeBytes = parseFreeBytes(stdout)

    const fsType = (fsBundle ?? fsPersonality ?? '').toLowerCase() || null

    const isSsd = solidState?.toLowerCase() === 'yes'
    const isInternal = internal ? internal.toLowerCase() === 'yes' : null
    const isNetworkFs = fsType !== null && NETWORK_FS.has(fsType)

    let diskType: DiskProbeResult['diskType'] = 'unknown'
    if (isNetworkFs) {
      diskType = 'network'
    } else if (isInternal === false) {
      diskType = 'removable'
    } else if (isSsd) {
      diskType = 'ssd'
    } else if (solidState?.toLowerCase() === 'no') {
      diskType = 'hdd'
    }

    return {
      platform: 'darwin',
      mountPoint: mountPoint ?? '/',
      fsType,
      diskType,
      isInternal,
      isNetworkFs,
      freeBytes,
      confidence: 'high',
    }
  } catch {
    return darwinFallback()
  }
}
