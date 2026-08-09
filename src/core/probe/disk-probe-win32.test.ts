import { describe, expect, it } from 'vitest'
import { probeWin32 } from './disk-probe-win32'

// Simulated PowerShell output: FileSystemType DriveType SizeRemaining
const NTFS_VOLUME = `NTFS       Fixed          214748364800`
const EXFAT_REMOVABLE = `exFAT      Removable      500000000000`
const NTFS_NETWORK = `NTFS       Network        0`

// Simulated Get-PhysicalDisk output: MediaType
const PHYSICAL_SSD = `SSD`
const PHYSICAL_HDD = `HDD`

type MockEntry = [cmdFragment: string, stdout: string]

function mockExecMulti(entries: MockEntry[]) {
  return async (_cmd: string, args: string[]) => {
    const fullCmd = args.join(' ')
    for (const [fragment, stdout] of entries) {
      if (fullCmd.includes(fragment)) return stdout
    }
    throw new Error(`no mock for: ${fullCmd}`)
  }
}

describe('probeWin32', () => {
  it('detects NTFS + SSD + fixed', async () => {
    const result = await probeWin32(
      'C:\\Users\\Downloads',
      mockExecMulti([
        ['Get-Volume', NTFS_VOLUME],
        ['Get-PhysicalDisk', PHYSICAL_SSD],
      ])
    )

    expect(result.platform).toBe('win32')
    expect(result.fsType).toBe('ntfs')
    expect(result.diskType).toBe('ssd')
    expect(result.isInternal).toBe(true)
    expect(result.isNetworkFs).toBe(false)
    expect(result.freeBytes).toBe(214748364800)
    expect(result.confidence).toBe('high')
  })

  it('detects NTFS + HDD', async () => {
    const result = await probeWin32(
      'D:\\Downloads',
      mockExecMulti([
        ['Get-Volume', NTFS_VOLUME],
        ['Get-PhysicalDisk', PHYSICAL_HDD],
      ])
    )

    expect(result.diskType).toBe('hdd')
  })

  it('detects exFAT + removable', async () => {
    const result = await probeWin32(
      'E:\\Downloads',
      mockExecMulti([
        ['Get-Volume', EXFAT_REMOVABLE],
        ['Get-PhysicalDisk', PHYSICAL_SSD],
      ])
    )

    expect(result.fsType).toBe('exfat')
    expect(result.diskType).toBe('removable')
    expect(result.isInternal).toBe(false)
  })

  it('detects network drive', async () => {
    const result = await probeWin32(
      'Z:\\Share',
      mockExecMulti([['Get-Volume', NTFS_NETWORK]])
    )

    expect(result.isNetworkFs).toBe(true)
    expect(result.diskType).toBe('network')
  })

  it('falls back to low-confidence result on failure', async () => {
    const fail = async () => {
      throw new Error('powershell not found')
    }
    const result = await probeWin32('C:\\Downloads', fail)

    expect(result.platform).toBe('win32')
    expect(result.fsType).toBe('ntfs')
    expect(result.confidence).toBe('low')
  })
})
