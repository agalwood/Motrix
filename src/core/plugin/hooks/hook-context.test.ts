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
  type: 'http',
  sourceUrl: 'https://example.com/file.zip',
  createdBy: 'user',
  requestedAt: 1_000_000,
  uris: ['https://example.com/file.zip'],
  saveDir: '/tmp/downloads',
  headers: [],
}

const BASE_BT_DTO: BeforeCreateBtContextDTO = {
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

const AFTER_COMPLETE_DTO: AfterCompleteContextDTO = {
  task: BASE_TASK,
  filePath: '/tmp/downloads/file.zip',
}

const BEFORE_FINALIZE_DTO: BeforeFinalizeContextDTO = {
  sourceUrl: 'https://example.com/file.zip',
  createdBy: 'user',
  requestedAt: 1_000_000,
  task: BASE_TASK,
  filePath: '/tmp/downloads/file.zip',
}

const ON_ERROR_DTO: OnErrorContextDTO = {
  task: BASE_TASK,
  error: { code: 'ERR_TIMEOUT', message: 'Connection timed out' },
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
