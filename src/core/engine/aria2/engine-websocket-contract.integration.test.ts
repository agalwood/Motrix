import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  spawnAria2ForTest,
} from '../../../test-utils/aria2'
import { Aria2RpcClient } from './aria2-rpc-client'
import { JsonRpcProtocol } from './json-rpc-protocol'
import { WebSocketTransport } from './web-socket-transport'

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'bundled aria2 WebSocket contract',
  () => {
    let baseDir: string
    let handle: Aria2Handle
    let rpc: Aria2RpcClient

    beforeAll(async () => {
      baseDir = mkdtempSync(path.join(tmpdir(), 'motrix-a2-ws-contract-'))
      handle = await spawnAria2ForTest({
        baseDir,
        waitForHttpRpc: false,
      })

      const transport = new WebSocketTransport()
      const protocol = new JsonRpcProtocol(transport, { timeoutMs: 5_000 })
      rpc = new Aria2RpcClient(transport, protocol, handle.secret)
      await rpc.connect(handle.port, 40, 250)

      // This is the first round trip EngineSupervisor performs after the
      // WebSocket upgrade. An open socket without this response is not ready.
      await expect(rpc.changeGlobalOption({ continue: 'true' })).resolves.toBe(
        'OK'
      )
    }, 20_000)

    afterAll(async () => {
      rpc?.disconnect()
      await handle?.kill()
      if (baseDir) rmSync(baseDir, { recursive: true, force: true })
    })

    it('returns sequential responses over one connection', async () => {
      for (let index = 0; index < 25; index += 1) {
        const version = await rpc.getVersion()
        expect(version.version).toMatch(/^\d+\.\d+\.\d+/)
      }
    })

    it('correlates parallel responses over one connection', async () => {
      const versions = await Promise.all(
        Array.from({ length: 16 }, () => rpc.getVersion())
      )
      expect(versions).toHaveLength(16)
      expect(new Set(versions.map((value) => value.version)).size).toBe(1)
    })
  }
)
