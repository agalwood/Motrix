import { ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import {
  makeProtocolFailure,
  makeProtocolSuccess,
  ProtocolEnvelopeError,
  type TransportError,
} from '@shared/protocol/errors'
import { Queries } from '@shared/protocol/queries'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ElectronTransport } from './electron'

afterEach(() => {
  Reflect.deleteProperty(window, 'motrix')
})

describe('ElectronTransport', () => {
  it('unwraps a protocol success envelope', async () => {
    const invoke = vi.fn(async () => makeProtocolSuccess({ revision: 3 }))
    Object.defineProperty(window, 'motrix', {
      configurable: true,
      value: { invoke, on: vi.fn(), off: vi.fn(), platform: 'darwin' },
    })

    await expect(
      new ElectronTransport().invoke(Queries.GetTaskInspectorActivity, {
        taskId: 'task-1',
      })
    ).resolves.toEqual({ revision: 3 })
  })

  it('reconstructs the typed domain failure', async () => {
    const invoke = vi.fn(async () =>
      makeProtocolFailure({
        code: ErrorCode.TaskNotFound,
        message: 'task missing',
      })
    )
    Object.defineProperty(window, 'motrix', {
      configurable: true,
      value: { invoke, on: vi.fn(), off: vi.fn(), platform: 'darwin' },
    })

    await expect(
      new ElectronTransport().invoke(Queries.GetTaskInspectorActivity, {
        taskId: 'task-1',
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<TransportError>>({
        name: 'TransportError',
        code: ErrorCode.TaskNotFound,
      })
    )
  })

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

  it('rejects a malformed inspector envelope', async () => {
    const invoke = vi.fn(async () => ({ ok: true, revision: 3 }))
    Object.defineProperty(window, 'motrix', {
      configurable: true,
      value: { invoke, on: vi.fn(), off: vi.fn(), platform: 'darwin' },
    })

    await expect(
      new ElectronTransport().invoke(Queries.GetTaskInspectorActivity, {
        taskId: 'task-1',
      })
    ).rejects.toBeInstanceOf(ProtocolEnvelopeError)
  })
})
