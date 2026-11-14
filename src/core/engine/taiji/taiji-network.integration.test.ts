import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventBus } from '@core/events/event-bus'
import { TaskStatus } from '@shared/types/task'
import { bundled, listen, start } from '@test-utils/taiji'
import { describe, expect, it } from 'vitest'
import { TaijiNetworkBridge } from './taiji-network-bridge'

describe.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'taiji network context (real daemon)',
  () => {
    it('clears actual system DNS cache through the shared host bridge and exports phase timings', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-network-context-')
      )
      const payload = Buffer.alloc(64 * 1024, 37)
      const server = createServer((request, response) => {
        response.writeHead(200, {
          'Content-Length': payload.length,
          Connection: 'close',
        })
        response.end(request.method === 'HEAD' ? undefined : payload)
      })
      let engine: Awaited<ReturnType<typeof start>> | undefined
      let bridge: TaijiNetworkBridge | undefined
      try {
        const port = await listen(server)
        engine = await start(directory)
        let network = 'before-vpn'
        bridge = new TaijiNetworkBridge({
          rpc: engine.rpc,
          eventBus: new EventBus(),
          isEngineReady: () => true,
          read: async () => ({ key: network, unavailable: [] }),
        })
        bridge.start()
        await bridge.refresh()
        const metrics = async () => {
          const response = await fetch(
            `http://127.0.0.1:${engine?.port}/metrics`
          )
          expect(response.ok).toBe(true)
          return new Map(
            (await response.text())
              .split('\n')
              .filter((line) => /^taiji_dns_\w+ [0-9.e+-]+$/.test(line))
              .map((line) => {
                const [name, value] = line.split(' ')
                return [name, Number(value)] as const
              })
          )
        }
        const download = async (filename: string) => {
          if (!engine) throw new Error('missing native engine')
          const gid = await engine.adapter.createDownload({
            uris: [`http://localhost:${port}/payload`],
            saveDir: directory,
            filename,
            connections: 1,
          })
          await expect
            .poll(
              async () => (await engine?.adapter.getTaskStatus(gid))?.status
            )
            .toBe(TaskStatus.Completed)
          expect(await readFile(path.join(directory, filename))).toEqual(
            payload
          )
        }
        await download('first.bin')
        await download('cached.bin')
        const before = await metrics()
        expect(before.get('taiji_dns_system_queries_total')).toBe(1)
        network = 'after-vpn'
        await bridge.refresh()
        await download('fresh.bin')
        const after = await metrics()
        expect(after.get('taiji_dns_system_queries_total')).toBe(2)
        expect(after.get('taiji_dns_network_changes_total')).toBe(2)
        expect(after.get('taiji_dns_system_queue_seconds_count')).toBe(2)
        expect(after.get('taiji_dns_system_lookup_seconds_count')).toBe(2)
        expect(after.get('taiji_dns_system_active')).toBe(0)
        expect(after.get('taiji_dns_system_queued')).toBe(0)
      } finally {
        await bridge?.stop()
        await engine?.close()
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
)
