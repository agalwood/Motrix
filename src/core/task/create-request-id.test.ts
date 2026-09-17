import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runCreateRequest, scopedCreateRequestId } from './create-request-id'

describe('create request receipts', () => {
  it('binds remote request IDs to both client identity and key', () => {
    const id = scopedCreateRequestId('client-one', 'retry-key')
    expect(z.uuid().safeParse(id).success).toBe(true)
    expect(scopedCreateRequestId('client-one', 'retry-key')).toBe(id)
    expect(scopedCreateRequestId('client-two', 'retry-key')).not.toBe(id)
    expect(scopedCreateRequestId('client-one', 'new-key')).not.toBe(id)
  })
  it('coalesces pending calls and rejects a different payload under the same key', async () => {
    const owners = { getAll: () => [] }
    let finish!: (value: {
      outcome: 'created'
      gid: string
      taskId: string
    }) => void
    const create = vi.fn(
      () =>
        new Promise<{ outcome: 'created'; gid: string; taskId: string }>(
          (resolve) => {
            finish = resolve
          }
        )
    )
    const first = runCreateRequest(owners, 'id', 'fingerprint', create)
    expect(runCreateRequest(owners, 'id', 'fingerprint', create)).toBe(first)
    await expect(
      runCreateRequest(owners, 'id', 'different', create)
    ).rejects.toMatchObject({ code: 'IPC_INVALID_PAYLOAD' })
    finish({ outcome: 'created', gid: 'gid', taskId: 'task' })
    await expect(first).resolves.toMatchObject({ taskId: 'task' })
    expect(create).toHaveBeenCalledOnce()
  })

  it('reuses durable task receipts after the in-memory owner is replaced', async () => {
    const task = makeDownloadTask({ id: 'task', engineTaskId: 'gid' })
    task.instances = [
      {
        payload: {
          createRequestId: 'id',
          createRequestFingerprint: 'fingerprint',
        },
      },
    ] as unknown as typeof task.instances
    const create = vi.fn()
    const owners = { getAll: () => [task] }
    await expect(
      runCreateRequest(owners, 'id', 'fingerprint', create)
    ).resolves.toEqual({ outcome: 'reused', gid: 'gid', taskId: 'task' })
    await expect(
      runCreateRequest({ getAll: () => [task] }, 'id', 'fingerprint', create)
    ).resolves.toMatchObject({ outcome: 'reused' })
    expect(create).not.toHaveBeenCalled()
  })

  it('permits a confirmed failure to retry and distinct keys to create duplicates', async () => {
    const owners = { getAll: () => [] }
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValue({ outcome: 'created', taskId: 'task', gid: 'gid' })
    await expect(runCreateRequest(owners, 'id', 'f', create)).rejects.toThrow(
      'failed'
    )
    await runCreateRequest(owners, 'id', 'f', create)
    await runCreateRequest(owners, 'another', 'f', create)
    expect(create).toHaveBeenCalledTimes(3)
  })
})
