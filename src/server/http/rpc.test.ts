import { AppError, ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import { PROTOCOL_ENVELOPE_VERSION } from '@shared/protocol/errors'
import { Queries } from '@shared/protocol/queries'
import { makeTaskInspectorActivitySnapshot } from '@test-utils/task-inspector-activity'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app'

describe('rpc routes', () => {
  it('dispatches a command through the handler map', async () => {
    const handler = vi.fn(async () => ({ ok: true, gid: 'xyz' }))
    const app = await createApp({
      commandHandlers: { [Commands.AddMagnetTask]: handler },
      queryHandlers: {},
    })
    const res = await app.inject({
      method: 'POST',
      url: `/rpc/command/${encodeURIComponent(Commands.AddMagnetTask)}`,
      payload: { args: [{ uri: 'magnet:?x', selectedFiles: [], saveDir: '' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, gid: 'xyz' })
    expect(handler).toHaveBeenCalledOnce()
    await app.close()
  })

  it('returns 404 for unknown channel', async () => {
    const app = await createApp({ commandHandlers: {}, queryHandlers: {} })
    const res = await app.inject({
      method: 'POST',
      url: '/rpc/command/command:doesNotExist',
      payload: { args: [] },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('dispatches a query', async () => {
    const app = await createApp({
      commandHandlers: {},
      queryHandlers: { [Queries.ListTasks]: async () => [{ id: 't1' }] },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/rpc/query/${encodeURIComponent(Queries.ListTasks)}`,
      payload: { args: [] },
    })
    expect(res.json()).toEqual([{ id: 't1' }])
    await app.close()
  })

  it('returns the shared bounded envelope for inspector query success', async () => {
    const snapshot = makeTaskInspectorActivitySnapshot('task-1', 9)
    const app = await createApp({
      queryHandlers: {
        [Queries.GetTaskInspectorActivity]: async () => snapshot,
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/rpc/query/${encodeURIComponent(Queries.GetTaskInspectorActivity)}`,
      payload: { args: [{ taskId: 'task-1' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: true,
      value: snapshot,
    })
    await app.close()
  })

  it('returns the same typed task-not-found envelope without framework text', async () => {
    const app = await createApp({
      queryHandlers: {
        [Queries.GetTaskInspectorActivity]: async () => {
          throw new AppError(ErrorCode.TaskNotFound, 'task missing')
        },
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/rpc/query/${encodeURIComponent(Queries.GetTaskInspectorActivity)}`,
      payload: { args: [{ taskId: 'missing' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: false,
      error: {
        code: ErrorCode.TaskNotFound,
        message: 'task missing',
      },
    })
    await app.close()
  })

  it.each([
    { label: 'missing args', payload: {} },
    { label: 'non-array args', payload: { args: { taskId: 'task-1' } } },
    { label: 'zero arguments', payload: { args: [] } },
    {
      label: 'extra arguments',
      payload: { args: [{ taskId: 'task-1' }, { poison: true }] },
    },
  ])(
    'rejects inspector $label with the shared typed envelope',
    async ({ payload }) => {
      const handler = vi.fn(async () => ({ revision: 9 }))
      const app = await createApp({
        queryHandlers: {
          [Queries.GetTaskInspectorActivity]: handler,
        },
      })
      const res = await app.inject({
        method: 'POST',
        url: `/rpc/query/${encodeURIComponent(Queries.GetTaskInspectorActivity)}`,
        payload,
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        protocol: PROTOCOL_ENVELOPE_VERSION,
        ok: false,
        error: { code: ErrorCode.IpcInvalidPayload },
      })
      expect(handler).not.toHaveBeenCalled()
      await app.close()
    }
  )

  it('maps a circular Activity success before Fastify serializes it', async () => {
    const poisoned = makeTaskInspectorActivitySnapshot('task-1') as ReturnType<
      typeof makeTaskInspectorActivitySnapshot
    > & {
      self?: unknown
    }
    poisoned.self = poisoned
    const app = await createApp({
      queryHandlers: {
        [Queries.GetTaskInspectorActivity]: async () => poisoned,
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: `/rpc/query/${encodeURIComponent(Queries.GetTaskInspectorActivity)}`,
      payload: { args: [{ taskId: 'task-1' }] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      protocol: PROTOCOL_ENVELOPE_VERSION,
      ok: false,
      error: {
        code: ErrorCode.EngineProtocolError,
        message: 'Request failed',
      },
    })
    await app.close()
  })
})
