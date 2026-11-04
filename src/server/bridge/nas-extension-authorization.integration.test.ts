import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  makeFakeDialogs,
  makeFakePairing,
  makeFakeRegistry,
} from '@core/bridge/__tests__/fakes'
import {
  initializeParams,
  mdxpOverChannel,
  pairAndExchange,
  reconnect,
} from '@core/bridge/__tests__/mbp1-client'
import type { AuthenticatedBridgeClient } from '@core/bridge/client-authorization'
import { Mbp1CredentialStore } from '@core/bridge/credential-store'
import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import { Methods, Notifications } from '@motrix/mdxp'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, expect, it, vi } from 'vitest'
import { NasClientAuthorization } from '../platform/nas/client-authorization'
import {
  currentNasApprover,
  currentNasUser,
  type NasIdentity,
} from '../platform/nas/identity'

const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
const origin = `chrome-extension://${extensionId}`
const alice: NasIdentity = {
  platform: 'fnos',
  userId: '1000',
  username: 'alice',
  administrator: true,
  accountRevision: 'generation-one',
}
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture() {
  const root = await mkdtemp('/tmp/motrix-nas-extension-')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const credentials = await Mbp1CredentialStore.load(
    path.join(root, 'credentials.json')
  )
  const dialogs = makeFakeDialogs()
  const references: AuthenticatedBridgeClient[] = []
  const accounts = {
    platform: 'fnos' as const,
    resolve: vi.fn(async (): Promise<NasIdentity | null> => alice),
  }
  // Controlled owner binding for this transport suite. Durable owner issuance
  // belongs to the separate NAS pairing flow, not to session adoption.
  const authorization = new NasClientAuthorization(
    {
      ownerOf(client) {
        references.push(client)
        if (client.credential.kind !== 'extension') return undefined
        const current = credentials.findForAuth(client.credential.credentialId)
        return current?.authorizationEpoch ===
          client.credential.authorizationEpoch
          ? alice
          : undefined
      },
    },
    accounts
  )
  const pause = vi.fn(async () => {
    expect(currentNasUser()).toEqual(alice)
    expect(currentNasApprover()).toBeUndefined()
  })
  const task = makeDownloadTask({ id: 'task', status: TaskStatus.Paused })
  const server = new WebSocketBridgeServer({
    pairing: makeFakePairing(),
    registry: makeFakeRegistry(),
    motrixVersion: '2.2.0',
    runtime: 'server',
    ffmpegAvailable: false,
    localToken: 'fixture-local',
    extensionAuthorization: authorization,
    instanceId: 'native-instance',
    serverGeneration: 'fixture-generation',
    appVersion: '2.2.0',
    credentials,
    isOfficialId: (_browser, id) => id === extensionId,
    queueMbp1Dialog: (request) => dialogs.queue(request),
  })
  server.registerWriteMethods({
    taskManager: { getById: () => task },
    pauseTask: pause,
    resumeTask: vi.fn(async () => {}),
    removeTask: vi.fn(async () => {}),
    createTask: vi.fn(async () => ({ taskId: task.id })),
    parseTorrentFileCount: async () => 1,
  })
  const port = await server.start('127.0.0.1', 0)
  cleanup.push(() => server.stop())
  const peer = await pairAndExchange({
    port,
    origin,
    browser: 'chromium',
    claimedExtensionId: extensionId,
    code: () => dialogs.latestCode(),
  })
  const connection = mdxpOverChannel(peer.wire, peer.channel)
  cleanup.push(async () => {
    connection.dispose()
    peer.wire.ws.close()
  })
  await connection.sendRequest(
    Methods.MotrixInitialize,
    initializeParams(extensionId)
  )
  const session = [...server.iterSessions()][0]
  expect(session).toBeDefined()
  return {
    server,
    credentials,
    accounts,
    pause,
    port,
    peer,
    connection,
    session,
    references,
  }
}

