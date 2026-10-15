import type { MdxpConnection } from '@motrix/mdxp'
import { Methods } from '@motrix/mdxp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResponseError } from 'vscode-jsonrpc'
import { RpcRecovery, type RpcSession } from '@/background/RpcRecovery'

const never = () => new Promise<never>(() => {})
function fixture() {
  const send = vi.fn(async (method: string, params: { sentAt?: number }) => {
    if (method === Methods.SystemPing)
      return { sentAt: params.sentAt, recvAt: Date.now() }
    return never()
  })
  const replacementSend = vi.fn(async () => ({ tasks: [] }))
  const original = {
    conn: { sendRequest: send } as unknown as MdxpConnection,
    generation: 1,
  }
  let session: RpcSession | null = original
  const reconnect = vi.fn(async () => {
    session = {
      conn: { sendRequest: replacementSend } as unknown as MdxpConnection,
      generation: 2,
    }
    return session
  })
  const rpc = new RpcRecovery({
    session: () => session,
    reconnect,
    requestTimeoutMs: 15000,
  })
  return {
    rpc,
    send,
    reconnect,
    replacementSend,
    original,
    setSession: (next: RpcSession | null) => {
      session = next
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
})
afterEach(() => vi.useRealTimers())

describe('bounded RPC recovery', () => {
  it('bounds the initial read, failed probe, reconnect and retry to 30 seconds total', async () => {
    const { rpc, send, reconnect, replacementSend } = fixture()
    send.mockImplementation(never)
    replacementSend.mockImplementation(never)
    const replace = reconnect.getMockImplementation()!
    reconnect.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 8000))
      return replace()
    })
    const done = vi.fn()
    const result = rpc.request(Methods.TaskList, {})
    const rejection = expect(result).rejects.toThrow('timed out')
    void result.then(done, done)

    // 15s ordinary read + 2s liveness probe + 8s reconnect + 5s retry.
    await vi.advanceTimersByTimeAsync(29_999)
    expect(done).not.toHaveBeenCalled()
    expect(rpc.snapshot().health).toBe('checking')
    expect(reconnect).toHaveBeenCalledOnce()
    expect(replacementSend).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(done).toHaveBeenCalledOnce()
    expect(rpc.snapshot().health).toBe('unresponsive')
  })

  it('probes a live socket, cancels the timed-out read and replays it only once', async () => {
    const { rpc, send, reconnect } = fixture()
    let cancelled = false
    send.mockImplementationOnce((_method, _params, token) => {
      token.onCancellationRequested(() => {
        cancelled = true
      })
      return never()
    })
    const result = rpc.request(Methods.TaskList, {})
    await vi.advanceTimersByTimeAsync(15000)
    expect(cancelled).toBe(true)
    expect(rpc.snapshot().health).toBe('checking')
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      Methods.TaskList,
      Methods.SystemPing,
      Methods.TaskList,
    ])
    const rejection = expect(result).rejects.toThrow('timed out after 5000ms')
    await vi.advanceTimersByTimeAsync(5000)
    await rejection
    expect(reconnect).not.toHaveBeenCalled()
    expect(rpc.snapshot().health).toBe('unresponsive')
    await expect(rpc.request(Methods.TaskList, {})).rejects.toThrow(
      'needs retry'
    )
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('shares one probe and one replacement across concurrent reads', async () => {
    const { rpc, send, reconnect, replacementSend } = fixture()
    send.mockImplementation(never)
    const first = rpc.request(Methods.TaskList, {})
    const second = rpc.request(Methods.StatsGet, {})
    const third = rpc.request(Methods.EngineStatus, {})
    await vi.advanceTimersByTimeAsync(17000)
    await Promise.all([first, second, third])
    expect(
      send.mock.calls.filter(([method]) => method === Methods.SystemPing)
    ).toHaveLength(1)
    expect(reconnect).toHaveBeenCalledOnce()
    expect(reconnect).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1 }),
      8000
    )
    expect(replacementSend).toHaveBeenCalledTimes(3)
    expect(rpc.snapshot()).toMatchObject({ health: 'healthy', lastError: null })
  })

  it('never replays a timed-out write or a new write during recovery', async () => {
    const { rpc, send, reconnect, replacementSend } = fixture()
    send.mockImplementation(never)
    const result = rpc.request(Methods.TaskCancel, { taskId: 'task-1' })
    const rejection = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15000)
    await rejection
    await expect(
      rpc.request(Methods.TaskPause, { taskId: 'task-1' })
    ).rejects.toThrow('recovering')
    await vi.advanceTimersByTimeAsync(2000)
    expect(reconnect).toHaveBeenCalledOnce()
    expect(replacementSend).not.toHaveBeenCalled()
    expect(
      send.mock.calls.filter(([method]) => method === Methods.TaskCancel)
    ).toHaveLength(1)
    expect(rpc.snapshot()).toMatchObject({ health: 'healthy', lastError: null })
  })

  it('does not recover or publish an old request after explicit disconnect or endpoint change', async () => {
    const { rpc, send, reconnect, setSession } = fixture()
    send.mockImplementation(never)
    const result = rpc.request(Methods.TaskList, {})
    const rejected = expect(result).rejects.toThrow('timed out')
    rpc.reset()
    setSession(null)
    await vi.advanceTimersByTimeAsync(30000)
    await rejected
    expect(reconnect).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledOnce()
    expect(rpc.snapshot()).toMatchObject({ health: 'healthy', lastError: null })
  })

  it('ignores an old probe that completes after reset', async () => {
    const { rpc, send, reconnect, setSession } = fixture()
    let pong: ((value: unknown) => void) | undefined
    send.mockImplementation((method) =>
      method === Methods.SystemPing
        ? new Promise((resolve) => {
            pong = resolve
          })
        : never()
    )
    const result = rpc.request(Methods.TaskList, {})
    const rejected = expect(result).rejects.toThrow('RPC session changed')
    await vi.advanceTimersByTimeAsync(15000)
    rpc.reset()
    setSession(null)
    pong?.({ sentAt: Date.now(), recvAt: Date.now() })
    await rejected
    expect(reconnect).not.toHaveBeenCalled()
    expect(rpc.snapshot().health).toBe('healthy')
  })

  it('waits for the shared read retry within the caller deadline', async () => {
    const { rpc, send } = fixture()
    let resolveRetry: ((value: unknown) => void) | undefined
    let reads = 0
    send.mockImplementation((method, params) => {
      if (method === Methods.SystemPing)
        return Promise.resolve({ ...params, recvAt: Date.now() })
      return ++reads === 1
        ? never()
        : new Promise((resolve) => {
            resolveRetry = resolve
          })
    })
    const request = rpc.request(Methods.TaskList, {})
    await vi.advanceTimersByTimeAsync(15000)
    let ready = false
    const preparation = rpc.ready(Date.now() + 8000).then(() => {
      ready = true
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(ready).toBe(false)
    resolveRetry?.({ tasks: [] })
    await Promise.all([request, preparation])
    expect(ready).toBe(true)
    expect(rpc.snapshot().health).toBe('healthy')
  })

  it('stops after failed recovery and allows explicit reset', async () => {
    const { rpc, send, reconnect } = fixture()
    send.mockImplementation(never)
    reconnect.mockRejectedValue(new Error('offline'))
    const result = rpc.request(Methods.TaskList, {})
    const rejected = expect(result).rejects.toThrow('offline')
    await vi.advanceTimersByTimeAsync(17000)
    await rejected
    expect(rpc.snapshot().health).toBe('unresponsive')
    await vi.advanceTimersByTimeAsync(60000)
    expect(reconnect).toHaveBeenCalledOnce()
    rpc.reset()
    send.mockResolvedValue({ tasks: [] })
    await expect(rpc.request(Methods.TaskList, {})).resolves.toEqual({
      tasks: [],
    })
  })
})

