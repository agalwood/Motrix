import {
  hasEngineTaskDelta,
  mergeEngineTask,
} from '@core/task/merge-engine-task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskFileMetadata } from './task-file-metadata'
import { TASK_STATUS_FIELDS } from './task-status-fields'
import { translateRawToTask } from './translate'
import type { Aria2RawFile, Aria2RawStatus } from './types'

const file: Aria2RawFile = {
  index: '1',
  path: '/downloads/video.mp4.motrix',
  length: '1000',
  completedLength: '400',
  selected: 'true',
  uris: [{ uri: 'https://example.test/video.mp4', status: 'used' }],
}
const raw: Aria2RawStatus = {
  gid: 'a000000000000001',
  status: 'active',
  totalLength: '1000',
  completedLength: '400',
  uploadLength: '300',
  downloadSpeed: '10',
  uploadSpeed: '20',
  connections: '3',
  numSeeders: '7',
  seeder: 'false',
  pieceLength: '100',
  numPieces: '10',
  dir: '/downloads',
  files: [file],
  followedBy: ['next'],
  following: 'previous',
  belongsTo: 'parent',
}
const bt = {
  mode: 'multi' as const,
  info: { name: 'bundle' },
  announceList: [['https://tracker.test']],
  comment: 'comment',
}
function compact(status: Aria2RawStatus) {
  return Object.fromEntries(
    TASK_STATUS_FIELDS.filter((key) => key in status).map((key) => [
      key,
      status[key],
    ])
  ) as Omit<Aria2RawStatus, 'files'>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
})
afterEach(() => vi.useRealTimers())

