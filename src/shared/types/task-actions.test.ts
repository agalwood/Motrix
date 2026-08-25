import {
  type DownloadTask,
  type TaskInstance,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import {
  canAttemptRetry,
  canInspectPieces,
  canPause,
  canRebuildTaskInputs,
  canRemove,
  canReseed,
  canResume,
  canRetry,
  canRetryMagnetMetadata,
  canStopSeeding,
  getTaskRetryKind,
  isFinalizing,
} from './task-actions'

function muxInstance(status: TaskStatus): TaskInstance {
  return {
    instanceId: 'mux:1',
    motrixId: 't1',
    gid: null,
    phase: TaskInstancePhase.FfmpegMux,
    status,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '/tmp/x',
    transitionPhase: TransitionPhase.Idle,
    uris: [],
    uriHash: null,
    payload: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

function magnetMetadataInstance(uri = 'magnet:?xt=urn:btih:abc'): TaskInstance {
  return {
    ...muxInstance(TaskStatus.Error),
    instanceId: 'meta:t1',
    gid: 'meta-gid',
    phase: TaskInstancePhase.MagnetMetadataResolution,
    uris: [uri],
  }
}

function directInstance(
  replayability: 'uri-only' | 'requires-credentials'
): TaskInstance {
  const requestModifiers =
    replayability === 'uri-only' ? [] : (['headers'] as const)
  return {
    ...muxInstance(TaskStatus.Error),
    instanceId: 'primary:t1',
    gid: 'direct-gid',
    phase: TaskInstancePhase.HttpDownload,
    uris: ['https://example.com/x'],
    payload: {
      directReplay: {
        version: 1,
        requestModifiers,
        replayability,
      },
    },
  }
}

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't1',
    name: 'sample',
    saveDir: '/tmp',
    uris: ['http://example.com/x'],
    fileCount: 1,
    filename: 'sample',
    diskPath: '/tmp/sample',
    finalPath: '/tmp/sample',
    finalName: 'sample',
    ...overrides,
  })
}

describe('canInspectPieces', () => {
  it.each([
    [TaskKind.Direct, TaskType.Http, true],
    [TaskKind.Direct, TaskType.Ftp, true],
    [TaskKind.Direct, TaskType.Metalink, true],
    [TaskKind.Bt, TaskType.Bt, true],
    [TaskKind.Bt, TaskType.Magnet, true],
    [TaskKind.Hls, TaskType.Http, false],
    [TaskKind.Mux, TaskType.Http, false],
  ] as const)('returns %s/%s -> %s', (kind, type, expected) => {
    expect(canInspectPieces(makeTask({ kind, type }))).toBe(expected)
  })
})

describe('canPause', () => {
  it.each([
    TaskStatus.Queued,
    TaskStatus.FetchingMetadata,
    TaskStatus.Downloading,
    TaskStatus.Seeding,
  ])('returns true for %s', (status) => {
    expect(canPause(makeTask({ status }))).toBe(true)
  })

  it.each([
    TaskStatus.Paused,
    TaskStatus.Completed,
    TaskStatus.Error,
    TaskStatus.Removed,
    TaskStatus.Finalizing,
  ])('returns false for %s', (status) => {
    expect(canPause(makeTask({ status }))).toBe(false)
  })

  // A coordinator-managed media task (Mux/Hls) is pausable only during the
  // segment-download phase — once ffmpeg muxing has started there are no
  // segment gids to pause, so the button must be disabled (Bug B follow-up:
  // the mux phase keeps status=Downloading, so status alone isn't enough).
  it('media task: pausable while downloading segments (mux not started)', () => {
    expect(
      canPause(
        makeTask({
          kind: TaskKind.Mux,
          status: TaskStatus.Downloading,
          instances: [muxInstance(TaskStatus.Queued)],
        })
      )
    ).toBe(true)
  })

  it('media task: NOT pausable once ffmpeg muxing has started', () => {
    expect(
      canPause(
        makeTask({
          kind: TaskKind.Hls,
          status: TaskStatus.Downloading,
          instances: [muxInstance(TaskStatus.Downloading)],
        })
      )
    ).toBe(false)
  })
})

describe('canResume', () => {
  it('returns true only for Paused', () => {
    expect(canResume(makeTask({ status: TaskStatus.Paused }))).toBe(true)
    expect(canResume(makeTask({ status: TaskStatus.Downloading }))).toBe(false)
    expect(canResume(makeTask({ status: TaskStatus.Seeding }))).toBe(false)
  })
})

describe('canStopSeeding', () => {
  it('returns true only for Seeding', () => {
    expect(canStopSeeding(makeTask({ status: TaskStatus.Seeding }))).toBe(true)
    expect(canStopSeeding(makeTask({ status: TaskStatus.Paused }))).toBe(false)
    expect(canStopSeeding(makeTask({ status: TaskStatus.Completed }))).toBe(
      false
    )
  })
})

