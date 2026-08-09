import { taskCreateRequestSchema } from '@shared/schemas/add-task'
import { describe, expect, it, vi } from 'vitest'
import type { AdaptedDirect } from '../submit-download-adapter'
import { DirectPipeline } from './direct-pipeline'

function buildAdapted(): AdaptedDirect {
  return {
    taskId: 't1',
    saveDir: '/tmp/save',
    finalName: 'x.mp4',
    kind: 'direct',
    primaryUrl: 'http://example.com/x.mp4',
    sanitizedHeaders: { 'X-Custom': 'v' },
    jarPath: '/tmp/jar.txt',
    pageUrl: 'http://example.com/page',
    sourceMeta: {
      kind: 'direct',
      extensionId: 'e',
      browser: 'chromium',
      sessionKey: 'chromium:e',
      pageUrl: 'http://example.com/page',
      pageTitle: 't',
      qualityLabel: 'q',
      durationSec: null,
      submittedAt: 1,
    },
  }
}

describe('DirectPipeline.dispatch', () => {
  it('calls createTask with HTTP type, headers, cookies, referer, source meta', async () => {
    const createTask = vi.fn(async () => ({
      gid: 'gid-1',
      taskId: 'task-abc',
    })) as any
    const removeTask = vi.fn(async () => {}) as any
    const pipeline = new DirectPipeline({ createTask, removeTask })
    const result = await pipeline.dispatch(buildAdapted())

    // MDXP taskId is the stable DownloadTask.id, not the aria2 gid —
    // the gid can rotate when a task swaps instances (magnet metadata
    // → bt_download), so leaking gid as the public id would break ext
    // round-trips after instance swaps.
    expect(result).toEqual({ taskId: 'task-abc' })
    // The engine request must satisfy the REAL taskCreateRequestSchema. The
    // previous shape buried uris under payload.uris; that fails the schema at
    // runtime in handleCreateTask, but the mocked createTask here never
    // validated it, so the test was green while production rejected every
    // direct submit. Validate against the schema so the shape can't regress.
    const req = createTask.mock.calls[0]?.[0]
    expect(taskCreateRequestSchema.safeParse(req).success).toBe(true)
    // Headers ride on req.headers (→ params.headers), the single
    // plugin-mutable path, so a beforeCreate plugin can override them.
    expect(req).toMatchObject({
      type: 'http',
      uris: ['http://example.com/x.mp4'],
      saveDir: '/tmp/save',
      filename: 'x.mp4',
      connections: 1,
      headers: [{ name: 'X-Custom', value: 'v' }],
    })
    expect(req).not.toHaveProperty('payload')
    const opts = (createTask.mock.calls[0]?.[2] ?? {}) as Record<
      string,
      unknown
    >
    expect(opts).toMatchObject({
      source: 'bridge',
      sourceMeta: { kind: 'direct', sessionKey: 'chromium:e' },
    })
    // extraEngineOptions carries only cookies + referer. It must NOT
    // re-specify header: Aria2Adapter applies extraEngineOptions last, so a
    // header here would clobber (and discard) any plugin rewrite of
    // params.headers.
    expect(opts.extraEngineOptions).toMatchObject({
      'load-cookies': '/tmp/jar.txt',
      referer: 'http://example.com/page',
    })
    expect(opts.extraEngineOptions).not.toHaveProperty('header')
  })
})

describe('DirectPipeline.cancel', () => {
  it('delegates to removeTask using the public taskId', async () => {
    const createTask = vi.fn(async () => ({
      gid: 'gid-1',
      taskId: 'task-abc',
    })) as any
    const removeTask = vi.fn(async () => {}) as any
    const pipeline = new DirectPipeline({ createTask, removeTask })
    await pipeline.cancel('task-abc')
    expect(removeTask).toHaveBeenCalledWith('task-abc')
  })
})
