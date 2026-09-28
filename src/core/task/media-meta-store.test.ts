import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SegmentPlan } from '@core/media/segment-plan'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import writeFileAtomic from 'write-file-atomic'
import { MediaMetaStoreImpl } from './media-meta-store'

vi.mock('write-file-atomic', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof writeFileAtomic }>()
  return { default: vi.fn(original.default) }
})

const video: SegmentPlan = {
  container: 'fmp4',
  isComplete: true,
  init: { url: 'https://cdn.test/init.mp4?token=secret' },
  segments: [
    {
      index: 0,
      url: 'https://cdn.test/seg.mp4?token=secret',
      byteRange: { offset: 50, length: 100 },
    },
  ],
}
const completed = {
  index: 0,
  downloadedBytes: 20,
  totalBytes: 20,
  completed: true,
}

describe('MediaMetaStore', () => {
  let root: string
  let store: MediaMetaStoreImpl
  let metaPath: string

  beforeEach(async () => {
    vi.clearAllMocks()
    root = await fs.mkdtemp(path.join(tmpdir(), 'media-meta-'))
    store = new MediaMetaStoreImpl(path.join(root, 'media'))
    metaPath = await store.persist('task-1', {
      video,
      audio: { ...video, init: undefined },
      manifests: [
        {
          name: 'video.m3u8',
          url: 'https://cdn.test/video.m3u8',
          text: '#EXTM3U\nseg.mp4?token=secret\n',
        },
      ],
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await store.remove(metaPath)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps original manifests and display metadata together in application storage', async () => {
    expect(metaPath).toBe(path.join(root, 'media', 'task-1', 'files.json'))
    expect(await fs.readdir(path.dirname(metaPath))).toEqual([
      'files.json',
      'video.m3u8',
    ])
    expect(
      await fs.readFile(path.join(path.dirname(metaPath), 'video.m3u8'), 'utf8')
    ).toContain('token=secret')
    expect(JSON.stringify(await store.read(metaPath))).not.toContain('secret')
    expect((await store.read(metaPath))?.map((f) => f.path)).toEqual([
      'video/init-init.mp4',
      'video/000001-seg.mp4',
      'audio/000001-seg.mp4',
    ])
    if (process.platform !== 'win32') {
      expect((await fs.stat(metaPath)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.dirname(metaPath))).mode & 0o777).toBe(0o700)
    }
  })

  it('returns live progress and saves it across store recreation without caching history', async () => {
    store.update(metaPath, 'video', completed)
    store.update(metaPath, 'audio', {
      ...completed,
      totalBytes: 100,
      downloadedBytes: 50,
      completed: false,
    })
    expect((await store.read(metaPath))?.[0]).toMatchObject({
      size: 20,
      progress: 1,
    })
    await store.release(metaPath)
    const restored = new MediaMetaStoreImpl(path.join(root, 'media'))
    expect((await restored.read(metaPath))?.[2]).toMatchObject({
      size: 100,
      completedBytes: 50,
      progress: 0.5,
    })
    await fs.unlink(metaPath)
    expect(await restored.read(metaPath)).toBeNull()
  })

  it('coalesces progress writes and flushes the final checkpoint', async () => {
    vi.useFakeTimers()
    vi.mocked(writeFileAtomic).mockClear()
    for (let i = 0; i < 100; i++) store.update(metaPath, 'video', completed)
    expect(writeFileAtomic).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    store.update(metaPath, 'audio', completed)
    await store.release(metaPath)
    expect(writeFileAtomic).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('coalesces checkpoints while a slow disk write is in flight', async () => {
    vi.useFakeTimers()
    vi.mocked(writeFileAtomic).mockClear()
    const gate = Promise.withResolvers<void>()
    vi.mocked(writeFileAtomic).mockImplementationOnce(() => gate.promise)
    for (let i = 1; i <= 4; i++) {
      store.update(metaPath, 'video', {
        ...completed,
        downloadedBytes: i,
        totalBytes: i,
      })
      await vi.advanceTimersByTimeAsync(15_000)
    }
    const release = store.release(metaPath)
    gate.resolve()
    await release
    expect(writeFileAtomic).toHaveBeenCalledTimes(2)
    const restored = new MediaMetaStoreImpl(path.join(root, 'media'))
    expect((await restored.read(metaPath))?.[0]).toMatchObject({
      size: 4,
      completedBytes: 4,
    })
  })

  it('drains pending writes before deletion and ignores late callbacks', async () => {
    store.update(metaPath, 'video', completed)
    const flush = store.release(metaPath)
    await store.remove(metaPath)
    await flush
    store.update(metaPath, 'video', completed)
    await store.release(metaPath)
    await store.remove(metaPath)
    await expect(fs.stat(path.dirname(metaPath))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await fs.readdir(path.join(root, 'media'))).toEqual([])
  })

  it('does not overwrite metadata belonging to an existing task', async () => {
    await expect(store.persist('task-1', { video })).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(await store.read(metaPath)).toHaveLength(3)
  })

  it('retains the latest snapshot after a transient final checkpoint failure so release can retry', async () => {
    store.update(metaPath, 'video', completed)
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('ENOSPC'))
    await expect(store.release(metaPath)).rejects.toThrow('ENOSPC')
    expect((await store.read(metaPath))?.[0]).toMatchObject({ progress: 1 })
    await store.release(metaPath)
    const restored = new MediaMetaStoreImpl(path.join(root, 'media'))
    expect((await restored.read(metaPath))?.[0]).toMatchObject({ progress: 1 })
  })

  it('recovers orphaned metadata at startup while preserving every durable task', async () => {
    await store.release(metaPath)
    const removed = await store.persist('removed-task', { video })
    await store.release(removed)
    const partialDir = path.join(root, 'media', 'interrupted-create')
    await fs.mkdir(partialDir)
    await fs.writeFile(path.join(partialDir, 'video.m3u8'), '#EXTM3U')
    const restored = new MediaMetaStoreImpl(path.join(root, 'media'))
    await restored.pruneOrphans(['task-1'])
    expect(await fs.readdir(path.join(root, 'media'))).toEqual(['task-1'])
    expect(await restored.read(metaPath)).toHaveLength(3)
  })

  it('does not collect live metadata or follow directory links during recovery', async () => {
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep')
    await fs.symlink(
      outside,
      path.join(root, 'media', 'linked-task'),
      'junction'
    )
    await store.pruneOrphans([])
    expect(await store.read(metaPath)).toHaveLength(3)
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe(
      'keep'
    )
  })

  it('uses the same cache identity for equivalent paths during reads and deletion', async () => {
    store.update(metaPath, 'video', completed)
    const alias = `${path.join(path.dirname(metaPath), 'child')}/../files.json`
    expect((await store.read(alias))?.[0]).toMatchObject({ progress: 1 })
    await store.remove(alias)
    await store.release(metaPath)
    await expect(fs.stat(metaPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects paths outside its task directories and tolerates missing or malformed metadata', async () => {
    await expect(store.persist('../escape', { video })).rejects.toThrow(
      'Invalid'
    )
    await expect(store.remove(root)).rejects.toThrow('Invalid')
    expect(await store.read(path.join(root, 'files.json'))).toBeNull()
    await store.release(metaPath)
    await fs.writeFile(metaPath, '{invalid')
    expect(await store.read(metaPath)).toBeNull()
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        video: [{ path: 'x', size: -1 }],
        audio: [],
        manifests: [],
      })
    )
    expect(await store.read(metaPath)).toBeNull()
  })
})
