import { ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import {
  makeProtocolFailure,
  makeProtocolSuccess,
  ProtocolEnvelopeError,
  type TransportError,
} from '@shared/protocol/errors'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { rendererSubmissionSchema } from '@shared/schemas/renderer-submission'
import { version as uuidVersion } from 'uuid'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ElectronTransport } from './electron'

afterEach(() => {
  Reflect.deleteProperty(window, 'motrix')
  vi.unstubAllGlobals()
})

describe('ElectronTransport', () => {
  it('wraps submissions with distinct UUID v7 IDs without native randomUUID', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    })
    const generation = '00000000-0000-4000-8000-000000000001'
    const invoke = vi.fn(async (channel: string, ..._args: unknown[]) =>
      channel === Queries.GetRendererSession
        ? {
            generation,
            windowId: 'add-task',
            recovered: false,
            submissionNeedsReview: false,
            strings: {
              title: '',
              description: '',
              recovering: '',
              recover: '',
              diagnostics: '',
              downloads: '',
              failed: '',
              restored: '',
            },
          }
        : { taskId: 'task-1' }
    )
    Object.defineProperty(window, 'motrix', {
      configurable: true,
      value: { invoke, platform: 'darwin' },
    })
    const transport = new ElectronTransport()
    const args = { type: 'http', uris: ['https://example.test/file'] }
    await expect(transport.invoke(Commands.CreateTask, args)).resolves.toEqual({
      taskId: 'task-1',
    })
    await transport.invoke(Commands.CreateTask, args)
    const submissions = invoke.mock.calls
      .filter(([channel]) => channel === Commands.ExecuteRendererSubmission)
      .map((call) => rendererSubmissionSchema.parse(call[1]))
    expect(submissions).toHaveLength(2)
    for (const submission of submissions) {
      expect(submission).toMatchObject({
        generation,
        channel: Commands.CreateTask,
        args: [args],
      })
      expect(uuidVersion(submission.id)).toBe(7)
    }
    expect(submissions[0].id).not.toBe(submissions[1].id)
  })
  it('retains preload disposers per callback and channel without passing callbacks back across the bridge', () => {
    const first = vi.fn()
    const second = vi.fn()
    const on = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    Object.defineProperty(window, 'motrix', {
      configurable: true,
      value: { on, platform: 'darwin' },
    })
    const transport = new ElectronTransport()
    const callback = vi.fn()
    transport.on(Events.PluginInstalled, callback)
    transport.on(Events.PluginInstalled, callback)
    transport.on(Events.PluginStatusChanged, callback)
    expect(on).toHaveBeenCalledTimes(2)
    transport.off(Events.PluginInstalled, callback)
    transport.off(Events.PluginInstalled, callback)
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    transport.off(Events.PluginStatusChanged, callback)
    expect(second).toHaveBeenCalledOnce()
  })
  it.each([Queries.GetTaskInspectorActivity, Commands.OpenTaskFile])(
    'unwraps a protocol success envelope for %s',
    async (channel) => {
      const invoke = vi.fn(async () => makeProtocolSuccess({ revision: 3 }))
      Object.defineProperty(window, 'motrix', {
        configurable: true,
        value: { invoke, on: vi.fn(), off: vi.fn(), platform: 'darwin' },
      })

      await expect(
        new ElectronTransport().invoke(channel, {
          taskId: 'task-1',
        })
      ).resolves.toEqual({ revision: 3 })
    }
  )

  it.each([Queries.GetTaskInspectorActivity, Commands.OpenTaskFile])(
    'reconstructs the typed domain failure for %s',
    async (channel) => {
      const invoke = vi.fn(async () =>
        makeProtocolFailure({
          code: ErrorCode.TaskOpenAppFailed,
          message: 'No application available',
        })
      )
      Object.defineProperty(window, 'motrix', {
        configurable: true,
        value: { invoke, on: vi.fn(), off: vi.fn(), platform: 'darwin' },
      })

      await expect(
        new ElectronTransport().invoke(channel, {
          taskId: 'task-1',
        })
      ).rejects.toEqual(
        expect.objectContaining<Partial<TransportError>>({
          name: 'TransportError',
          code: ErrorCode.TaskOpenAppFailed,
          message: 'No application available',
        })
      )
    }
  )

  it('preserves non-envelope command results', async () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    Object.defineProperty(window, 'motrix', {
      configurable: true,
      value: { invoke, on: vi.fn(), off: vi.fn(), platform: 'darwin' },
    })

    await expect(
      new ElectronTransport().invoke(Commands.PauseTask, 'task-1')
    ).resolves.toEqual({ ok: true })
  })

  it.each([Queries.GetTaskInspectorActivity, Commands.OpenTaskFile])(
    'rejects a malformed envelope for %s',
    async (channel) => {
      const invoke = vi.fn(async () => ({ ok: true, revision: 3 }))
      Object.defineProperty(window, 'motrix', {
        configurable: true,
        value: { invoke, on: vi.fn(), off: vi.fn(), platform: 'darwin' },
      })

      await expect(
        new ElectronTransport().invoke(channel, {
          taskId: 'task-1',
        })
      ).rejects.toBeInstanceOf(ProtocolEnvelopeError)
    }
  )
})
