import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT'])(
  'drains an atomic write and coalesces repeated %s signals before exiting',
  async (signal) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'motrix-signal-test-')
    )
    const target = path.join(directory, 'settings.json')
    const shutdownModule = pathToFileURL(
      path.resolve('src/server/shutdown.ts')
    ).href
    const script = `
      import writeFileAtomic from 'write-file-atomic'
      import { setTimeout } from 'node:timers/promises'
      import { createServerExitCoordinator, registerServerExitSignals } from ${JSON.stringify(shutdownModule)}
      let drains = 0
      const requestExit = createServerExitCoordinator(async () => {
        drains++
        await writing
      }, (code) => {
        console.log(JSON.stringify({ code, drains }))
        process.exit(code)
      })
      registerServerExitSignals(requestExit)
      const writing = writeFileAtomic(${JSON.stringify(target)}, 'persisted', {
        tmpfileCreated: async () => {
          process.kill(process.pid, ${JSON.stringify(signal)})
          await setTimeout(20)
          process.kill(process.pid, ${JSON.stringify(signal)})
          await setTimeout(20)
        }
      })
      await writing
    `
    try {
      const result = await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
        stdout: string
        stderr: string
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--input-type=module', '--eval', script],
          {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
            killSignal: 'SIGKILL',
          }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.once('error', reject)
        child.once('close', (code, signal) =>
          resolve({ code, signal, stdout, stderr })
        )
      })
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null })
      expect(JSON.parse(result.stdout)).toEqual({ code: 0, drains: 1 })
      expect(await readFile(target, 'utf8')).toBe('persisted')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000
)
