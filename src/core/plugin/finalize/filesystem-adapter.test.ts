import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeFinalizeFilesystemAdapter } from './filesystem-adapter'

describe.runIf(process.platform !== 'win32')(
  'NativeFinalizeFilesystemAdapter process failures',
  () => {
    const roots: string[] = []

    afterEach(async () => {
      await Promise.all(
        roots
          .splice(0)
          .map((root) => rm(root, { recursive: true, force: true }))
      )
    })

    async function executable(source: string): Promise<string> {
      const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-sidecar-test-'))
      roots.push(root)
      const script = path.join(root, 'sidecar')
      await writeFile(script, `#!/bin/sh\n${source}\n`)
      await chmod(script, 0o700)
      return script
    }

    async function framedSidecar(): Promise<string> {
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'motrix-framed-sidecar-')
      )
      roots.push(root)
      const script = path.join(root, 'sidecar.cjs')
      await writeFile(
        script,
        `
        let incoming = Buffer.alloc(0)
        process.stdin.on('data', chunk => {
          incoming = Buffer.concat([incoming, chunk])
          while (incoming.length >= 4) {
            const size = incoming.readUInt32LE(0)
            if (incoming.length < size + 4) return
            const request = JSON.parse(incoming.subarray(4, size + 4).toString())
            incoming = incoming.subarray(size + 4)
            if (request.relative === 'crash') process.exit(23)
            const send = () => {
              const payload = Buffer.from(JSON.stringify({
                request_id: request.request_id, status: 'ok',
                handle: request.op === 'open_root' ? 1 : 2,
                platform: 'test', rename_no_replace: true, held_roots: true,
                directory_sync: true, held_artifacts: true,
              }))
              const frame = Buffer.alloc(payload.length + 4)
              frame.writeUInt32LE(payload.length)
              payload.copy(frame, 4)
              process.stdout.write(frame)
            }
            if (request.relative === 'slow') setTimeout(send, 1200)
            else send()
          }
        })
      `
      )
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      return executable(`exec ${quote(process.execPath)} ${quote(script)}`)
    }

    it('lets filesystem work exceed the handshake deadline and excludes queue time', async () => {
      const adapter = new NativeFinalizeFilesystemAdapter(await framedSidecar())
      try {
        await adapter.capabilities()
        const root = await adapter.openRoot(os.tmpdir())
        // Startup uses real time. Advance only the host request deadlines,
        // while the child deliberately keeps its filesystem response pending.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const artifact = adapter.openArtifact(root, 'slow')
        const queuedHandshake = adapter.capabilities()
        const assertions = Promise.all([
          expect(artifact).resolves.toMatchObject({ id: 2 }),
          expect(queuedHandshake).resolves.toMatchObject({
            heldArtifacts: true,
          }),
        ])
        await vi.advanceTimersByTimeAsync(30_001)
        await assertions
      } finally {
        vi.useRealTimers()
        await adapter.dispose()
      }
    }, 10_000)

    it('restarts for a later operation while rejecting handles from the failed child', async () => {
      const adapter = new NativeFinalizeFilesystemAdapter(await framedSidecar())
      try {
        await adapter.capabilities()
        const oldRoot = await adapter.openRoot(os.tmpdir())
        await expect(adapter.openArtifact(oldRoot, 'crash')).rejects.toThrow(
          'exited: 23'
        )
        await expect(adapter.capabilities()).resolves.toMatchObject({
          heldArtifacts: true,
        })
        const root = await adapter.openRoot(os.tmpdir())
        expect(root.id).toBe(oldRoot.id)
        await expect(adapter.syncRoot(oldRoot)).rejects.toMatchObject({
          code: 'invalid_handle',
        })
        await expect(adapter.syncRoot(root)).resolves.toBeUndefined()
      } finally {
        await adapter.dispose()
      }
      await expect(adapter.capabilities()).rejects.toThrow('disposed')
    })

    async function rejectedError(operation: Promise<unknown>): Promise<Error> {
      let caught: unknown
      try {
        await operation
      } catch (error) {
        caught = error
      }
      if (!(caught instanceof Error))
        throw new Error('operation did not reject')
      return caught
    }

    it('stays fail-closed after the sidecar exits', async () => {
      const adapter = new NativeFinalizeFilesystemAdapter(
        await executable('exit 23'),
        { requestTimeoutMs: 1_000 }
      )

      const first = await rejectedError(adapter.capabilities())
      expect(first).toBeInstanceOf(Error)
      const second = await rejectedError(
        adapter.openRoot(path.parse(process.cwd()).root)
      )
      expect(second).toBe(first)
      await adapter.dispose()
    })

    it('times out a wedged request and rejects later requests immediately', async () => {
      const adapter = new NativeFinalizeFilesystemAdapter(
        await executable('while :; do sleep 1; done'),
        { requestTimeoutMs: 50 }
      )

      const first = await rejectedError(adapter.capabilities())
      expect(first.message).toContain('timed out after 50ms')
      const second = await rejectedError(
        adapter.openRoot(path.parse(process.cwd()).root)
      )
      expect(second).toBe(first)
      await adapter.dispose()
    })
  }
)