describe('canReseed', () => {
  it('returns true for Completed BT with torrentMetaPath', () => {
    expect(
      canReseed(
        makeTask({
          status: TaskStatus.Completed,
          type: TaskType.Bt,
          torrentMetaPath: '/sidecar/x.torrent',
        })
      )
    ).toBe(true)
  })

  it('returns true for Completed Magnet with torrentMetaPath', () => {
    expect(
      canReseed(
        makeTask({
          status: TaskStatus.Completed,
          type: TaskType.Magnet,
          torrentMetaPath: '/sidecar/x.torrent',
        })
      )
    ).toBe(true)
  })

  it('returns false for Completed BT without torrentMetaPath', () => {
    expect(
      canReseed(
        makeTask({
          status: TaskStatus.Completed,
          type: TaskType.Bt,
          torrentMetaPath: null,
        })
      )
    ).toBe(false)
  })

  it('returns false for Completed HTTP', () => {
    expect(
      canReseed(
        makeTask({
          status: TaskStatus.Completed,
          type: TaskType.Http,
          torrentMetaPath: null,
        })
      )
    ).toBe(false)
  })

  it('returns false for Seeding BT (not yet completed)', () => {
    expect(
      canReseed(
        makeTask({
          status: TaskStatus.Seeding,
          type: TaskType.Bt,
          torrentMetaPath: '/sidecar/x.torrent',
        })
      )
    ).toBe(false)
  })
})

describe('canRetry', () => {
  it.each([TaskStatus.Error, TaskStatus.Removed])(
    'returns true for %s',
    (status) => {
      expect(canRetry(makeTask({ status }))).toBe(true)
    }
  )

  it.each([
    TaskStatus.Downloading,
    TaskStatus.Paused,
    TaskStatus.Completed,
    TaskStatus.Seeding,
  ])('returns false for %s', (status) => {
    expect(canRetry(makeTask({ status }))).toBe(false)
  })
})

describe('canRemove', () => {
  it('returns false only for Finalizing', () => {
    expect(canRemove(makeTask({ status: TaskStatus.Finalizing }))).toBe(false)
    for (const status of [
      TaskStatus.Queued,
      TaskStatus.Downloading,
      TaskStatus.Paused,
      TaskStatus.Completed,
      TaskStatus.Error,
      TaskStatus.Seeding,
    ]) {
      expect(canRemove(makeTask({ status }))).toBe(true)
    }
  })
})

describe('isFinalizing', () => {
  it('returns true only for Finalizing', () => {
    expect(isFinalizing(makeTask({ status: TaskStatus.Finalizing }))).toBe(true)
    expect(isFinalizing(makeTask({ status: TaskStatus.Downloading }))).toBe(
      false
    )
  })
})

describe('canRebuildTaskInputs', () => {
  it('returns false for a media kind task (Mux), regardless of uris', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Mux,
          type: TaskType.Http,
          uris: ['http://example.com/x'],
        })
      )
    ).toBe(false)
  })

  it('returns false for a media kind task (Hls), regardless of uris', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Hls,
          type: TaskType.Http,
          uris: ['http://example.com/x'],
        })
      )
    ).toBe(false)
  })

  it('returns true for BT with torrentMetaPath', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Bt,
          type: TaskType.Bt,
          torrentMetaPath: '/sidecar/x.torrent',
        })
      )
    ).toBe(true)
  })

  it('returns false for BT without torrentMetaPath', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Bt,
          type: TaskType.Bt,
          torrentMetaPath: null,
        })
      )
    ).toBe(false)
  })

  it('returns false for a pre-metadata magnet (torrentMetaPath not yet written)', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Bt,
          type: TaskType.Magnet,
          status: TaskStatus.FetchingMetadata,
          torrentMetaPath: null,
        })
      )
    ).toBe(false)
  })

  it('returns true for a resolved magnet (torrentMetaPath written)', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Bt,
          type: TaskType.Magnet,
          torrentMetaPath: '/sidecar/x.torrent',
        })
      )
    ).toBe(true)
  })

  it('returns true for public HTTP with a valid uri-only recipe', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Direct,
          type: TaskType.Http,
          uris: ['http://example.com/x'],
          instances: [directInstance('uri-only')],
        })
      )
    ).toBe(true)
  })

  it('returns false for legacy HTTP without a recipe', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Direct,
          type: TaskType.Http,
          uris: ['http://example.com/x'],
        })
      )
    ).toBe(false)
  })

  it('returns false for HTTP whose request modifiers require credentials', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Direct,
          type: TaskType.Http,
          uris: ['http://example.com/x'],
          instances: [directInstance('requires-credentials')],
        })
      )
    ).toBe(false)
  })

  it('returns false for a malformed or unknown recipe version', () => {
    const instance = directInstance('uri-only')
    instance.payload = {
      directReplay: {
        version: 2,
        requestModifiers: [],
        replayability: 'uri-only',
      },
    }
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Direct,
          type: TaskType.Http,
          instances: [instance],
        })
      )
    ).toBe(false)
  })

  it('returns false for HTTP with no uris', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Direct,
          type: TaskType.Http,
          uris: [],
        })
      )
    ).toBe(false)
  })

  it('returns false for FTP even with uris', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Direct,
          type: TaskType.Ftp,
          uris: ['ftp://example.com/x'],
        })
      )
    ).toBe(false)
  })

  it('returns false for FTP with no uris', () => {
    expect(
      canRebuildTaskInputs(
        makeTask({
          kind: TaskKind.Direct,
          type: TaskType.Ftp,
          uris: [],
        })
      )
    ).toBe(false)
  })
})

