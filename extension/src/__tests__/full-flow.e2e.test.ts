// @vitest-environment node
// Runs over a real ws server using Node's global WebSocket (undici). jsdom
// replaces the global Event class, which clashes with undici's native Event
// on dispatch ("must be an instance of Event. Received an instance of Event"),
// so this full-flow e2e suite must run in the node environment, not jsdom.
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws'
import {
  ConnectionManager,
  type ConnectionManagerOptions,
} from '@/background/ConnectionManager'
import { EndpointConfigStore } from '@/background/EndpointConfigStore'
import { WebSocketClient } from '@/background/WebSocketClient'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const CLIENT_INFO: ConnectionManagerOptions['clientInfo'] = {
  name: 'motrix-extension',
  version: '0.1.0',
  extensionId: 'abc',
  browser: 'chromium',
  browserVersion: 'jsdom-e2e',
  locale: 'en',
}

/**
 * Mock Motrix bridge that:
 *   - Responds to `motrix/initialize` with a fake server descriptor.
 *   - After we observe `motrix/initialized`, fires url/probe and then
 *     url/resolve requests AT the ext and collects the replies.
 */

/** A remote endpoint pointed at the mock bridge. */
async function makeRemoteEndpoint(port: number): Promise<{
  endpointConfigStore: EndpointConfigStore
}> {
  const endpointConfigStore = new EndpointConfigStore()
  await endpointConfigStore.setForTest({
    version: 3,
    activeEndpointId: 'e2e',
    servers: [
      {
        id: 'e2e',
        name: 'E2E',
        url: `wss://127.0.0.1:${port}`,
        revision: 0,
        state: 'ready',
      },
    ],
    cleanupTombstones: [],
  })
  return { endpointConfigStore }
}

async function startMockBridge(): Promise<{
  port: number
  awaitInitialized: () => Promise<unknown>
  connectionSeen: () => boolean
  sendProbe: (url: string) => Promise<{ handled: boolean; adapterId?: string }>
  sendResolve: (url: string) => Promise<unknown>
  close: () => Promise<void>
}> {
  let activeSocket: WsWebSocket | null = null
  let connected = false
  let initializedResolve!: (params: unknown) => void
  const initializedPromise = new Promise<unknown>((r) => {
    initializedResolve = r
  })
  const pending = new Map<
    string,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >()
  let nextId = 1

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })

  wss.on('connection', (ws: WsWebSocket) => {
    connected = true
    activeSocket = ws
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8')) as {
        id?: string | number
        method?: string
        params?: unknown
        result?: unknown
        error?: unknown
      }

      if (msg.method === 'motrix/initialize' && msg.id !== undefined) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '1.0',
              server: { name: 'motrix', version: '2.0', runtime: 'electron' },
              capabilities: {
                ffmpegAvailable: true,
                selectionKinds: ['direct'],
                progress: true,
                cancellation: true,
              },
              serverAdapters: [],
            },
          })
        )
        return
      }
      if (msg.method === 'motrix/initialized') {
        initializedResolve(msg.params)
        return
      }
      // Response to a server-initiated request
      if (
        msg.id !== undefined &&
        (msg.result !== undefined || msg.error !== undefined)
      ) {
        const entry = pending.get(String(msg.id))
        if (entry) {
          pending.delete(String(msg.id))
          if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
          else entry.resolve(msg.result)
        }
      }
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as AddressInfo).port

  async function call(method: string, params: unknown): Promise<unknown> {
    if (!activeSocket) throw new Error('no active client socket')
    const id = String(nextId++)
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    activeSocket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return await result
  }

  return {
    port,
    awaitInitialized: () => initializedPromise,
    connectionSeen: () => connected,
    sendProbe: (url: string) =>
      call('url/probe', { url }) as Promise<{
        handled: boolean
        adapterId?: string
      }>,
    sendResolve: (url: string) => call('url/resolve', { url }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.clients.forEach((c) => {
          c.close()
        })
        wss.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

beforeEach(() => {
  let backing: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const key = Array.isArray(k) ? k[0] : k
    return key && key in backing ? { [key]: backing[key] } : {}
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    const keys = Array.isArray(k) ? k : [k]
    for (const key of keys) delete backing[key]
  })
})

describe('remote compatibility e2e — no legacy socket fallback', () => {
  let bridge: Awaited<ReturnType<typeof startMockBridge>>

  beforeEach(async () => {
    bridge = await startMockBridge()
  })
  afterEach(async () => {
    await bridge.close()
  })

  it('does not connect a remote backend before remote MBP1 is enabled', async () => {
    const { endpointConfigStore } = await makeRemoteEndpoint(bridge.port)
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      client: new WebSocketClient(),
      endpointConfigStore,
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(bridge.connectionSeen()).toBe(false)

    mgr.stop()
  })

  it('does not initialize or expose application handlers on remote rejection', async () => {
    const { endpointConfigStore } = await makeRemoteEndpoint(bridge.port)
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      client: new WebSocketClient(),
      endpointConfigStore,
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(bridge.connectionSeen()).toBe(false)

    mgr.stop()
  })
})
