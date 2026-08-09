import os from 'node:os'
import path from 'node:path'
import type {
  DiskProbeResult,
  DiskType,
  ProbeConfidence,
} from '@shared/types/probe'
import { probeDarwin } from './disk-probe-darwin'
import { probeLinux } from './disk-probe-linux'
import { probeWin32 } from './disk-probe-win32'
import { type CacheEntry, getFreeBytes } from './types'

const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX_SIZE = 8

const cache = new Map<string, CacheEntry>()

function getMountPoint(downloadPath: string): string {
  return path.parse(path.resolve(downloadPath)).root
}

const QUICK_DEFAULTS: Record<
  string,
  {
    fsType: string
    diskType: DiskType
    isInternal: boolean | null
    confidence: ProbeConfidence
  }
> = {
  darwin: {
    fsType: 'apfs',
    diskType: 'ssd',
    isInternal: true,
    confidence: 'medium',
  },
  linux: {
    fsType: 'ext4',
    diskType: 'unknown',
    isInternal: null,
    confidence: 'low',
  },
  win32: {
    fsType: 'ntfs',
    diskType: 'unknown',
    isInternal: null,
    confidence: 'low',
  },
}

export function probeQuick(downloadPath: string): DiskProbeResult {
  const platform = os.platform() as 'darwin' | 'linux' | 'win32'
  const defaults = QUICK_DEFAULTS[platform] ?? QUICK_DEFAULTS.linux

  return {
    platform,
    mountPoint: getMountPoint(downloadPath),
    fsType: defaults.fsType,
    diskType: defaults.diskType,
    isInternal: defaults.isInternal,
    isNetworkFs: false,
    freeBytes: getFreeBytes(downloadPath),
    confidence: defaults.confidence,
  }
}

export async function probePrecise(
  downloadPath: string
): Promise<DiskProbeResult> {
  // Key the cache on the resolved download path, NOT a "mount point":
  // path.parse(...).root is "/" for every path on POSIX, which collided all
  // downloads into a single cache entry (a NAS path would be served the local
  // SSD's probe result, applying the wrong tuning/isNetworkFs for 10 min).
  const cacheKey = path.resolve(downloadPath)
  const now = Date.now()

  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    cache.delete(cacheKey)
    cache.set(cacheKey, cached)
    return cached.result
  }

  const platform = os.platform()
  let result: DiskProbeResult

  if (platform === 'darwin') {
    result = await probeDarwin(downloadPath)
  } else if (platform === 'linux') {
    result = await probeLinux(downloadPath)
  } else if (platform === 'win32') {
    result = await probeWin32(downloadPath)
  } else {
    result = probeQuick(downloadPath)
  }

  if (cache.size >= CACHE_MAX_SIZE) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) cache.delete(oldestKey)
  }

  cache.set(cacheKey, {
    result,
    expiresAt: now + CACHE_TTL_MS,
  })

  return result
}

export function invalidateProbeCache(cacheKey?: string): void {
  if (cacheKey) {
    cache.delete(cacheKey)
  } else {
    cache.clear()
  }
}
