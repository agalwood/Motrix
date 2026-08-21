import type { DiskProbeResult } from '@shared/types/probe'
import type {
  FileAllocation,
  TuningAlternative,
  TuningContext,
  TuningReason,
  TuningRecommendation,
} from '@shared/types/tuning'

export const MB = 1024 * 1024
export const GB = 1024 * MB

const SIZE_THRESHOLD_SMALL = 256 * MB
const SIZE_THRESHOLD_LARGE = 4 * GB
const SIZE_THRESHOLD_HUGE = 20 * GB

const MODERN_LINUX_FS = new Set(['ext4', 'xfs', 'btrfs'])
const LEGACY_FS = new Set(['ext3', 'fat32', 'vfat', 'exfat'])
const FALLOC_SUPPORTED_FS: Record<string, Set<string>> = {
  linux: MODERN_LINUX_FS,
  win32: new Set(['ntfs']),
}

type SizeTier = 'small' | 'medium' | 'large' | 'huge'

function getSizeTier(bytes: number | null): SizeTier | null {
  if (bytes === null) return null
  if (bytes < SIZE_THRESHOLD_SMALL) return 'small'
  if (bytes < SIZE_THRESHOLD_LARGE) return 'medium'
  if (bytes < SIZE_THRESHOLD_HUGE) return 'large'
  return 'huge'
}

function supportsFalloc(probe: DiskProbeResult): boolean {
  if (probe.platform === 'darwin') return false
  if (probe.isNetworkFs) return false
  const supported = FALLOC_SUPPORTED_FS[probe.platform]
  if (!supported || !probe.fsType) return false
  return supported.has(probe.fsType)
}

function downgradeConfidence(
  confidence: DiskProbeResult['confidence']
): DiskProbeResult['confidence'] {
  if (confidence === 'high') return 'medium'
  return 'low'
}

function recommendFileAllocation(
  probe: DiskProbeResult,
  sizeTier: SizeTier | null,
  context: TuningContext | null
): {
  value: FileAllocation
  reasons: TuningReason[]
  alternatives: TuningAlternative[]
} {
  const reasons: TuningReason[] = []
  const alternatives: TuningAlternative[] = []

  // Network FS — always none
  if (probe.isNetworkFs) {
    reasons.push({ code: 'network_fs_no_alloc' })
    return { value: 'none', reasons, alternatives }
  }

  // macOS
  if (probe.platform === 'darwin') {
    if (
      probe.fsType &&
      LEGACY_FS.has(probe.fsType) &&
      probe.isInternal === false
    ) {
      reasons.push({ code: 'removable_exfat_prealloc' })
      return { value: 'prealloc', reasons, alternatives }
    }

    if (
      sizeTier === 'huge' &&
      context?.protocol === 'bt' &&
      context?.isMultiFile === true
    ) {
      reasons.push({ code: 'huge_bt_prealloc_fragmentation' })
      alternatives.push({
        fileAllocation: 'none',
        condition: 'small_single_file',
        params: { sizeMB: 256 },
      })
      return { value: 'prealloc', reasons, alternatives }
    }

    if (sizeTier === 'large' || sizeTier === 'huge') {
      reasons.push({ code: 'apfs_ssd_large_cow' })
    } else {
      reasons.push({ code: 'apfs_ssd_fast_start' })
    }
    alternatives.push({
      fileAllocation: 'prealloc',
      condition: 'huge_bt_multi_file',
      params: { sizeGB: 20 },
    })
    return { value: 'none', reasons, alternatives }
  }

  // Linux
  if (probe.platform === 'linux') {
    if (probe.fsType && LEGACY_FS.has(probe.fsType)) {
      reasons.push({ code: 'legacy_fs_prealloc' })
      return { value: 'prealloc', reasons, alternatives }
    }

    if (sizeTier === 'small') {
      reasons.push({ code: 'small_file_skip_alloc' })
      return { value: 'none', reasons, alternatives }
    }

    if (supportsFalloc(probe)) {
      reasons.push({ code: 'linux_modern_fs_falloc' })
      alternatives.push({
        fileAllocation: 'none',
        condition: 'small_single_file',
        params: { sizeMB: 256 },
      })
      return { value: 'falloc', reasons, alternatives }
    }

    reasons.push({ code: 'falloc_unsupported_fallback' })
    return { value: 'prealloc', reasons, alternatives }
  }

  // Windows
  if (probe.platform === 'win32') {
    if (probe.fsType && LEGACY_FS.has(probe.fsType)) {
      reasons.push({ code: 'removable_exfat_prealloc' })
      return { value: 'prealloc', reasons, alternatives }
    }

    if (sizeTier === 'small') {
      reasons.push({ code: 'small_file_skip_alloc' })
      return { value: 'none', reasons, alternatives }
    }

    if (sizeTier === 'huge' && supportsFalloc(probe)) {
      reasons.push({ code: 'ntfs_huge_falloc' })
      alternatives.push({
        fileAllocation: 'prealloc',
        condition: 'external_drive',
      })
      return { value: 'falloc', reasons, alternatives }
    }

    reasons.push({ code: 'ntfs_prealloc_default' })
    return { value: 'prealloc', reasons, alternatives }
  }

  // Unknown platform fallback
  reasons.push({ code: 'size_unknown_conservative' })
  return { value: 'none', reasons, alternatives }
}

function recommendTuningParams(
  probe: DiskProbeResult,
  sizeTier: SizeTier | null
): { diskCache: number; split: number; minSplitSize: number } {
  const tier = sizeTier ?? 'medium'

  if (probe.diskType === 'network' || probe.isNetworkFs) {
    return { diskCache: 16 * MB, split: 2, minSplitSize: 20 * MB }
  }

  if (probe.diskType === 'hdd') {
    return { diskCache: 64 * MB, split: 8, minSplitSize: 20 * MB }
  }

  // SSD or unknown
  if (tier === 'small') {
    return { diskCache: 32 * MB, split: 8, minSplitSize: 1 * MB }
  }
  if (tier === 'medium') {
    return { diskCache: 32 * MB, split: 16, minSplitSize: 4 * MB }
  }
  if (tier === 'large') {
    return { diskCache: 64 * MB, split: 32, minSplitSize: 10 * MB }
  }
  return { diskCache: 64 * MB, split: 64, minSplitSize: 20 * MB }
}

export function recommend(
  probe: DiskProbeResult,
  context: TuningContext | null
): TuningRecommendation {
  const totalSize = context?.totalSizeBytes ?? null
  const sizeTier = getSizeTier(totalSize)

  const alloc = recommendFileAllocation(probe, sizeTier, context)
  const params = recommendTuningParams(probe, sizeTier)

  let confidence = probe.confidence
  if (totalSize === null && context !== null) {
    confidence = downgradeConfidence(confidence)
    alloc.reasons.push({ code: 'size_unknown_conservative' })
  }

  return {
    fileAllocation: alloc.value,
    diskCache: params.diskCache,
    split: params.split,
    minSplitSize: params.minSplitSize,
    reasons: alloc.reasons,
    confidence,
    alternatives: alloc.alternatives,
    detectedEnv: probe,
  }
}
