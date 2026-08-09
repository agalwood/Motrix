import { describe, expect, it } from 'vitest'
import { probeLinux } from './disk-probe-linux'

// findmnt output: FSTYPE SOURCE
const EXT4_SDA = 'ext4   /dev/sda1'
const BTRFS_NVME = 'btrfs  /dev/nvme0n1p2'
const NFS_REMOTE = 'nfs4   192.168.1.100:/share'
const EXFAT_USB = 'exfat  /dev/sdb1'

// lsblk output: ROTA TRAN
const LSBLK_SSD_SATA = '0 sata'
const LSBLK_HDD_SATA = '1 sata'
const LSBLK_SSD_NVME = '0 nvme'
const LSBLK_USB = '0 usb'

type MockEntry = [cmd: string, args: string[], stdout: string]

function mockExecMulti(entries: MockEntry[]) {
  return async (cmd: string, args: string[]) => {
    for (const [c, a, stdout] of entries) {
      if (cmd === c && args.join(' ').includes(a.join(' '))) return stdout
    }
    throw new Error(`command not found: ${cmd} ${args.join(' ')}`)
  }
}

describe('probeLinux', () => {
  it('detects ext4 + SSD via findmnt + lsblk', async () => {
    const result = await probeLinux(
      '/home/user/Downloads',
      mockExecMulti([
        ['findmnt', ['-n', '-o', 'FSTYPE,SOURCE'], EXT4_SDA],
        ['lsblk', ['-dno', 'ROTA,TRAN'], LSBLK_SSD_SATA],
      ])
    )

    expect(result.platform).toBe('linux')
    expect(result.fsType).toBe('ext4')
    expect(result.diskType).toBe('ssd')
    expect(result.isNetworkFs).toBe(false)
    expect(result.confidence).toBe('high')
  })

  it('detects btrfs + NVMe SSD', async () => {
    const result = await probeLinux(
      '/home/user/Downloads',
      mockExecMulti([
        ['findmnt', ['-n', '-o', 'FSTYPE,SOURCE'], BTRFS_NVME],
        ['lsblk', ['-dno', 'ROTA,TRAN'], LSBLK_SSD_NVME],
      ])
    )

    expect(result.fsType).toBe('btrfs')
    expect(result.diskType).toBe('ssd')
  })

  it('detects NFS as network filesystem', async () => {
    const result = await probeLinux(
      '/mnt/share',
      mockExecMulti([['findmnt', ['-n', '-o', 'FSTYPE,SOURCE'], NFS_REMOTE]])
    )

    expect(result.fsType).toBe('nfs4')
    expect(result.isNetworkFs).toBe(true)
    expect(result.diskType).toBe('network')
  })

  it('detects USB as removable', async () => {
    const result = await probeLinux(
      '/media/usb/Downloads',
      mockExecMulti([
        ['findmnt', ['-n', '-o', 'FSTYPE,SOURCE'], EXFAT_USB],
        ['lsblk', ['-dno', 'ROTA,TRAN'], LSBLK_USB],
      ])
    )

    expect(result.fsType).toBe('exfat')
    expect(result.diskType).toBe('removable')
  })

  it('detects HDD via ROTA=1', async () => {
    const result = await probeLinux(
      '/home/user/Downloads',
      mockExecMulti([
        ['findmnt', ['-n', '-o', 'FSTYPE,SOURCE'], EXT4_SDA],
        ['lsblk', ['-dno', 'ROTA,TRAN'], LSBLK_HDD_SATA],
      ])
    )

    expect(result.diskType).toBe('hdd')
  })

  it('falls back to low-confidence result on failure', async () => {
    const fail = async () => {
      throw new Error('command not found')
    }
    const result = await probeLinux('/home/user/Downloads', fail)

    expect(result.platform).toBe('linux')
    expect(result.fsType).toBe('ext4')
    expect(result.confidence).toBe('low')
  })
})
