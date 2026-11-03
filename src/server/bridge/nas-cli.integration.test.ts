import { mkdtemp, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { EventBus } from '@core/events/event-bus'
import { Methods } from '@motrix/mdxp'
import { BridgeCommands, BridgeQueries } from '@shared/protocol/bridge'
import { EngineState } from '@shared/types/engine'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, expect, it, vi } from 'vitest'
import {
  currentNasUser,
  type NasIdentity,
  runAsNasGatewayUser,
  runAsNasUser,
} from '../platform/nas/identity'
import { bootstrapBridgeForServer, type ServerBridgeRuntime } from './bootstrap'

const alice: NasIdentity = {
  platform: 'fnos',
  userId: '1000',
  username: 'alice',
  administrator: true,
}
const bob: NasIdentity = { ...alice, userId: '1001', username: 'bob' }
const currentAccount = (identity: NasIdentity): NasIdentity => ({
  ...identity,
  accountRevision: 'fixture-generation-1',
})
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp('/tmp/motrix-nas-cli-')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let runtime: ServerBridgeRuntime
  const seen: (NasIdentity | undefined)[] = []
  const task = makeDownloadTask({ id: 'task', status: TaskStatus.Paused })
  const account = {
    resolve: vi.fn(
      async (identity: NasIdentity): Promise<NasIdentity | null> =>
        currentAccount(identity)
    ),
  }
  const resume = vi.fn(async () => {
    seen.push(currentNasUser())
  })
  const start = async () => {
    runtime = await bootstrapBridgeForServer({
      userDataDir: root,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.2.0',
      eventBus: new EventBus(),
      nasAccounts: {
        platform: 'fnos',
        resolve: (identity) => account.resolve(identity),
      },
      readHandlerDeps: {
        taskManager: {
          getAll: () => {
            seen.push(currentNasUser())
            return [task]
          },
          getById: () => task,
        },
        statsAggregator: {
          getStats: () => ({
            totalDownloadSpeed: 0,
            totalUploadSpeed: 0,
            activeTasks: 0,
            waitingTasks: 0,
            stoppedTasks: 1,
          }),
        },
        supervisor: {
          getState: () => EngineState.Ready,
          getFeatureReport: () => null,
        },
      },
      writeHandlerDeps: {
        taskManager: { getById: () => task },
        pauseTask: vi.fn(async () => {}),
        resumeTask: resume,
        removeTask: vi.fn(async () => {}),
        createTask: vi.fn(async () => ({ taskId: task.id })),
        parseTorrentFileCount: async () => 1,
      },
    })
  }
  await start()
  cleanup.push(() => runtime.shutdown())
  const url = (pathname: string) =>
    `http://127.0.0.1:${runtime.port}${pathname}`
  const post = (pathname: string, body: unknown, token?: string) =>
    fetch(url(pathname), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  const pair = async (owner = alice) => {
    const request = await (
      await post('/mdxp/pair/request', {
        clientName: 'NAS CLI fixture',
        deviceId: 'stable_device_12345',
      })
    ).json()
    const pending =
      await runtime.bridgeQueryHandlers[BridgeQueries.ListPendingPairRequests]()
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: request.requestId }),
      ])
    )
    expect(
      await runAsNasGatewayUser(owner, () =>
        runtime.bridgeCommandHandlers[BridgeCommands.ResolvePair]({
          kind: 'cli',
          requestId: request.requestId,
          decision: 'allow',
        })
      )
    ).toEqual({ ok: true })
    const result = await (
      await post('/mdxp/pair/poll', { requestId: request.requestId })
    ).json()
    expect(result.status).toBe('approved')
    expect(typeof result.token).toBe('string')
    return result.token as string
  }
  const rpc = (
    token: string,
    method: string = Methods.TaskList,
    params: unknown = {}
  ) => post('/mdxp', { jsonrpc: '2.0', id: 1, method, params }, token)
  return {
    root,
    seen,
    account,
    resume,
    pair,
    rpc,
    post,
    url,
    runtime: () => runtime,
    restart: async () => {
      await runtime.shutdown()
      await start()
    },
  }
}

it('cannot approve a device code without a NAS account context and keeps it retryable', async () => {
  const f = await fixture()
  const pending = await (
    await f.post('/mdxp/pair/request', { clientName: 'unbound client' })
  ).json()
  const decision = {
    kind: 'cli',
    requestId: pending.requestId,
    decision: 'allow',
  }
  await expect(
    f.runtime().bridgeCommandHandlers[BridgeCommands.ResolvePair](decision)
  ).rejects.toThrow('approval required')
  expect(
    await (
      await f.post('/mdxp/pair/poll', { requestId: pending.requestId })
    ).json()
  ).toMatchObject({ status: 'pending' })
  await runAsNasGatewayUser(alice, () =>
    f.runtime().bridgeCommandHandlers[BridgeCommands.ResolvePair](decision)
  )
  expect(
    await (
      await f.post('/mdxp/pair/poll', { requestId: pending.requestId })
    ).json()
  ).toMatchObject({ status: 'approved', token: expect.any(String) })
})

