import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
