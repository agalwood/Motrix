import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskStatus } from '@shared/types/task'
import { bundled, listen, start } from '@test-utils/taiji'
import { describe, expect, it } from 'vitest'

type Engine = Awaited<ReturnType<typeof start>>
async function output(engine: Engine, gid: string, state: string) {
  for (let n = 0; n < 200; n++) {
    const value = await engine.adapter.getHttpOutput(gid)
    if (value.state === state) return value
    await delay(25)
  }
  throw new Error(`HTTP ${gid} did not reach ${state}`)
}

describe.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'native HTTP publication',
  () => {
    it.each([0, 131072, 3 * 1024 * 1024])(
      'publishes %i bytes, preserves a same-size foreign target and releases the payload slot',
      async (length) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'motrix-output-'))
        const payload = Buffer.alloc(length, 42)
        const server = createServer((request, response) => {
          const range =
            length >= 3 * 1024 * 1024
              ? request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
              : undefined
          const first = range ? Number(range[1]) : 0
          const last = range?.[2] ? Number(range[2]) : length - 1
          const body = payload.subarray(first, last + 1)
          response.writeHead(range ? 206 : 200, {
            'Content-Length': body.length,
            'Accept-Ranges': 'bytes',
            ETag: '"fixture"',
            ...(range
              ? { 'Content-Range': `bytes ${first}-${last}/${length}` }
              : {}),
          })
          response.end(request.method === 'HEAD' ? undefined : body)
        })
        let engine: Engine | undefined
        try {
          const port = await listen(server)
          engine = await start(directory)
          await engine.rpc.changeGlobalOption({
            'max-concurrent-downloads': '1',
          })
          const ready: string[] = []
          engine.adapter.onDownloadComplete((gid) => ready.push(gid))
          const add = (filename: string) =>
            engine!.adapter.createDownload({
              uris: [`http://127.0.0.1:${port}/file`],
              saveDir: directory,
              filename,
              deferFilePublication: true,
            })
          const first = await add('first.bin')
          const second = await add('second.bin')
          const firstOutput = await output(engine, first, 'ready')
          await output(engine, second, 'ready')
          expect(ready).toEqual(expect.arrayContaining([first, second]))
          expect((await engine.adapter.getTaskStatus(first))?.status).toBe(
            TaskStatus.Finalizing
          )
          expect(firstOutput.sourcePath).toBe(
            path.join(directory, 'first.bin.motrix')
          )
          expect(await readFile(firstOutput.sourcePath!)).toEqual(payload)
          const foreign = Buffer.alloc(length, 99)
          await writeFile(path.join(directory, 'first.bin'), foreign)
          await engine.adapter.finalizeHttpOutput(first, 'publish')
          const published = await output(engine, first, 'published')
          expect(published.finalPath).not.toBe(
            path.join(directory, 'first.bin')
          )
          expect(await readFile(published.finalPath!)).toEqual(payload)
          expect(await readFile(path.join(directory, 'first.bin'))).toEqual(
            foreign
          )
          expect(existsSync(firstOutput.sourcePath!)).toBe(false)
          // Native completion cannot make the logical host task complete before its DB commit.
          expect((await engine.adapter.getTaskStatus(first))?.status).toBe(
            TaskStatus.Finalizing
          )
          await engine.adapter.finalizeHttpOutput(second, 'publish')
          await output(engine, second, 'published')
        } finally {
          await engine?.close()
          await new Promise<void>((resolve) => server.close(() => resolve()))
          await rm(directory, { recursive: true, force: true })
        }
      }
    )

    it('replays ready and accepted publication after crashes without a single additional HTTP request', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-output-crash-')
      )
      const payload = Buffer.alloc(256 * 1024, 71)
      let requests = 0
      const server = createServer((_request, response) => {
        requests++
        response.end(payload)
      })
      let engine: Engine | undefined
      try {
        const port = await listen(server)
        engine = await start(directory)
        const gid = await engine.adapter.createDownload({
          uris: [`http://127.0.0.1:${port}/file`],
          saveDir: directory,
          filename: `${'长'.repeat(83)}.bin`,
          deferFilePublication: true,
        })
        const ready = await output(engine, gid, 'ready')
        const count = requests
        const crash = async () => {
          const exited = once(engine!.child, 'exit')
          engine!.child.kill('SIGKILL')
          await exited
          await engine!.close()
          engine = await start(directory)
        }
        await crash()
        expect((await output(engine!, gid, 'ready')).sourcePath).toBe(
          ready.sourcePath
        )
        expect(requests).toBe(count)
        await engine!.adapter.finalizeHttpOutput(gid, 'publish')
        await crash()
        const published = await output(engine!, gid, 'published')
        expect(await readFile(published.finalPath!)).toEqual(payload)
        expect(requests).toBe(count)
      } finally {
        await engine?.close()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
)

it
  .skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))
  .each(['retry', 'remove'] as const)(
  'handles current-format publication during %s',
  async (operation) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'motrix-publication-'))
    const payload = Buffer.from('complete current output')
    let requests = 0
    const server = createServer((_request, response) => {
      requests++
      response.end(payload)
    })
    let engine: Engine | undefined
    try {
      const port = await listen(server)
      engine = await start(directory)
      const gid = await engine.adapter.createDownload({
        uris: [`http://127.0.0.1:${port}/file`],
        saveDir: directory,
        filename: 'file.bin',
        deferFilePublication: true,
      })
      const ready = await output(engine, gid, 'ready')
      const count = requests
      if (operation === 'retry') {
        const offline = path.join(directory, 'offline')
        await rename(ready.sourcePath!, offline)
        await engine.adapter.finalizeHttpOutput(gid, 'publish')
        await output(engine, gid, 'publishing')
        expect(existsSync(ready.finalPath!)).toBe(false)
        await rename(offline, ready.sourcePath!)
        const published = await output(engine, gid, 'published')
        expect(await readFile(published.finalPath!)).toEqual(payload)
        expect(requests).toBe(count)
      } else {
        const foreign = Buffer.alloc(payload.length, 99)
        await writeFile(ready.finalPath!, foreign)
        await engine.adapter.finalizeHttpOutput(gid, 'publish')
        const held = await engine.adapter.holdHttpOutput(gid)
        const owned =
          held.state === 'published' ? held.finalPath! : held.sourcePath!
        expect(await readFile(owned)).toEqual(payload)
        await engine.adapter.forceRemoveTask(gid).catch(async () => {
          await engine!.adapter.removeDownloadResult(gid)
        })
        await engine.adapter.removeDownloadResult(gid)
        await rm(owned)
        await delay(100)
        expect(existsSync(ready.sourcePath!)).toBe(false)
        expect(await readFile(ready.finalPath!)).toEqual(foreign)
      }
    } finally {
      await engine?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }
)
