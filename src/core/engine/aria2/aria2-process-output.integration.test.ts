// @vitest-environment node
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initLogger } from '@core/logger'
import { bundledAria2Exists, resolveBundledAria2 } from '@test-utils/aria2'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { Aria2ProcessManager } from './aria2-process-manager'

describe.runIf(bundledAria2Exists())('aria2 production diagnostics', () => {
  afterEach(() => initLogger(pino({ enabled: false })))

  it.each([403, 416, 429])(
    'records the original HTTP %s at the production log level',
    async (status) => {
      const records: Record<string, unknown>[] = []
      initLogger(
        pino(
          { level: 'info' },
          {
            write(line) {
              records.push(JSON.parse(line))
            },
          }
        )
      )
      const server = createServer((_request, response) => {
        response.writeHead(status, {
          'Content-Length': '0',
          'Set-Cookie': 'session=private-server-cookie',
        })
        response.end()
      })
      const root = await mkdtemp(
        path.join(tmpdir(), 'motrix-engine-diagnostic-')
      )
      const manager = new Aria2ProcessManager()
      try {
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address()
        if (!address || typeof address === 'string')
          throw new Error('missing HTTP port')
        const input = path.join(root, 'input.txt')
        await writeFile(
          input,
          `http://127.0.0.1:${address.port}/payload.bin?newToken=private-query-token\n`
        )
        const exited = new Promise<number | null>((resolve, reject) => {
          manager.onExit = (code) => resolve(code)
          manager.onError = reject
        })
        await manager.spawn(resolveBundledAria2(), [
          '--no-conf=true',
          '--max-tries=1',
          '--split=1',
          '--connect-timeout=2',
          '--timeout=2',
          '--summary-interval=0',
          '--enable-color=true',
          `--dir=${root}`,
          '--out=payload.bin',
          `--input-file=${input}`,
        ])
        expect(await exited).not.toBe(0)
        // Exit can precede the final pipe data; allow the process reader to drain.
        await expect
          .poll(() => records.some((record) => record.httpStatus === status))
          .toBe(true)
        expect(records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              level: 50,
              module: 'aria2',
              stream: 'stdout',
              aria2ErrorCode: 22,
              httpStatus: status,
            }),
          ])
        )
        const serialized = JSON.stringify(records)
        expect(serialized).not.toContain('private-query-token')
        expect(serialized).not.toContain('private-server-cookie')
        expect(serialized).not.toContain('\\u001b')
      } finally {
        await manager.gracefulStop(1000)
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    },
    10000
  )
})
