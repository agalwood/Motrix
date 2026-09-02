import type { PluginTaskSnapshotV1 } from '@shared/schemas/plugin-hooks'
import type {
  AfterCompleteContextDTO,
  BeforeCreateBtContextDTO,
  BeforeCreateHttpContextDTO,
  BeforeFinalizeContextDTO,
  OnErrorContextDTO,
} from '@shared/types/plugin-hooks'
import type { DownloadTask } from '@shared/types/task'
import {
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { describe, expect, it, vi } from 'vitest'
import type { PluginMetadata, ReadonlyPluginMetadata } from './hook-context'
import {
  makeAfterComplete,
  makeBeforeCreateBt,
  makeBeforeCreateHttp,
  makeBeforeFinalize,
  makeOnError,
} from './hook-context'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAbortController() {
  return new AbortController()
}

function makeMutableMeta(): PluginMetadata {
  const store = new Map<string, unknown>()
  return {
    get: (key) => store.get(key) as never,
    has: (key) => store.has(key),
    getAll: () => Object.fromEntries(store) as never,
    keys: () => [...store.keys()],
    set: (key, value) => {
      store.set(key, value)
    },
    delete: (key) => {
      store.delete(key)
    },
  }
}

function makeReadonlyMeta(): ReadonlyPluginMetadata {
  return {
    get: (_key) => undefined,
    has: (_key) => false,
    getAll: () => ({}),
    keys: () => [],
  }
}

const BASE_HTTP_DTO: BeforeCreateHttpContextDTO = {
  schemaVersion: 1,
  invocationId: 'invocation-http-1',
  taskId: 'task-1',
  type: 'http',
  sourceUrl: 'https://example.com/file.zip',
  createdBy: 'user',
  requestedAt: 1_000_000,
  uris: ['https://example.com/file.zip'],
  saveDir: '/tmp/downloads',
  headers: [],
}

const BASE_BT_DTO: BeforeCreateBtContextDTO = {
  schemaVersion: 1,
  invocationId: 'invocation-bt-1',
  taskId: 'task-1',
  type: 'bt',
  sourceUrl: 'magnet:?xt=urn:btih:abc123',
  createdBy: 'user',
  requestedAt: 1_000_000,
  trackers: ['udp://tracker.example.com:1337'],
}

const BASE_TASK: DownloadTask = {
  id: 'task-1',
  engineTaskId: 'gid-1',
  name: 'file.zip',
  kind: TaskKind.Direct,
  instances: [],
  type: TaskType.Http,
  status: TaskStatus.Completed,
  progress: 1,
  totalBytes: 1000,
  downloadedBytes: 1000,
  downloadSpeed: 0,
  uploadSpeed: 0,
  etaSeconds: 0,
  saveDir: '/tmp/downloads',
  createdAt: 1_000_000,
  updatedAt: 1_000_001,
  finishedAt: 1_000_002,
  errorMessage: null,
  uris: ['https://example.com/file.zip'],
  uploadedBytes: 0,
  uploadedBytesBaseline: 0,
  fileCount: 1,
  connections: 0,
  pieceLength: 1000,
  infoHash: null,
  errorCode: null,
  errorDetailKey: null,
  errorDetailParams: null,
  diagnosisRevision: 0,
  metadataProgress: 1,
  priority: 0,
  category: null,
  dlLimit: 0,
  ulLimit: 0,
  filename: 'file.zip',
  sizeWhenDone: 1000,
  diskPath: '/tmp/downloads/file.zip.aria2',
  finalPath: '/tmp/downloads/file.zip',
  finalName: 'file.zip',
  transitionPhase: TransitionPhase.Idle,
  torrentMetaPath: null,
  source: 'user',
  sourceMeta: null,
}

const PLUGIN_TASK: PluginTaskSnapshotV1 = {
  schemaVersion: 1,
  id: BASE_TASK.id,
  name: BASE_TASK.name,
  type: BASE_TASK.type,
  kind: BASE_TASK.kind,
  status: BASE_TASK.status,
  filePath: BASE_TASK.finalPath,
  saveDir: BASE_TASK.saveDir,
  filename: BASE_TASK.filename,
  progress: 100,
  totalBytes: BASE_TASK.totalBytes,
  downloadedBytes: BASE_TASK.downloadedBytes,
  uploadedBytes: BASE_TASK.uploadedBytes,
  sizeWhenDone: BASE_TASK.sizeWhenDone,
  fileCount: BASE_TASK.fileCount,
  createdAt: BASE_TASK.createdAt,
  updatedAt: BASE_TASK.updatedAt,
  finishedAt: BASE_TASK.finishedAt,
  category: BASE_TASK.category,
  infoHash: BASE_TASK.infoHash,
  error: null,
}

const AFTER_COMPLETE_DTO: AfterCompleteContextDTO = {
  schemaVersion: 1,
  invocationId: 'delivery-1:attempt-1',
  taskId: BASE_TASK.id,
  task: PLUGIN_TASK,
  filePath: '/tmp/downloads/file.zip',
  delivery: {
    schemaVersion: 1,
    id: 'delivery-1',
    occurrenceId: 'occurrence-1',
    occurredAt: 1_000_002,
  },
}

const BEFORE_FINALIZE_DTO: BeforeFinalizeContextDTO = {
  schemaVersion: 1,
  invocationId: 'before-finalize-1',
  taskId: BASE_TASK.id,
  sourceUrl: 'https://example.com/file.zip',
  createdBy: 'user',
  requestedAt: 1_000_000,
  task: PLUGIN_TASK,
  inputFilePath: '/tmp/downloads/file.zip.aria2',
  filePath: '/tmp/downloads/file.zip',
  targetFilePath: '/tmp/downloads/file.zip',
}

const ON_ERROR_DTO: OnErrorContextDTO = {
  schemaVersion: 1,
  invocationId: 'delivery-2:attempt-1',
  taskId: BASE_TASK.id,
  task: PLUGIN_TASK,
  filePath: '/tmp/downloads/file.zip',
  delivery: {
    schemaVersion: 1,
    id: 'delivery-2',
    occurrenceId: 'occurrence-2',
    occurredAt: 1_000_002,
  },
  error: {
    code: 'ERR_TIMEOUT',
    message: 'Connection timed out',
    detailKey: null,
    detailParams: null,
  },
}

// ── makeBeforeCreateHttp ──────────────────────────────────────────────────────

describe('makeBeforeCreateHttp', () => {
  it('returns an object with dto, signal, metadata, and update', () => {
    const ac = makeAbortController()
    const meta = makeMutableMeta()
    const stagedUpdate = vi.fn()
    const ctx = makeBeforeCreateHttp(BASE_HTTP_DTO, meta, ac.signal, {
      update: stagedUpdate,
    })

    expect(ctx.dto).toBe(BASE_HTTP_DTO)
    expect(ctx.signal).toBe(ac.signal)
    expect(ctx.metadata).toBe(meta)
    expect(typeof ctx.update).toBe('function')
  })

  it('forwards the exact patch to staged.update when ctx.update is called', () => {
    const ac = makeAbortController()
    const stagedUpdate = vi.fn()
    const ctx = makeBeforeCreateHttp(
      BASE_HTTP_DTO,
      makeMutableMeta(),
      ac.signal,
      { update: stagedUpdate }
    )

    const patch = { filename: 'renamed.zip', connections: 4 }
    ctx.update(patch)

    expect(stagedUpdate).toHaveBeenCalledOnce()
    expect(stagedUpdate).toHaveBeenCalledWith(patch)
  })

  it('dto fields are accessible and match the DTO passed in', () => {
    const ac = makeAbortController()
    const ctx = makeBeforeCreateHttp(
      BASE_HTTP_DTO,
      makeMutableMeta(),
      ac.signal,
      { update: vi.fn() }
    )

    expect(ctx.dto.type).toBe('http')
    expect(ctx.dto.uris).toEqual(['https://example.com/file.zip'])
    expect(ctx.dto.saveDir).toBe('/tmp/downloads')
  })

  it('signal.aborted flips when the AbortController aborts', () => {
    const ac = makeAbortController()
    const ctx = makeBeforeCreateHttp(
      BASE_HTTP_DTO,
      makeMutableMeta(),
      ac.signal,
      { update: vi.fn() }
    )

    expect(ctx.signal.aborted).toBe(false)
    ac.abort()
    expect(ctx.signal.aborted).toBe(true)
  })

  it('mutable metadata exposes set and delete', () => {
    const ac = makeAbortController()
    const meta = makeMutableMeta()
    const ctx = makeBeforeCreateHttp(BASE_HTTP_DTO, meta, ac.signal, {
      update: vi.fn(),
    })

    const m = ctx.metadata as PluginMetadata
    m.set('myKey', 'hello')
    expect(m.get('myKey')).toBe('hello')
    expect(m.has('myKey')).toBe(true)
    m.delete('myKey')
    expect(m.has('myKey')).toBe(false)
  })

  it('readonly metadata does not expose set or delete at runtime', () => {
    const ac = makeAbortController()
    const roMeta = makeReadonlyMeta()
    const ctx = makeBeforeCreateHttp(BASE_HTTP_DTO, roMeta, ac.signal, {
      update: vi.fn(),
    })

    expect((ctx.metadata as Record<string, unknown>).set).toBeUndefined()
    expect((ctx.metadata as Record<string, unknown>).delete).toBeUndefined()
  })
})

// ── makeBeforeCreateBt ────────────────────────────────────────────────────────

describe('makeBeforeCreateBt', () => {
  it('returns a ctx with dto, signal, and metadata; no update', () => {
    const ac = makeAbortController()
    const meta = makeReadonlyMeta()
    const ctx = makeBeforeCreateBt(BASE_BT_DTO, meta, ac.signal)

    expect(ctx.dto).toBe(BASE_BT_DTO)
    expect(ctx.signal).toBe(ac.signal)
    expect(ctx.metadata).toBe(meta)
    expect(ctx.update).toBeUndefined()
  })

  it('signal.aborted flips after abort', () => {
    const ac = makeAbortController()
    const ctx = makeBeforeCreateBt(BASE_BT_DTO, makeReadonlyMeta(), ac.signal)

    expect(ctx.signal.aborted).toBe(false)
    ac.abort()
    expect(ctx.signal.aborted).toBe(true)
  })
})

// ── makeBeforeFinalize ────────────────────────────────────────────────────────

describe('makeBeforeFinalize', () => {
  it('returns an object with dto, signal, metadata, and update', () => {
    const ac = makeAbortController()
    const meta = makeMutableMeta()
    const stagedUpdate = vi.fn()
    const ctx = makeBeforeFinalize(BEFORE_FINALIZE_DTO, meta, ac.signal, {
      update: stagedUpdate,
    })

    expect(ctx.dto).toBe(BEFORE_FINALIZE_DTO)
    expect(ctx.signal).toBe(ac.signal)
    expect(ctx.metadata).toBe(meta)
    expect(typeof ctx.update).toBe('function')
  })

  it('forwards the exact patch to staged.update when ctx.update is called', () => {
    const ac = makeAbortController()
    const stagedUpdate = vi.fn()
    const ctx = makeBeforeFinalize(
      BEFORE_FINALIZE_DTO,
      makeMutableMeta(),
      ac.signal,
      { update: stagedUpdate }
    )

    const patch = { filePath: '/tmp/downloads/renamed.zip' }
    ctx.update(patch)

    expect(stagedUpdate).toHaveBeenCalledOnce()
    expect(stagedUpdate).toHaveBeenCalledWith(patch)
  })

  it('signal.aborted flips when the AbortController aborts', () => {
    const ac = makeAbortController()
    const ctx = makeBeforeFinalize(
      BEFORE_FINALIZE_DTO,
      makeMutableMeta(),
      ac.signal,
      { update: vi.fn() }
    )

    expect(ctx.signal.aborted).toBe(false)
    ac.abort()
    expect(ctx.signal.aborted).toBe(true)
  })
})

// ── makeAfterComplete ─────────────────────────────────────────────────────────

describe('makeAfterComplete', () => {
  it('returns ctx with dto, signal, metadata; no update', () => {
    const ac = makeAbortController()
    const meta = makeReadonlyMeta()
    const ctx = makeAfterComplete(AFTER_COMPLETE_DTO, meta, ac.signal)

    expect(ctx.dto).toBe(AFTER_COMPLETE_DTO)
    expect(ctx.signal).toBe(ac.signal)
    expect(ctx.update).toBeUndefined()
  })
})

// ── makeOnError ───────────────────────────────────────────────────────────────

describe('makeOnError', () => {
  it('returns ctx with dto, signal, metadata; no update', () => {
    const ac = makeAbortController()
    const meta = makeReadonlyMeta()
    const ctx = makeOnError(ON_ERROR_DTO, meta, ac.signal)

    expect(ctx.dto.error.code).toBe('ERR_TIMEOUT')
    expect(ctx.update).toBeUndefined()
  })

  it('signal.aborted flips after abort', () => {
    const ac = makeAbortController()
    const ctx = makeOnError(ON_ERROR_DTO, makeReadonlyMeta(), ac.signal)

    expect(ctx.signal.aborted).toBe(false)
    ac.abort()
    expect(ctx.signal.aborted).toBe(true)
  })
})