it('keeps the complete timeout, probe, reconnect and read retry within 30 seconds', async () => {
  const { rpc, send, reconnect, replacementSend } = fixture()
  send.mockImplementation(never)
  replacementSend.mockImplementation(never)
  const replace = reconnect.getMockImplementation()
  reconnect.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 8000))
    return replace?.() as never
  })
  const request = rpc.request(Methods.TaskList, {})
  const rejected = expect(request).rejects.toThrow('timed out after 5000ms')
  const start = Date.now()
  await vi.advanceTimersByTimeAsync(30000)
  await rejected
  expect(Date.now() - start).toBe(30000)
  expect(rpc.snapshot().health).toBe('unresponsive')
  expect(reconnect).toHaveBeenCalledOnce()
  expect(replacementSend).toHaveBeenCalledOnce()
})

it('surfaces a protocol rejection from the replay without treating a responsive peer as offline', async () => {
  const { rpc, send, reconnect } = fixture()
  const error = new ResponseError(-32602, 'invalid query')
  send
    .mockImplementationOnce(never)
    .mockImplementationOnce(async (_method, params) => ({
      sentAt: params.sentAt,
      recvAt: Date.now(),
    }))
    .mockRejectedValueOnce(error)
  const request = rpc.request(Methods.TaskList, {})
  const rejected = expect(request).rejects.toBe(error)
  await vi.advanceTimersByTimeAsync(15000)
  await rejected
  expect(rpc.snapshot()).toMatchObject({ health: 'healthy', lastError: null })
  expect(reconnect).not.toHaveBeenCalled()
})

