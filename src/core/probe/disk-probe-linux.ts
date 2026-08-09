import type { DiskProbeResult } from '@shared/types/probe'
import { defaultExec, type ExecFn, getFreeBytes } from './types'

const NETWORK_FS = new Set(['nfs', 'nfs4', 'cifs', 'smbfs', 'fuse.sshfs', '9p'])

function extractDevice(source: string): string | null {
  const match = source.match(/\/dev\/([a-z]+[0-9]*)/)
  return match ? match[1] : null
}

function linuxFallback(): DiskProbeResult {
  return {
    platform: 'linux',
    mountPoint: '/',
    fsType: 'ext4',
    diskType: 'unknown',
    isInternal: null,
    isNetworkFs: false,
    freeBytes: null,
    confidence: 'low',
  }
}

export async function probeLinux(
  downloadPath: string,
  exec: ExecFn = defaultExec
): Promise<DiskProbeResult> {
  try {
    const findmntOut = await exec('findmnt', [
      '-n',
      '-o',
      'FSTYPE,SOURCE',
      downloadPath,
    ])

    const parts = findmntOut.trim().split(/\s+/)
    const fsType = parts[0]?.toLowerCase() ?? null
    const source = parts[1] ?? ''

    const isNetworkFs = fsType !== null && NETWORK_FS.has(fsType)

    if (isNetworkFs) {
      return {
        platform: 'linux',
        mountPoint: downloadPath,
        fsType,
        diskType: 'network',
        isInternal: false,
        isNetworkFs: true,
        freeBytes: getFreeBytes(downloadPath),
        confidence: 'high',
      }
    }

    // Try lsblk for disk type info
    const device = extractDevice(source)
    let diskType: DiskProbeResult['diskType'] = 'unknown'
    let isInternal: boolean | null = null

    if (device) {
      try {
        const lsblkOut = await exec('lsblk', [
          '-dno',
          'ROTA,TRAN',
          `/dev/${device}`,
        ])
        const lsblkParts = lsblkOut.trim().split(/\s+/)
        const rota = lsblkParts[0]
        const tran = lsblkParts[1]?.toLowerCase()

        if (tran === 'usb') {
          diskType = 'removable'
          isInternal = false
        } else if (rota === '0') {
          diskType = 'ssd'
          isInternal = true
        } else if (rota === '1') {
          diskType = 'hdd'
          isInternal = true
        }
      } catch {
        // lsblk failed — leave as unknown
      }
    }

    return {
      platform: 'linux',
      mountPoint: downloadPath,
      fsType,
      diskType,
      isInternal,
      isNetworkFs: false,
      freeBytes: getFreeBytes(downloadPath),
      confidence: 'high',
    }
  } catch {
    return linuxFallback()
  }
}
