import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from '@core/bridge/web-socket-message-stream'
import { createMdxpConnection } from '@motrix/mdxp'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import {
  type PairedClient,
  PairingService,
  type PairingStore,
} from './pairing-service'
import { WebSocketBridgeServer } from './web-socket-bridge-server'

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

const INITIALIZE_PARAMS = {
  protocolVersion: '1.0' as const,
  client: {
    kind: 'extension' as const,
    name: 'test',
    version: '1',
    extensionId: 'testext',
    browser: 'chromium' as const,
    browserVersion: '1',
    locale: 'en',
  },
  capabilities: {},
  adapters: [] as never[],
}

async function makeServer(): Promise<{
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
    onPairRequest: async () => ({ decision: 'allow', addToRegistry: false }),
    motrixVersion: '0.0.0-test',
    ffmpegAvailable: false,
    localToken: 'test-local-token',
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

function connectPair(port: number, nonce: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/pair?nonce=${nonce}&extensionId=testext&browser=chromium`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abcdefghabcdefghabcdefghabcdefgh' }
    )
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function mdxpOver(ws: WebSocket) {
  const conn = createMdxpConnection(
    new WebSocketMessageReader(ws as never),
    new WebSocketMessageWriter(ws as never)
  )
  conn.listen()
  return conn
}

describe('WebSocketBridgeServer control-plane authorization', () => {
  it('rejects a control-plane call on a /pair session before pairing approval', async () => {
    const { server, removeTask } = await makeServer()
    const port = await server.start('127.0.0.1', 0)
    try {
      const ws = await connectPair(port, server.issuePairNonce())
      const conn = mdxpOver(ws)

      // The malicious path: connect via /pair (one-shot nonce, no user
      // interaction) and drive task/remove WITHOUT sending motrix/initialize,
      // so the pairing dialog never even appears. This must be denied.
      const call = conn.sendRequest('task/remove', {
        taskId: 'task-1',
        deleteFiles: true,
      })
      // The security property under test: the call is refused for lack of
      // authorization and removeTask never runs. (The precise MDXP code does
      // not survive vscode-jsonrpc here — plain MdxpError objects are not
      // ResponseError instances — which is pre-existing bridge behavior; the
      // handler message is preserved and carries the reason.)
      await expect(call).rejects.toThrow(/not authorized/i)
      expect(removeTask).not.toHaveBeenCalled()

      conn.dispose()
      ws.terminate()
    } finally {
      await server.stop()
    }
  })

  it('allows control-plane calls once initialize approves the /pair session', async () => {
    const { server, removeTask } = await makeServer()
    const port = await server.start('127.0.0.1', 0)
    try {
      const ws = await connectPair(port, server.issuePairNonce())
      const conn = mdxpOver(ws)

      // Legitimate flow: initialize triggers the approval dialog (allow), which
      // authorizes the session. The same connection may then manage tasks.
      await conn.sendRequest('motrix/initialize', INITIALIZE_PARAMS)
      await conn.sendRequest('task/remove', {
        taskId: 'task-1',
        deleteFiles: false,
      })
      expect(removeTask).toHaveBeenCalledWith('task-1', { deleteFiles: false })

      conn.dispose()
      ws.terminate()
    } finally {
      await server.stop()
    }
  })
})