it('rejects a new write while the read retry is still checking health', async () => {
  const { rpc, send } = fixture()
  const read = rpc.request(Methods.TaskList, {})
  const failedRead = expect(read).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(15000)
  expect(rpc.snapshot().health).toBe('checking')
  send.mockResolvedValueOnce({ ok: true })
  await expect(
    rpc.request(Methods.TaskPause, { taskId: 'task-1' })
  ).rejects.toThrow('recovering')
  expect(
    send.mock.calls.filter(([method]) => method === Methods.TaskPause)
  ).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(5000)
  await failedRead
})

it.each([-32099, -32098, -32097, -32096])(
  'does not classify a local transport ResponseError %s as a healthy peer reply',
  async (code) => {
    const { rpc, send } = fixture()
    const failure = new ResponseError(code, 'transport unavailable')
    send
      .mockImplementationOnce(never)
      .mockImplementationOnce(async (_method, params) => ({
        sentAt: params.sentAt,
        recvAt: Date.now(),
      }))
      .mockRejectedValueOnce(failure)
    const read = rpc.request(Methods.TaskList, {})
    const rejected = expect(read).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(15000)
    await rejected
    expect(rpc.snapshot().health).toBe('unresponsive')
    await expect(rpc.ready(Date.now() + 1000)).rejects.toThrow('needs retry')
  }
)

it.each([-32099, -32098, -32097, -32096])(
  'recovers an initial transport failure %s instead of leaving a broken connection healthy',
  async (code) => {
    const { rpc, send, reconnect, replacementSend } = fixture()
    const failure = new ResponseError(code, 'transport unavailable')
    send.mockRejectedValue(failure)
    await expect(rpc.request(Methods.TaskList, {})).resolves.toEqual({
      tasks: [],
    })
    expect(reconnect).toHaveBeenCalledOnce()
    expect(replacementSend).toHaveBeenCalledOnce()
    expect(rpc.snapshot().health).toBe('healthy')
  }
)

it('joins the recorded recovery when disposing its socket rejects another pending read', async () => {
  const { rpc, send, reconnect, replacementSend } = fixture()
  let rejectPending: ((error: Error) => void) | undefined
  send.mockImplementation((method) =>
    method === Methods.StatsGet
      ? new Promise((_resolve, reject) => {
          rejectPending = reject
        })
      : never()
  )
  const replace = reconnect.getMockImplementation()
  reconnect.mockImplementation(async () => {
    const ready = await replace?.()
    rejectPending?.(new ResponseError(-32097, 'connection disposed'))
    return ready as never
  })
  const first = rpc.request(Methods.TaskList, {})
  await vi.advanceTimersByTimeAsync(4000)
  const second = rpc.request(Methods.StatsGet, {})
  const completed = expect(Promise.all([first, second])).resolves.toEqual([
    { tasks: [] },
    { tasks: [] },
  ])
  await vi.advanceTimersByTimeAsync(13000)
  await completed
  expect(reconnect).toHaveBeenCalledOnce()
  expect(replacementSend).toHaveBeenCalledTimes(2)
})
