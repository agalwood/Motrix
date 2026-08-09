import { describe, expect, it } from 'vitest'
import { probeDarwin } from './disk-probe-darwin'

const APFS_SSD_OUTPUT = `
   Device Identifier:         disk3s1
   Device Node:               /dev/disk3s1
   Whole:                     No
   Part of Whole:             disk3
   Volume Name:               Macintosh HD
   Mounted:                   Yes
   Mount Point:               /
   Partition Type:            41504653-0000-11AA-AA11-00306543ECAC
   File System Personality:   APFS
   Type (Bundle):             apfs
   Name (User Visible):       APFS
   Owners:                    Enabled
   OS Can Be Installed:       Yes
   Solid State:               Yes
   Virtual:                   No
   Device / Media Name:       APPLE SSD AP0512Q
   Volume Total Space:        500000000000
   Volume Free Space:         250000000000
   Internal:                  Yes
`

const EXFAT_EXTERNAL_OUTPUT = `
   Device Identifier:         disk4s1
   Device Node:               /dev/disk4s1
   Whole:                     No
   Part of Whole:             disk4
   Volume Name:               EXTERNAL
   Mounted:                   Yes
   Mount Point:               /Volumes/EXTERNAL
   File System Personality:   ExFAT
   Type (Bundle):             exfat
   Solid State:               No
   Device / Media Name:       USB Storage
   Volume Total Space:        1000000000000
   Volume Free Space:         800000000000
   Internal:                  No
`

const HFS_HDD_OUTPUT = `
   Device Identifier:         disk2s1
   Device Node:               /dev/disk2s1
   Whole:                     No
   Part of Whole:             disk2
   Volume Name:               Data
   Mounted:                   Yes
   Mount Point:               /Volumes/Data
   File System Personality:   Journaled HFS+
   Type (Bundle):             hfs
   Solid State:               No
   Device / Media Name:       TOSHIBA DT01ACA100
   Volume Total Space:        1000000000000
   Volume Free Space:         600000000000
   Internal:                  Yes
`

function mockExec(stdout: string) {
  return async (_cmd: string, _args: string[]) => stdout
}

function mockExecFail() {
  return async () => {
    throw new Error('command not found')
  }
}

describe('probeDarwin', () => {
  it('detects APFS + SSD + internal', async () => {
    const result = await probeDarwin(
      '/Users/x/Downloads',
      mockExec(APFS_SSD_OUTPUT)
    )

    expect(result.platform).toBe('darwin')
    expect(result.fsType).toBe('apfs')
    expect(result.diskType).toBe('ssd')
    expect(result.isInternal).toBe(true)
    expect(result.isNetworkFs).toBe(false)
    expect(result.mountPoint).toBe('/')
    expect(result.freeBytes).toBe(250000000000)
    expect(result.confidence).toBe('high')
  })

  it('detects exFAT + external + HDD', async () => {
    const result = await probeDarwin(
      '/Volumes/EXTERNAL/Downloads',
      mockExec(EXFAT_EXTERNAL_OUTPUT)
    )

    expect(result.fsType).toBe('exfat')
    expect(result.diskType).toBe('removable')
    expect(result.isInternal).toBe(false)
    expect(result.mountPoint).toBe('/Volumes/EXTERNAL')
  })

  it('detects HFS+ + HDD + internal', async () => {
    const result = await probeDarwin(
      '/Volumes/Data/Downloads',
      mockExec(HFS_HDD_OUTPUT)
    )

    expect(result.fsType).toBe('hfs')
    expect(result.diskType).toBe('hdd')
    expect(result.isInternal).toBe(true)
  })

  it('detects network filesystem from fsType', async () => {
    const nfsOutput = APFS_SSD_OUTPUT.replace('APFS', 'NFS').replace(
      'apfs',
      'nfs'
    )
    const result = await probeDarwin('/mnt/share', mockExec(nfsOutput))

    expect(result.isNetworkFs).toBe(true)
    expect(result.diskType).toBe('network')
  })

  it('falls back to low-confidence result on failure', async () => {
    const result = await probeDarwin('/Users/x/Downloads', mockExecFail())

    expect(result.platform).toBe('darwin')
    expect(result.fsType).toBe('apfs')
    expect(result.diskType).toBe('ssd')
    expect(result.confidence).toBe('low')
  })
})
