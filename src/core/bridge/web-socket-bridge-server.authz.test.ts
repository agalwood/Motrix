import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { type Mbp1TestWiring, makeMbp1TestWiring } from './__tests__/fakes'
import {
  initializeParams,
  mdxpOverChannel,
  pairAndExchange,
} from './__tests__/mbp1-client'
import {
  type PairedClient,
  PairingService,
  type PairingStore,
} from './pairing-service'
import { WebSocketBridgeServer } from './web-socket-bridge-server'

const EXTENSION_ID = 'authzextensionidaaaaaaaaaaaaaaaa'
const ORIGIN = `chrome-extension://${EXTENSION_ID}`

function makePairingStore(): PairingStore {
  let list: PairedClient[] = []
  return {
    async load() {
      return [...list]
    },
    async save(next) {
      list = [...next]
    },
  }
}

function makeRegistryStore() {
  let data: string | null = null
  return {
    async read() {
      return data
    },
    async write(s: string) {
      data = s
    },
  }
}

/** `mbp1: null` deliberately omits the six MBP1 options, which is how a shell
 *  that has not wired MBP1 yet is configured. */
async function makeServer(mbp1: Mbp1TestWiring | null): Promise<{
  server: WebSocketBridgeServer
  removeTask: ReturnType<typeof vi.fn>
}> {
  const pairing = new PairingService(makePairingStore())
  await pairing.load()
  const { TrustedExtensionRegistry } = await import(
    './trusted-extension-registry'
  )
  const registry = new TrustedExtensionRegistry(makeRegistryStore(), [])
  await registry.load()
  const server = new WebSocketBridgeServer({
    pairing,
    registry,
    motrixVersion: '0.0.0-test',
    runtime: 'electron',
    ffmpegAvailable: false,
    localToken: 'test-local-token',
    ...(mbp1 === null ? {} : mbp1.options),
  })
  const removeTask = vi.fn(async () => {})
  server.registerWriteMethods({
    taskManager: {
      getById: () =>
        makeDownloadTask({ id: 'task-1', status: TaskStatus.Completed }),
    },
    pauseTask: vi.fn(async () => {}),
    resumeTask: vi.fn(async () => {}),
    removeTask,
    createTask: vi.fn(async () => ({ taskId: 'unused' })),
    parseTorrentFileCount: vi.fn(async () => 1),
  })
  return { server, removeTask }
}

function openRaw(port: number, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${path}`,
      'motrix-bridge.v1',
      { origin: ORIGIN }
    )
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

describe('WebSocketBridgeServer control-plane authorization', () => {
  it('gives an unauthenticated peer no MDXP surface to drive at all', async () => {
    // The old attack was: upgrade via /pair (a one-shot nonce, no user
    // interaction), skip motrix/initialize so the approval dialog never
    // appears, and call task/remove on an unauthorized session. MBP1 moves the
    // whole gate below MDXP: /pair speaks the §6 handshake and nothing else, so
    // there is no unauthorized JSON-RPC session left to reach the dispatcher
    // from. With MBP1 unwired there is no extension WebSocket surface at all —
    // fail closed rather than fall back to an unauthenticated one.
    const { server, removeTask } = await makeServer(null)
    const port = await server.start('127.0.0.1', 0)
    try {
      await expect(openRaw(port, '/pair?nonce=whatever')).rejects.toThrow()
      await expect(openRaw(port, '/v1')).rejects.toThrow()
      expect(removeTask).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('authorizes a completed MBP1 session without any motrix/initialize', async () => {
    const mbp1 = await makeMbp1TestWiring([['chromium', EXTENSION_ID]])
    const { server, removeTask } = await makeServer(mbp1)
    const port = await server.start('127.0.0.1', 0)
    try {
      const paired = await pairAndExchange({
        port,
        origin: ORIGIN,
        browser: 'chromium',
        claimedExtensionId: EXTENSION_ID,
        code: () => mbp1.dialogs.latestCode(),
      })
      const conn = mdxpOverChannel(paired.wire, paired.channel)

      // No motrix/initialize first: authorization came from the transport, and
      // a handler that re-granted it would be the fail-open shape this replaces.
      await conn.sendRequest('task/remove', {
        taskId: 'task-1',
        deleteFiles: false,
      })
      expect(removeTask).toHaveBeenCalledWith('task-1', { deleteFiles: false })

      // The handshake assertion still runs, and still returns no pairToken.
      const result = await conn.sendRequest(
        'motrix/initialize',
        initializeParams(EXTENSION_ID)
      )
      expect(result.pairToken).toBeUndefined()

      conn.dispose()
      paired.wire.ws.close()
    } finally {
      await server.stop()
    }
  })
})