describe('canAttemptRetry', () => {
  it.each([
    {
      label: 'retryable status + rebuildable inputs (BT, Error, has sidecar)',
      status: TaskStatus.Error,
      type: TaskType.Bt,
      torrentMetaPath: '/sidecar/x.torrent',
      expected: true,
    },
    {
      label: 'retryable status + rebuildable inputs (BT, Removed, has sidecar)',
      status: TaskStatus.Removed,
      type: TaskType.Bt,
      torrentMetaPath: '/sidecar/x.torrent',
      expected: true,
    },
    {
      label: 'retryable status + non-rebuildable inputs (BT, no sidecar)',
      status: TaskStatus.Error,
      type: TaskType.Bt,
      torrentMetaPath: null,
      expected: false,
    },
    {
      label: 'retryable status + non-rebuildable inputs (HTTP)',
      status: TaskStatus.Error,
      type: TaskType.Http,
      torrentMetaPath: null,
      expected: false,
    },
    {
      label: 'non-retryable status + rebuildable inputs (BT, Downloading)',
      status: TaskStatus.Downloading,
      type: TaskType.Bt,
      torrentMetaPath: '/sidecar/x.torrent',
      expected: false,
    },
    {
      label: 'non-retryable status + non-rebuildable inputs (HTTP, Completed)',
      status: TaskStatus.Completed,
      type: TaskType.Http,
      torrentMetaPath: null,
      expected: false,
    },
  ])('$label -> $expected', ({ status, type, torrentMetaPath, expected }) => {
    const task = makeTask({
      kind: type === TaskType.Bt ? TaskKind.Bt : TaskKind.Direct,
      status,
      type,
      torrentMetaPath,
    })
    expect(canRetry(task) && canRebuildTaskInputs(task)).toBe(expected)
    expect(canAttemptRetry(task)).toBe(expected)
  })

  it('offers a distinct retry for failed magnet metadata without a sidecar', () => {
    const task = makeTask({
      kind: TaskKind.Bt,
      status: TaskStatus.Error,
      type: TaskType.Magnet,
      torrentMetaPath: null,
      instances: [magnetMetadataInstance()],
    })

    expect(canRebuildTaskInputs(task)).toBe(false)
    expect(canRetryMagnetMetadata(task)).toBe(true)
    expect(getTaskRetryKind(task)).toBe('magnet-metadata')
    expect(canAttemptRetry(task)).toBe(true)
  })

  it('offers direct-readd only for an errored uri-only direct task', () => {
    const errorTask = makeTask({
      kind: TaskKind.Direct,
      type: TaskType.Http,
      status: TaskStatus.Error,
      instances: [directInstance('uri-only')],
    })
    const removedTask = makeTask({
      ...errorTask,
      status: TaskStatus.Removed,
    })

    expect(canRebuildTaskInputs(errorTask)).toBe(true)
    expect(getTaskRetryKind(errorTask)).toBe('direct-readd')
    expect(canAttemptRetry(errorTask)).toBe(true)
    expect(canRebuildTaskInputs(removedTask)).toBe(true)
    expect(getTaskRetryKind(removedTask)).toBeNull()
    expect(canAttemptRetry(removedTask)).toBe(false)
  })

  it.each([
    'task.recovery.startup.resumeCheckpointMissing',
    'task.recovery.startup.resumeCredentialsRequired',
    'task.recovery.startup.resumePathInvalid',
  ])('does not offer a doomed direct retry for %s', (errorDetailKey) => {
    const task = makeTask({
      kind: TaskKind.Direct,
      type: TaskType.Http,
      status: TaskStatus.Error,
      errorDetailKey,
      instances: [directInstance('uri-only')],
    })

    expect(canRebuildTaskInputs(task)).toBe(true)
    expect(getTaskRetryKind(task)).toBeNull()
    expect(canAttemptRetry(task)).toBe(false)
  })

  it('does not offer metadata retry without a persisted magnet URI', () => {
    const task = makeTask({
      kind: TaskKind.Bt,
      status: TaskStatus.Error,
      type: TaskType.Magnet,
      torrentMetaPath: null,
      instances: [magnetMetadataInstance('https://example.com/not-magnet')],
    })

    expect(canRetryMagnetMetadata(task)).toBe(false)
    expect(getTaskRetryKind(task)).toBeNull()
  })
})