it('binds real device-code credentials to the approving account across restart and rejects local-token fallback', async () => {
  const f = await fixture()
  const token = await f.pair()
  expect((await f.rpc(token)).status).toBe(200)
  expect(f.seen.at(-1)).toEqual(currentAccount(alice))
  expect((await f.rpc(f.runtime().localToken)).status).toBe(403)
  expect(
    (await stat(path.join(f.root, 'bridge/nas-cli-pairing.json'))).mode & 0o777
  ).toBe(0o600)
  await f.restart()
  expect(
    (await f.rpc(token, Methods.TaskResume, { taskId: 'task' })).status
  ).toBe(200)
  expect(f.resume).toHaveBeenCalledOnce()
  expect(f.seen.at(-1)).toEqual(currentAccount(alice))
  f.account.resolve.mockResolvedValue({ ...alice, administrator: false })
  expect(
    (await f.rpc(token, Methods.TaskResume, { taskId: 'task' })).status
  ).toBe(403)
  expect(f.resume).toHaveBeenCalledOnce()
  expect(currentNasUser()).toBeUndefined()
})

it('does not let an in-flight old credential inherit a new approver after rotation', async () => {
  const f = await fixture()
  const old = await f.pair()
  let release!: (identity: NasIdentity) => void
  const waiting = new Promise<NasIdentity>((resolve) => {
    release = resolve
  })
  f.account.resolve.mockImplementationOnce(() => waiting)
  f.account.resolve.mockClear()
  const pending = f.rpc(old)
  await vi.waitFor(() => expect(f.account.resolve).toHaveBeenCalled())
  const next = await f.pair(bob)
  release(currentAccount(alice))
  expect((await pending).status).toBe(403)
  expect(f.seen).toEqual([])
  expect((await f.rpc(next)).status).toBe(200)
  expect(f.seen).toEqual([currentAccount(bob)])
  expect((await f.rpc(old)).status).toBe(401)
})

it('checks the account before every SSE event and closes a demoted account without leaking the next frame', async () => {
  const f = await fixture()
  const token = await f.pair()
  const response = await fetch(f.url('/mdxp/events'), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  await reader.read() // initial comment
  f.runtime().server.broadcastStreamEvent('fixture', { allowed: true })
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    'allowed'
  )
  f.account.resolve.mockResolvedValue(null)
  f.runtime().server.broadcastStreamEvent('fixture', { mustNotLeak: true })
  expect(await reader.read()).toMatchObject({ done: true })
  expect(f.account.resolve).toHaveBeenCalledTimes(4)
  const denied = await fetch(f.url('/mdxp/events'), {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(denied.status).toBe(401)
  await denied.text()
})

it('bounds queued SSE authorization work when the account authority stalls', async () => {
  const f = await fixture()
  const token = await f.pair()
  const response = await fetch(f.url('/mdxp/events'), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  })
  const reader = response.body!.getReader()
  await reader.read()
  let release!: (identity: NasIdentity) => void
  const waiting = new Promise<NasIdentity>((resolve) => {
    release = resolve
  })
  f.account.resolve.mockImplementation(() => waiting)
  try {
    f.runtime().server.broadcastStreamEvent('fixture', { first: true })
    await vi.waitFor(() => expect(f.account.resolve).toHaveBeenCalledTimes(3))
    for (let i = 0; i < 33; i++)
      f.runtime().server.broadcastStreamEvent('fixture', { i })
    expect(await reader.read()).toMatchObject({ done: true })
  } finally {
    release(currentAccount(alice))
  }
})

it.each(['operation', 'demoted', 'replaced', 'unavailable'])(
  'leaves a request pending when the approving identity is %s',
  async (failure) => {
    const f = await fixture()
    const request = await (
      await f.post('/mdxp/pair/request', { clientName: 'pending client' })
    ).json()
    if (failure === 'demoted')
      f.account.resolve.mockResolvedValue({ ...alice, administrator: false })
    if (failure === 'replaced')
      f.account.resolve.mockResolvedValue({ ...alice, username: 'replacement' })
    if (failure === 'unavailable')
      f.account.resolve.mockRejectedValue(new Error('offline'))
    const context = failure === 'operation' ? runAsNasUser : runAsNasGatewayUser
    await expect(
      context(alice, () =>
        f.runtime().bridgeCommandHandlers[BridgeCommands.ResolvePair]({
          kind: 'cli',
          requestId: request.requestId,
          decision: 'allow',
        })
      )
    ).rejects.toThrow()
    expect(
      await (
        await f.post('/mdxp/pair/poll', { requestId: request.requestId })
      ).json()
    ).toMatchObject({ status: 'pending' })
    if (failure === 'operation')
      expect(f.account.resolve).not.toHaveBeenCalled()
  }
)

it('persists the verified account generation and rejects credentials after it changes', async () => {
  const f = await fixture()
  const token = await f.pair()
  await f.restart()
  expect((await f.rpc(token)).status).toBe(200)
  f.account.resolve.mockResolvedValue({
    ...alice,
    accountRevision: 'fixture-generation-2',
  })
  expect((await f.rpc(token)).status).toBe(403)
  expect(f.seen).toEqual([currentAccount(alice)])
})
