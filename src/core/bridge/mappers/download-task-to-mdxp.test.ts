import { MdxpTaskSchema } from '@motrix/mdxp'
import { DownloadErrorCode } from '@shared/errors'
import {
  makeDefaultBtExtension,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import { toMdxpTask, toMdxpTaskStatus } from './download-task-to-mdxp'

/**
 * Round-trips a mapper output through the currently INSTALLED (published)
 * `@motrix/mdxp` schema — not just the local `MdxpTask` type — so a wire-shape
 * drift between this mapper and the published package is caught here rather
 * than at runtime against a real MDXP client.
 */
function expectValidMdxpTask(dto: unknown) {
  const result = MdxpTaskSchema.safeParse(dto)
  expect(result.success).toBe(true)
}

describe('toMdxpTaskStatus', () => {
  it('maps queued → queued', () => {
    expect(toMdxpTaskStatus(TaskStatus.Queued)).toBe('queued')
  })

  it('maps fetching_metadata → fetching_metadata', () => {
    expect(toMdxpTaskStatus(TaskStatus.FetchingMetadata)).toBe(
      'fetching_metadata'
    )
  })

  it('collapses metadata_ready → queued', () => {
    expect(toMdxpTaskStatus(TaskStatus.MetadataReady)).toBe('queued')
  })

  it('maps downloading → downloading', () => {
    expect(toMdxpTaskStatus(TaskStatus.Downloading)).toBe('downloading')
  })

  it('maps finalizing → finalizing', () => {
    expect(toMdxpTaskStatus(TaskStatus.Finalizing)).toBe('finalizing')
  })

  it('maps seeding → seeding', () => {
    expect(toMdxpTaskStatus(TaskStatus.Seeding)).toBe('seeding')
  })

  it('maps paused → paused', () => {
    expect(toMdxpTaskStatus(TaskStatus.Paused)).toBe('paused')
  })

  it('maps completed → completed', () => {
    expect(toMdxpTaskStatus(TaskStatus.Completed)).toBe('completed')
  })

  it('maps error → error', () => {
    expect(toMdxpTaskStatus(TaskStatus.Error)).toBe('error')
  })

  it('throws for removed (callers must filter first)', () => {
    expect(() => toMdxpTaskStatus(TaskStatus.Removed)).toThrow()
  })
})

describe('toMdxpTask', () => {
  it('projects the public identity fields', () => {
    const task = makeDownloadTask({
      id: 'public-1',
      engineTaskId: 'gid-xyz',
      name: 'ubuntu.iso',
      type: TaskType.Http,
      status: TaskStatus.Downloading,
      progress: 0.42,
      saveDir: '/downloads',
      createdAt: 1000,
      finishedAt: null,
    })
    const dto = toMdxpTask(task)
    expect(dto.id).toBe('public-1')
    expect(dto.type).toBe('http')
    expect(dto.name).toBe('ubuntu.iso')
    expect(dto.status).toBe('downloading')
    // progress is identity — domain is already [0,1]
    expect(dto.progress).toBe(0.42)
    expect(dto.saveDir).toBe('/downloads')
    expect(dto.createdAt).toBe(1000)
    expect(dto.finishedAt).toBeNull()
    expectValidMdxpTask(dto)
  })

  it('never leaks the engine gid', () => {
    const task = makeDownloadTask({ id: 'pub', engineTaskId: 'gid-secret' })
    const dto = toMdxpTask(task)
    expect(JSON.stringify(dto)).not.toContain('gid-secret')
  })

  it('maps byte/speed fields', () => {
    const task = makeDownloadTask({
      downloadedBytes: 500,
      totalBytes: 1000,
      downloadSpeed: 250,
    })
    const dto = toMdxpTask(task)
    expect(dto.bytesDone).toBe(500)
    expect(dto.bytesTotal).toBe(1000)
    expect(dto.speedBps).toBe(250)
  })

  it('represents unknown total size as null (totalBytes === 0)', () => {
    const dto = toMdxpTask(makeDownloadTask({ totalBytes: 0 }))
    expect(dto.bytesTotal).toBeNull()
  })

  it('represents unknown eta as null (etaSeconds === 0)', () => {
    const dto = toMdxpTask(makeDownloadTask({ etaSeconds: 0 }))
    expect(dto.etaSec).toBeNull()
  })

  it('surfaces a positive eta', () => {
    const dto = toMdxpTask(makeDownloadTask({ etaSeconds: 30 }))
    expect(dto.etaSec).toBe(30)
  })

  it('exposes error message only when status is error', () => {
    const failed = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Error,
        errorMessage: 'connection refused',
      })
    )
    expect(failed.error).toBe('connection refused')
    expectValidMdxpTask(failed)

    // A non-error task with a stale errorMessage must not leak it
    const downloading = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Downloading,
        errorMessage: 'old failure',
      })
    )
    expect(downloading.error).toBeNull()
    expectValidMdxpTask(downloading)
  })

  it('falls back to errorDetailKey when errorMessage is null (recovery failures)', () => {
    const dto = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Error,
        errorMessage: null,
        errorDetailKey: 'task.recovery.startup.reAddFailed',
      })
    )
    expect(dto.error).toBe('task.recovery.startup.reAddFailed')
    expectValidMdxpTask(dto)
  })

  it('prefers the raw errorMessage over errorDetailKey for plain engine failures', () => {
    const dto = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Error,
        errorMessage: 'HTTP 403',
        errorDetailKey: 'task.error.httpForbidden',
      })
    )
    expect(dto.error).toBe('HTTP 403')
    expectValidMdxpTask(dto)
  })

  it('maps null when neither errorMessage nor errorDetailKey is set on error', () => {
    const dto = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Error,
        errorMessage: null,
        errorDetailKey: null,
      })
    )
    expect(dto.error).toBeNull()
    expectValidMdxpTask(dto)
  })

  it('does not leak errorDetailKey for a non-error status', () => {
    const dto = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Downloading,
        errorMessage: null,
        errorDetailKey: 'task.recovery.startup.reAddFailed',
      })
    )
    expect(dto.error).toBeNull()
    expectValidMdxpTask(dto)
  })

  it('exposes errorCode for a known code when status is error', () => {
    const dto = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Error,
        errorCode: DownloadErrorCode.DiskFull,
      })
    )
    expect(dto.errorCode).toBe('DL_DISK_FULL')
    expectValidMdxpTask(dto)
  })

  it('passes through an unknown future errorCode verbatim (open set)', () => {
    const dto = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Error,
        errorCode: 'DL_FUTURE_VALUE' as DownloadErrorCode,
      })
    )
    expect(dto.errorCode).toBe('DL_FUTURE_VALUE')
    expectValidMdxpTask(dto)
  })

  it('maps errorCode to null when the error task has no code', () => {
    const dto = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Error,
        errorCode: null,
      })
    )
    expect(dto.errorCode).toBeNull()
    expectValidMdxpTask(dto)
  })

  it('does not leak a stale errorCode for a non-error status', () => {
    const dto = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Downloading,
        errorCode: DownloadErrorCode.DiskFull,
      })
    )
    expect(dto.errorCode).toBeNull()
    expectValidMdxpTask(dto)
  })

  it('exposes finalPath only when completed', () => {
    const completed = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Completed,
        finalPath: '/downloads/ubuntu.iso',
        finishedAt: 2000,
      })
    )
    expect(completed.finalPath).toBe('/downloads/ubuntu.iso')
    expect(completed.finishedAt).toBe(2000)
    expectValidMdxpTask(completed)

    // An in-progress task must not leak its eventual finalPath
    const downloading = toMdxpTask(
      makeDownloadTask({
        status: TaskStatus.Downloading,
        finalPath: '/downloads/ubuntu.iso',
      })
    )
    expect(downloading.finalPath).toBeNull()
    expectValidMdxpTask(downloading)
  })

  it('maps infoHash null → undefined (omitted)', () => {
    const dto = toMdxpTask(makeDownloadTask({ infoHash: null }))
    expect(dto.infoHash).toBeUndefined()
  })

  it('passes through a present infoHash', () => {
    const dto = toMdxpTask(makeDownloadTask({ infoHash: 'abc123' }))
    expect(dto.infoHash).toBe('abc123')
  })

  it('projects only the 4-field bt subset when bt is present', () => {
    const task = makeDownloadTask({
      type: TaskType.Bt,
      status: TaskStatus.Seeding,
      bt: makeDefaultBtExtension({
        peers: 5,
        seeds: 3,
        ratio: 1.5,
        trackers: ['udp://tracker.example:1337'],
        // internal fields that must NOT cross the boundary:
        peersInSwarm: 99,
        magnetUri: 'magnet:?xt=secret',
        isPrivate: true,
      }),
    })
    const dto = toMdxpTask(task)
    expect(dto.bt).toEqual({
      peers: 5,
      seeds: 3,
      ratio: 1.5,
      trackers: ['udp://tracker.example:1337'],
    })
    expectValidMdxpTask(dto)
  })

  it('omits bt for non-torrent tasks', () => {
    const dto = toMdxpTask(makeDownloadTask({ type: TaskType.Http }))
    expect(dto.bt).toBeUndefined()
    expectValidMdxpTask(dto)
  })
})