describe('file metadata stream', () => {
  it.each([
    ['HTTP with a server-provided filename', raw],
    [
      'FTP',
      {
        ...raw,
        files: [
          {
            ...file,
            uris: [{ uri: 'ftp://host/file', status: 'used' as const }],
          },
        ],
      },
    ],
    [
      'magnet metadata',
      {
        ...raw,
        totalLength: '0',
        bittorrent: bt,
        files: [
          {
            ...file,
            uris: [{ uri: 'magnet:?xt=urn:btih:abc', status: 'used' as const }],
          },
        ],
      },
    ],
    [
      'BT download',
      {
        ...raw,
        bittorrent: bt,
        infoHash: 'a'.repeat(40),
        files: [
          { ...file, uris: [] },
          { ...file, index: '2', selected: 'false', uris: [] },
        ],
      },
    ],
    [
      'BT seeding',
      {
        ...raw,
        bittorrent: bt,
        seeder: 'true',
        completedLength: '1000',
        files: [{ ...file, uris: [] }],
      },
    ],
    ['paused', { ...raw, status: 'paused' as const }],
    ['completed', { ...raw, status: 'complete' as const }],
    [
      'error diagnosis',
      {
        ...raw,
        status: 'error' as const,
        errorCode: '9',
        errorMessage: 'No space left on device',
      },
    ],
  ])('preserves full-snapshot behavior for %s', async (_label, full) => {
    const rpc = { getFiles: vi.fn().mockResolvedValue(full.files) }
    const metadata = new TaskFileMetadata(rpc)
    const polled = await metadata.hydrate(compact(full))
    expect(translateRawToTask(polled!)).toEqual(translateRawToTask(full))
    expect(polled?.following).toBe(full.following)
    expect(polled?.followedBy).toEqual(full.followedBy)
    expect(polled?.belongsTo).toBe(full.belongsTo)
    expect(polled).not.toHaveProperty('files')
  })

  it('updates dynamic metrics without rereading or rebuilding file selection', async () => {
    const rpc = {
      getFiles: vi.fn().mockResolvedValue(
        Array.from({ length: 7458 }, (_, i) => ({
          ...file,
          index: String(i + 1),
        }))
      ),
    }
    const metadata = new TaskFileMetadata(rpc)
    const first = await metadata.hydrate(compact(raw))
    const next = await metadata.hydrate({
      ...compact(raw),
      completedLength: '900',
      uploadLength: '500',
      seeder: 'true',
    })
    expect(rpc.getFiles).toHaveBeenCalledTimes(1)
    expect(next?.fileMetadata).toBe(first?.fileMetadata)
    expect(translateRawToTask(next!).downloadedBytes).toBe(900)
    expect(translateRawToTask(next!).uploadedBytes).toBe(500)
    expect(translateRawToTask(next!).fileCount).toBe(7458)
  })

  it('coalesces reads and discards an old response after selection invalidation', async () => {
    let resolveOld!: (files: Aria2RawFile[]) => void
    const rpc = {
      getFiles: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOld = resolve
            })
        )
        .mockResolvedValue([{ ...file, selected: 'false' }]),
    }
    const metadata = new TaskFileMetadata(rpc)
    const first = metadata.hydrate(compact(raw))
    const second = metadata.hydrate(compact(raw))
    expect(rpc.getFiles).toHaveBeenCalledTimes(1)
    metadata.invalidate(raw.gid)
    const current = await metadata.hydrate(compact(raw))
    resolveOld([file])
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(current?.fileMetadata.selectedFiles).toEqual([])
    expect((await metadata.hydrate(compact(raw)))?.fileMetadata).toBe(
      current?.fileMetadata
    )
  })

  it('retries metadata arrival and a failed read without adopting an incomplete identity', async () => {
    const rpc = {
      getFiles: vi
        .fn()
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockResolvedValueOnce([])
        .mockResolvedValue([file]),
    }
    const metadata = new TaskFileMetadata(rpc)
    expect(await metadata.hydrate(compact(raw))).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect((await metadata.hydrate(compact(raw)))?.fileMetadata.fileCount).toBe(
      0
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect((await metadata.hydrate(compact(raw)))?.fileMetadata.fileCount).toBe(
      1
    )
  })

  it('refreshes on metadata resolution and preserves terminal errors if files were evicted', async () => {
    const rpc = {
      getFiles: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([file])
        .mockRejectedValue(new Error('GID is not found')),
    }
    const metadata = new TaskFileMetadata(rpc)
    await metadata.hydrate({ ...compact(raw), totalLength: '0' })
    const ready = await metadata.hydrate(compact(raw))
    const failed = await metadata.hydrate({
      ...compact(raw),
      status: 'error',
      errorCode: '9',
      errorMessage: 'disk full',
    })
    expect(rpc.getFiles).toHaveBeenCalledTimes(3)
    expect(failed?.fileMetadata).toBe(ready?.fileMetadata)
    expect(translateRawToTask(failed!).errorMessage).toBe('disk full')
  })

  it('reconciles external selection edits and publishes metadata-only changes', async () => {
    const full = { ...raw, bittorrent: bt }
    const rpc = {
      getFiles: vi
        .fn()
        .mockResolvedValueOnce([file])
        .mockResolvedValue([{ ...file, selected: 'false' }]),
    }
    const metadata = new TaskFileMetadata(rpc)
    const before = translateRawToTask((await metadata.hydrate(compact(full)))!)
    await vi.advanceTimersByTimeAsync(60_000)
    const after = mergeEngineTask(
      before,
      translateRawToTask((await metadata.hydrate(compact(full)))!)
    )
    expect(after.bt?.selectedFiles).toEqual([])
    expect(hasEngineTaskDelta(before, after)).toBe(true)
  })

  it('clears metadata on reconnect and prunes tasks no longer in the live snapshot', async () => {
    const rpc = { getFiles: vi.fn().mockResolvedValue([file]) }
    const metadata = new TaskFileMetadata(rpc)
    await metadata.hydrate(compact(raw))
    metadata.invalidate()
    await metadata.hydrate(compact(raw))
    await vi.advanceTimersByTimeAsync(60_001)
    metadata.retain(new Set())
    await metadata.hydrate(compact(raw))
    expect(rpc.getFiles).toHaveBeenCalledTimes(3)
  })

  it('keeps terminal identity across live-list disappearance even before the notification arrives', async () => {
    const rpc = {
      getFiles: vi
        .fn()
        .mockResolvedValueOnce([file])
        .mockRejectedValue(new Error('GID is not found')),
    }
    const metadata = new TaskFileMetadata(rpc)
    await metadata.hydrate(compact(raw))
    metadata.retain(new Set())
    const terminal = await metadata.hydrate({
      ...compact(raw),
      status: 'complete',
    })
    expect(translateRawToTask(terminal!).name).toBe('video.mp4')
    expect(translateRawToTask(terminal!).fileCount).toBe(1)
  })

  it('does not reuse file identity for a different torrent under the same GID', async () => {
    const rpc = {
      getFiles: vi
        .fn()
        .mockResolvedValueOnce([file])
        .mockRejectedValue(new Error('unavailable')),
    }
    const metadata = new TaskFileMetadata(rpc)
    await metadata.hydrate({ ...compact(raw), infoHash: 'a'.repeat(40) })
    expect(
      await metadata.hydrate({ ...compact(raw), infoHash: 'b'.repeat(40) })
    ).toBeNull()
  })

  it('does not discard a terminal notification when a concurrent live poll omits its GID', async () => {
    let resolveFiles!: (files: Aria2RawFile[]) => void
    const rpc = {
      getFiles: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFiles = resolve
          })
      ),
    }
    const metadata = new TaskFileMetadata(rpc)
    const terminal = metadata.hydrate({ ...compact(raw), status: 'complete' })
    metadata.retain(new Set())
    resolveFiles([file])
    expect((await terminal)?.status).toBe('complete')
  })
})