it('carries the exact authenticated credential and NAS account into extension task handlers', async () => {
  const f = await fixture()
  expect(
    await f.connection.sendRequest(Methods.TaskPause, { taskId: 'task' })
  ).toEqual({ ok: true })
  expect(f.pause).toHaveBeenCalledOnce()
  const credential = f.credentials.findForAuth(f.peer.credential.credentialId)!
  expect(f.references.length).toBeGreaterThan(0)
  expect(
    f.references.every(
      (entry) =>
        entry.credential.kind === 'extension' &&
        entry.credential.credentialId === credential.credentialId &&
        entry.credential.authorizationEpoch === credential.authorizationEpoch
    )
  ).toBe(true)
  expect(currentNasUser()).toBeUndefined()
})

it('rejects an inbound task operation after its NAS account is disabled', async () => {
  const f = await fixture()
  f.accounts.resolve.mockResolvedValue(null)
  const result = f.connection
    .sendRequest(Methods.TaskPause, { taskId: 'task' })
    .catch(() => 'closed')
  expect((await f.peer.wire.closed).code).toBe(1008)
  f.connection.dispose()
  expect(await result).toBe('closed')
  expect(f.pause).not.toHaveBeenCalled()
  expect([...f.server.iterSessions()]).toEqual([])
})

it('does not send an admitted operation result if the account is revoked while the handler is running', async () => {
  const f = await fixture()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  f.pause.mockImplementation(async () => {
    await waiting
  })
  const framesBefore = f.peer.wire.rawFrames.length
  const result = f.connection
    .sendRequest(Methods.TaskPause, { taskId: 'task' })
    .catch(() => 'closed')
  await vi.waitFor(() => expect(f.pause).toHaveBeenCalledOnce())
  f.accounts.resolve.mockResolvedValue(null)
  release()
  expect((await f.peer.wire.closed).code).toBe(1008)
  f.connection.dispose()
  expect(await result).toBe('closed')
  expect(f.peer.wire.rawFrames).toHaveLength(framesBefore)
})

it.each(['request', 'notification'] as const)(
  'checks outbound %s traffic before any private frame leaves the server',
  async (kind) => {
    const f = await fixture()
    const received = vi.fn()
    f.connection.onRequest(Methods.UrlProbe, async () => {
      received()
      return { handled: false }
    })
    f.connection.onNotification(Notifications.PairRevoked, received)
    const framesBefore = f.peer.wire.rawFrames.length
    f.accounts.resolve.mockResolvedValue({ ...alice, administrator: false })
    const result =
      kind === 'request'
        ? f.session.conn
            .sendRequest(Methods.UrlProbe, {
              url: 'https://example.test/private',
            })
            .catch(() => 'closed')
        : Promise.resolve(
            f.session.conn.sendNotification(Notifications.PairRevoked, {
              reason: 'user-revoked',
            })
          )
    expect((await f.peer.wire.closed).code).toBe(1008)
    await result
    expect(received).not.toHaveBeenCalled()
    expect(f.peer.wire.rawFrames).toHaveLength(framesBefore)
  }
)

it('rejects a disabled account before accepting a cryptographic reconnect', async () => {
  const f = await fixture()
  f.connection.dispose()
  f.peer.wire.ws.close()
  await f.peer.wire.closed
  f.accounts.resolve.mockResolvedValue(null)
  await expect(
    reconnect({
      port: f.port,
      origin,
      instanceId: 'native-instance',
      credential: f.peer.credential,
    })
  ).rejects.toThrow()
  expect([...f.server.iterSessions()]).toEqual([])
  expect(f.pause).not.toHaveBeenCalled()
})

it("cannot promote a disabled account's provisional credential and revoke its predecessor during reconnect", async () => {
  const f = await fixture()
  const predecessor = f.credentials.findForAuth(f.peer.credential.credentialId)!
  const offered = await f.credentials.offerProvisional(
    predecessor.principal,
    'official'
  )
  f.accounts.resolve.mockResolvedValue(null)
  await expect(
    reconnect({
      port: f.port,
      origin,
      instanceId: 'native-instance',
      credential: {
        ...f.peer.credential,
        credentialId: offered.credentialId,
        mutualKey: Buffer.from(offered.mutualKeyB64, 'base64url'),
      },
    })
  ).rejects.toThrow()
  expect(f.credentials.findForAuth(predecessor.credentialId)?.state).toBe(
    'committed'
  )
  expect(f.credentials.findForAuth(offered.credentialId)?.state).toBe(
    'provisional'
  )
})
