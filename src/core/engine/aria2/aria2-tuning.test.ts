import type { DiskProbeResult } from '@shared/types/probe'
import type { TuningContext } from '@shared/types/tuning'
import { describe, expect, it } from 'vitest'
import { GB, MB, recommend } from './aria2-tuning'

function makeProbe(overrides: Partial<DiskProbeResult> = {}): DiskProbeResult {
  return {
    platform: 'darwin',
    mountPoint: '/',
    fsType: 'apfs',
    diskType: 'ssd',
    isInternal: true,
    isNetworkFs: false,
    freeBytes: 250 * GB,
    confidence: 'high',
    ...overrides,
  }
}

function makeContext(overrides: Partial<TuningContext> = {}): TuningContext {
  return {
    downloadPath: '/Users/x/Downloads',
    totalSizeBytes: 1 * GB,
    protocol: 'http',
    isMultiFile: false,
    ...overrides,
  }
}

describe('recommend', () => {
  describe('macOS', () => {
    it('APFS + SSD + small -> none', () => {
      const rec = recommend(
        makeProbe(),
        makeContext({ totalSizeBytes: 100 * MB })
      )
      expect(rec.fileAllocation).toBe('none')
      expect(rec.reasons.some((r) => r.code === 'apfs_ssd_fast_start')).toBe(
        true
      )
    })

    it('APFS + SSD + medium -> none', () => {
      const rec = recommend(
        makeProbe(),
        makeContext({ totalSizeBytes: 1 * GB })
      )
      expect(rec.fileAllocation).toBe('none')
    })

    it('APFS + SSD + large -> none', () => {
      const rec = recommend(
        makeProbe(),
        makeContext({ totalSizeBytes: 10 * GB })
      )
      expect(rec.fileAllocation).toBe('none')
      expect(rec.reasons.some((r) => r.code === 'apfs_ssd_large_cow')).toBe(
        true
      )
    })

    it('APFS + SSD + huge BT multi-file -> prealloc', () => {
      const rec = recommend(
        makeProbe(),
        makeContext({
          totalSizeBytes: 80 * GB,
          protocol: 'bt',
          isMultiFile: true,
        })
      )
      expect(rec.fileAllocation).toBe('prealloc')
      expect(
        rec.reasons.some((r) => r.code === 'huge_bt_prealloc_fragmentation')
      ).toBe(true)
    })

    it('exFAT + external -> prealloc', () => {
      const rec = recommend(
        makeProbe({
          fsType: 'exfat',
          diskType: 'removable',
          isInternal: false,
        }),
        makeContext()
      )
      expect(rec.fileAllocation).toBe('prealloc')
      expect(
        rec.reasons.some((r) => r.code === 'removable_exfat_prealloc')
      ).toBe(true)
    })

    it('network FS -> none', () => {
      const rec = recommend(
        makeProbe({
          fsType: 'nfs',
          diskType: 'network',
          isNetworkFs: true,
        }),
        makeContext()
      )
      expect(rec.fileAllocation).toBe('none')
      expect(rec.reasons.some((r) => r.code === 'network_fs_no_alloc')).toBe(
        true
      )
    })
  })

  describe('Linux', () => {
    it('ext4 + medium -> falloc', () => {
      const rec = recommend(
        makeProbe({ platform: 'linux', fsType: 'ext4' }),
        makeContext({ totalSizeBytes: 1 * GB })
      )
      expect(rec.fileAllocation).toBe('falloc')
      expect(rec.reasons.some((r) => r.code === 'linux_modern_fs_falloc')).toBe(
        true
      )
    })

    it('ext4 + small -> none', () => {
      const rec = recommend(
        makeProbe({ platform: 'linux', fsType: 'ext4' }),
        makeContext({ totalSizeBytes: 100 * MB })
      )
      expect(rec.fileAllocation).toBe('none')
      expect(rec.reasons.some((r) => r.code === 'small_file_skip_alloc')).toBe(
        true
      )
    })

    it('xfs + large -> falloc', () => {
      const rec = recommend(
        makeProbe({ platform: 'linux', fsType: 'xfs' }),
        makeContext({ totalSizeBytes: 10 * GB })
      )
      expect(rec.fileAllocation).toBe('falloc')
    })

    it('btrfs + huge -> falloc', () => {
      const rec = recommend(
        makeProbe({ platform: 'linux', fsType: 'btrfs' }),
        makeContext({ totalSizeBytes: 30 * GB })
      )
      expect(rec.fileAllocation).toBe('falloc')
    })

    it('ext3 -> prealloc', () => {
      const rec = recommend(
        makeProbe({ platform: 'linux', fsType: 'ext3' }),
        makeContext({ totalSizeBytes: 1 * GB })
      )
      expect(rec.fileAllocation).toBe('prealloc')
      expect(rec.reasons.some((r) => r.code === 'legacy_fs_prealloc')).toBe(
        true
      )
    })

    it('exFAT -> prealloc', () => {
      const rec = recommend(
        makeProbe({ platform: 'linux', fsType: 'exfat' }),
        makeContext()
      )
      expect(rec.fileAllocation).toBe('prealloc')
    })

    it('NFS -> none', () => {
      const rec = recommend(
        makeProbe({
          platform: 'linux',
          fsType: 'nfs4',
          diskType: 'network',
          isNetworkFs: true,
        }),
        makeContext()
      )
      expect(rec.fileAllocation).toBe('none')
    })
  })

  describe('Windows', () => {
    it('NTFS + small -> none', () => {
      const rec = recommend(
        makeProbe({ platform: 'win32', fsType: 'ntfs' }),
        makeContext({ totalSizeBytes: 100 * MB })
      )
      expect(rec.fileAllocation).toBe('none')
    })

    it('NTFS + medium -> prealloc', () => {
      const rec = recommend(
        makeProbe({ platform: 'win32', fsType: 'ntfs' }),
        makeContext({ totalSizeBytes: 1 * GB })
      )
      expect(rec.fileAllocation).toBe('prealloc')
      expect(rec.reasons.some((r) => r.code === 'ntfs_prealloc_default')).toBe(
        true
      )
    })

    it('NTFS + huge -> falloc', () => {
      const rec = recommend(
        makeProbe({ platform: 'win32', fsType: 'ntfs' }),
        makeContext({ totalSizeBytes: 30 * GB })
      )
      expect(rec.fileAllocation).toBe('falloc')
      expect(rec.reasons.some((r) => r.code === 'ntfs_huge_falloc')).toBe(true)
    })

    it('exFAT -> prealloc', () => {
      const rec = recommend(
        makeProbe({
          platform: 'win32',
          fsType: 'exfat',
          diskType: 'removable',
          isInternal: false,
        }),
        makeContext()
      )
      expect(rec.fileAllocation).toBe('prealloc')
    })

    it('network FS -> none', () => {
      const rec = recommend(
        makeProbe({
          platform: 'win32',
          fsType: 'ntfs',
          diskType: 'network',
          isNetworkFs: true,
        }),
        makeContext()
      )
      expect(rec.fileAllocation).toBe('none')
    })
  })

  describe('cross-platform', () => {
    it('size unknown -> conservative + confidence downgrade', () => {
      const rec = recommend(makeProbe(), makeContext({ totalSizeBytes: null }))
      expect(rec.confidence).not.toBe('high')
      expect(
        rec.reasons.some((r) => r.code === 'size_unknown_conservative')
      ).toBe(true)
    })

    it('null context -> global recommendation', () => {
      const probe = makeProbe()
      const rec = recommend(probe, null)
      expect(rec.fileAllocation).toBeDefined()
      expect(rec.detectedEnv).toBe(probe)
    })

    it('SSD + small -> diskCache 32MB, split 8, minSplitSize 1MB', () => {
      const rec = recommend(
        makeProbe({ diskType: 'ssd' }),
        makeContext({ totalSizeBytes: 100 * MB })
      )
      expect(rec.diskCache).toBe(32 * MB)
      expect(rec.split).toBe(8)
      expect(rec.minSplitSize).toBe(1 * MB)
    })

    it('SSD + large -> diskCache 64MB, split 32, minSplitSize 10MB', () => {
      const rec = recommend(
        makeProbe({ diskType: 'ssd' }),
        makeContext({ totalSizeBytes: 10 * GB })
      )
      expect(rec.diskCache).toBe(64 * MB)
      expect(rec.split).toBe(32)
      expect(rec.minSplitSize).toBe(10 * MB)
    })

    it('SSD + huge -> diskCache 64MB, split 64, minSplitSize 20MB', () => {
      const rec = recommend(
        makeProbe({ diskType: 'ssd' }),
        makeContext({ totalSizeBytes: 30 * GB })
      )
      expect(rec.diskCache).toBe(64 * MB)
      expect(rec.split).toBe(64)
      expect(rec.minSplitSize).toBe(20 * MB)
    })

    it('HDD -> diskCache 64MB, split 8, minSplitSize 20MB', () => {
      const rec = recommend(
        makeProbe({ diskType: 'hdd' }),
        makeContext({ totalSizeBytes: 1 * GB })
      )
      expect(rec.diskCache).toBe(64 * MB)
      expect(rec.split).toBe(8)
      expect(rec.minSplitSize).toBe(20 * MB)
    })

    it('network -> diskCache 16MB, split 2, minSplitSize 20MB', () => {
      const rec = recommend(
        makeProbe({
          diskType: 'network',
          isNetworkFs: true,
          fsType: 'nfs',
        }),
        makeContext({ totalSizeBytes: 1 * GB })
      )
      expect(rec.diskCache).toBe(16 * MB)
      expect(rec.split).toBe(2)
      expect(rec.minSplitSize).toBe(20 * MB)
    })

    it('includes alternatives when applicable', () => {
      const rec = recommend(makeProbe(), makeContext())
      expect(rec.alternatives.length).toBeGreaterThan(0)
    })
  })
})
