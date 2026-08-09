import type { DiskProbeResult } from '@shared/types/probe'
import { defaultExec, type ExecFn } from './types'

function extractDriveLetter(downloadPath: string): string {
  return downloadPath.charAt(0).toUpperCase()
}

function win32Fallback(downloadPath: string): DiskProbeResult {
  const letter = extractDriveLetter(downloadPath)
  return {
    platform: 'win32',
    mountPoint: `${letter}:\\`,
    fsType: 'ntfs',
    diskType: 'unknown',
    isInternal: null,
    isNetworkFs: false,
    freeBytes: null,
    confidence: 'low',
  }
}

export async function probeWin32(
  downloadPath: string,
  exec: ExecFn = defaultExec
): Promise<DiskProbeResult> {
  const letter = extractDriveLetter(downloadPath)
  const mountPoint = `${letter}:\\`

  try {
    // Get-Volume output format: FileSystemType   DriveType   SizeRemaining
    const volumeOut = await exec('powershell', [
      '-Command',
      `Get-Volume -DriveLetter ${letter} | ` +
        `Select-Object -ExpandProperty FileSystemType,DriveType,SizeRemaining | ` +
        `Format-Table -HideTableHeaders | Out-String`,
    ])

    const parts = volumeOut.trim().split(/\s+/)
    const fsType = (parts[0] ?? '').toLowerCase() || null
    const driveType = (parts[1] ?? '').toLowerCase()
    const freeBytes = parts[2] ? Number(parts[2]) : null

    const isNetworkFs = driveType === 'network'

    if (isNetworkFs) {
      return {
        platform: 'win32',
        mountPoint,
        fsType,
        diskType: 'network',
        isInternal: false,
        isNetworkFs: true,
        freeBytes,
        confidence: 'high',
      }
    }

    const isRemovable = driveType === 'removable'

    if (isRemovable) {
      return {
        platform: 'win32',
        mountPoint,
        fsType,
        diskType: 'removable',
        isInternal: false,
        isNetworkFs: false,
        freeBytes,
        confidence: 'high',
      }
    }

    // Fixed drive — try Get-PhysicalDisk to determine SSD vs HDD
    let diskType: DiskProbeResult['diskType'] = 'unknown'
    let isInternal: boolean | null = true

    try {
      const diskOut = await exec('powershell', [
        '-Command',
        `Get-PhysicalDisk | Where-Object { $_.DeviceId -eq ` +
          `(Get-Partition -DriveLetter ${letter}).DiskNumber } | ` +
          `Select-Object -ExpandProperty MediaType`,
      ])

      const mediaType = diskOut.trim().toLowerCase()

      if (mediaType === 'ssd') {
        diskType = 'ssd'
        isInternal = true
      } else if (mediaType === 'hdd') {
        diskType = 'hdd'
        isInternal = true
      }
    } catch {
      // Get-PhysicalDisk failed — leave diskType as unknown
    }

    return {
      platform: 'win32',
      mountPoint,
      fsType,
      diskType,
      isInternal,
      isNetworkFs: false,
      freeBytes,
      confidence: 'high',
    }
  } catch {
    return win32Fallback(downloadPath)
  }
}
