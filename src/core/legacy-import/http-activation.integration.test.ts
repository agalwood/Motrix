// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { DirectResourceValidatorService } from '@core/task/direct-resource-validator'
import { legacyHttpActivationSchema } from '@shared/schemas/legacy-http-activation'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import { canResume } from '@shared/types/task-actions'
import {
  type Aria2Handle,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import {
  LEGACY_HTTP_COMPLETED,
  LEGACY_HTTP_TOTAL,
  legacyHttpActivationFixture,
} from '@test-utils/legacy-http-service'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyHttpActivationService } from './http-activation-service'
import { assertLegacyTaskNotActivated } from './legacy-task-policy'

const binaryPath = process.env.MOTRIX_LEGACY_CHECKPOINT_ENGINE
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function nativeFixture(
  options: {
    corruptRemote?: boolean
    redirectAfterVerification?: boolean
    changeAfterVerification?: boolean
    holdDownload?: boolean
  } = {}
) {
  const payload = Buffer.alloc(LEGACY_HTTP_TOTAL)
  for (let index = 0; index < payload.length; index++)
    payload[index] = index % 251
  if (options.corruptRemote) payload[LEGACY_HTTP_COMPLETED - 1] ^= 255
  let verified = false
  let redirectedRequests = 0
  let holdDownload = options.holdDownload
  const heldResponses = new Set<() => void>()
  const requests: Array<{
    phase: 'verify' | 'download'
    start: number
    end: number
    ifMatch?: string
    ranged: boolean
    cookie?: string
    encoding?: string
  }> = []
  const server = createServer((request, response) => {
    if (request.url === '/redirected.bin') redirectedRequests++
    const entityTag =
      verified && options.changeAfterVerification
        ? '"changed-fixture"'
        : '"legacy-fixture"'
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Number(match[2]) : LEGACY_HTTP_TOTAL - 1
    requests.push({
      phase: verified ? 'download' : 'verify',
      start,
      end,
      ifMatch: request.headers['if-match'],
      ranged: Boolean(match),
      cookie: request.headers.cookie,
      encoding: request.headers['accept-encoding'],
    })
    if (
      request.headers.cookie !== 'session=fixture-secret' ||
      request.headers['accept-encoding'] !== 'identity' ||
      (request.headers['if-match'] && request.headers['if-match'] !== entityTag)
    ) {
      response.writeHead(412).end()
      return
    }
    if (
      verified &&
      options.redirectAfterVerification &&
      request.url !== '/redirected.bin'
    ) {
      response.writeHead(302, { Location: '/redirected.bin' }).end()
      return
    }
    response.writeHead(match ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      ETag: entityTag,
      'Content-Length': end - start + 1,
      ...(match
        ? { 'Content-Range': `bytes ${start}-${end}/${LEGACY_HTTP_TOTAL}` }
        : {}),
    })
    if (verified && match && holdDownload) {
      const split = Math.min(start + 65536, end + 1)
      response.write(payload.subarray(start, split))
      const finish = () => response.end(payload.subarray(split, end + 1))
      heldResponses.add(finish)
      response.once('close', () => heldResponses.delete(finish))
    } else response.end(payload.subarray(start, end + 1))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No HTTP port')
  const verifier = new DirectResourceValidatorService(undefined, 10_000)
  const f = await legacyHttpActivationFixture({
    adapter: {} as EngineAdapter,
    uri: `http://127.0.0.1:${address.port}/partial.bin`,
    requestLines: ' header=Cookie: session=fixture-secret\n',
    verifier: {
      verifyLegacyContent: async (input) => {
        const result = await verifier.verifyLegacyContent(input)
        verified = true
        return result
      },
    },
  })
  cleanup.push(f.dispose)
  let handle: Aria2Handle | undefined
  let wired: Awaited<ReturnType<typeof connectAdapter>> | undefined
  const stop = async () => {
    wired?.disconnect()
    wired = undefined
    await handle?.kill()
    handle = undefined
  }
  cleanup.push(stop)
  const start = async () => {
    handle = await spawnAria2ForTest({
      baseDir: f.root,
      binaryPath,
      extraArgs: [
        '--enable-sqlite3-persistence=true',
        `--sqlite3-db-path=${path.join(f.root, 'engine.db')}`,
        '--force-save=true',
        '--pause=true',
        '--continue=false',
        '--split=1',
        '--max-connection-per-server=1',
        '--file-allocation=none',
        '--max-tries=1',
        '--user-agent=ambient-agent',
        '--http-accept-gzip=true',
      ],
    })
    wired = await connectAdapter(handle)
    f.deps.adapter = wired.adapter
    return wired
  }
  return {
    ...f,
    requests,
    payload,
    start,
    stop,
    crash: async () => {
      wired?.disconnect()
      wired = undefined
      const proc = handle?.proc
      if (proc && proc.exitCode === null && proc.signalCode === null)
        await new Promise<void>((resolve) => {
          proc.once('exit', () => resolve())
          proc.kill('SIGKILL')
        })
      handle = undefined
    },
    releaseDownload: () => {
      holdDownload = false
      for (const finish of heldResponses) finish()
      heldResponses.clear()
    },
    redirectedRequests: () => redirectedRequests,
  }
}
async function progressed(adapter: EngineAdapter, gid: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const task = await adapter.getTaskStatus(gid)
    if (task && task.downloadedBytes > LEGACY_HTTP_COMPLETED) return task
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Native first unpause did not retain new bytes')
}
async function completed(adapter: EngineAdapter, gid: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const task = await adapter.getTaskStatus(gid)
    if (
      task?.status === TaskStatus.Completed ||
      task?.status === TaskStatus.Error
    )
      return task
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('HTTP checkpoint continuation timed out')
}

describe.skipIf(!binaryPath)('real native HTTP migration activation', () => {
  it('compares all old bytes, then downloads only missing ranges into the original file', async () => {
    const f = await nativeFixture()
    const { adapter } = await f.start()
    await f.service.activate(f.taskId, async () => f.downloads)
    const intent = legacyHttpActivationSchema.parse(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    )
    const task = await completed(adapter, intent.engineTaskId)
    expect(
      task.status,
      JSON.stringify({ error: task.errorMessage, requests: f.requests })
    ).toBe(TaskStatus.Completed)
    expect(task.totalBytes).toBe(LEGACY_HTTP_TOTAL)
    const completedBinding = await adapter.verifyLegacyHttpBinding({
      engineTaskId: intent.engineTaskId,
      saveDir: intent.saveDir,
      targetPath: intent.targetPath,
      uri: task.uris[0],
      expected: intent.expected,
      entityTag: intent.resourceValidator.value,
      fileIdentity: {
        device: intent.files[0].identity.device,
        inode: intent.files[0].identity.inode,
      },
    })
    expect(completedBinding).toBe(true)
    expect(
      f.requests
        .filter((request) => request.phase === 'verify')
        .reduce((sum, request) => sum + request.end - request.start + 1, 0)
    ).toBe(LEGACY_HTTP_COMPLETED + 1)
    const downloads = f.requests.filter(
      (request) => request.phase === 'download' && request.ranged
    )
    // Native aria2 may first obtain the length through one GET, then applies
    // the imported checkpoint to its actual transfer ranges.
    expect(
      f.requests.filter(
        (request) => request.phase === 'download' && !request.ranged
      ).length
    ).toBeLessThanOrEqual(1)
    expect(
      f.requests
        .filter((request) => request.phase === 'download')
        .every(
          (request) =>
            request.ifMatch === '"legacy-fixture"' &&
            request.encoding === 'identity' &&
            request.cookie === 'session=fixture-secret'
        )
    ).toBe(true)
    expect(downloads.length).toBeGreaterThan(0)
    expect(
      downloads.every(
        (request) =>
          request.start >= LEGACY_HTTP_COMPLETED &&
          request.ifMatch === '"legacy-fixture"'
      )
    ).toBe(true)
    expect(
      downloads.reduce(
        (sum, request) => sum + request.end - request.start + 1,
        0
      )
    ).toBe(LEGACY_HTTP_TOTAL - LEGACY_HTTP_COMPLETED)
    expect(
      createHash('sha256')
        .update(await readFile(f.target))
        .digest('hex')
    ).toBe(createHash('sha256').update(f.payload).digest('hex'))
    expect(await readFile(`${f.target}.aria2`)).toEqual(f.control)
    expect(
      await adapter.reconcileLegacyCheckpoint?.({
        token: intent.token,
        targetPath: f.target,
      })
    ).toMatchObject({ status: 'consumed' })
    expect(JSON.stringify(f.db.getTask(f.taskId))).not.toContain(
      'fixture-secret'
    )
  }, 30_000)

  it('recovers a lost create response across native restart without automatic network activity', async () => {
    const f = await nativeFixture()
    let wired = await f.start()
    const create = wired.adapter.createDownload.bind(wired.adapter)
    wired.adapter.createDownload = async (input) => {
      await create(input)
      throw new Error('Lost create response')
    }
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Lost create response')
    const before = f.requests.length
    await wired.rpc.saveSession()
    await f.stop()
    wired = await f.start()
    const recovered = new LegacyHttpActivationService(f.deps)
    await recovered.recover()
    expect(f.requests).toHaveLength(before)
    const intent = legacyHttpActivationSchema.parse(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    )
    expect(intent.stage).toBe('bound')
    const boundTask = f.taskManager.getById(f.taskId) as DownloadTask
    expect(canResume(boundTask)).toBe(false)
    expect(() => assertLegacyTaskNotActivated(boundTask)).toThrow(
      'legacyImport.activationRequired'
    )
    expect(
      (await wired.adapter.getTaskStatus(intent.engineTaskId))?.status
    ).toBe(TaskStatus.Paused)
    await recovered.activate(f.taskId, async () => f.downloads)
    expect((await completed(wired.adapter, intent.engineTaskId)).status).toBe(
      TaskStatus.Completed
    )
    expect(
      f.requests
        .filter((request) => request.phase === 'download' && request.ranged)
        .every((request) => request.start >= LEGACY_HTTP_COMPLETED)
    ).toBe(true)
    expect((await readFile(f.target)).equals(f.payload)).toBe(true)
  }, 30_000)

  it.each(['response', 'persist'] as const)(
    'recovers native completion after losing the first-resume %s',
    async (lost) => {
      const f = await nativeFixture()
      const { adapter } = await f.start()
      const resume = adapter.resumeTask.bind(adapter)
      const resumeSpy = vi
        .spyOn(adapter, 'resumeTask')
        .mockImplementation(async (gid) => {
          expect(
            f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
          ).toMatchObject({ stage: 'resume-uncertain' })
          await resume(gid)
          expect((await completed(adapter, gid)).status).toBe(
            TaskStatus.Completed
          )
          if (lost === 'response') throw new Error('Lost resume response')
        })
      const save = f.db.saveTaskWithInstances.bind(f.db)
      const saveSpy = vi
        .spyOn(f.db, 'saveTaskWithInstances')
        .mockImplementation((pair) => {
          if (
            lost === 'persist' &&
            (
              pair.instances[0].payload.legacyHttpActivation as {
                stage: string
              }
            ).stage === 'active'
          )
            throw new Error('Lost active save')
          return save(pair)
        })
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow(
        lost === 'response' ? 'Lost resume response' : 'Lost active save'
      )
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({ stage: 'resume-uncertain' })
      saveSpy.mockImplementation(save)
      const requests = f.requests.length
      const recovered = new LegacyHttpActivationService(f.deps)
      await recovered.recover()
      expect(f.requests).toHaveLength(requests)
      expect(resumeSpy).toHaveBeenCalledTimes(1)
      expect(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      ).toMatchObject({ stage: 'active' })
      expect((await readFile(f.target)).equals(f.payload)).toBe(true)
    },
    30_000
  )

  it('recovers persisted native progress after a crash with an uncertain first unpause', async () => {
    const f = await nativeFixture({ holdDownload: true })
    let wired = await f.start()
    const resume = wired.adapter.resumeTask.bind(wired.adapter)
    wired.adapter.resumeTask = async (gid) => {
      await resume(gid)
      await progressed(wired.adapter, gid)
      throw new Error('Lost resume response')
    }
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Lost resume response')
    await wired.rpc.saveSession()
    await f.crash()
    const requests = f.requests.length
    wired = await f.start()
    const recovered = new LegacyHttpActivationService(f.deps)
    await recovered.recover()
    expect(f.requests).toHaveLength(requests)
    const intent = legacyHttpActivationSchema.parse(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    )
    expect(intent.stage).toBe('active')
    expect(
      (await wired.adapter.getTaskStatus(intent.engineTaskId))?.status
    ).toBe(TaskStatus.Paused)
    expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
      true
    )
    f.releaseDownload()
    await wired.adapter.resumeTask(intent.engineTaskId)
    expect((await completed(wired.adapter, intent.engineTaskId)).status).toBe(
      TaskStatus.Completed
    )
    expect((await readFile(f.target)).equals(f.payload)).toBe(true)
    expect(
      f.requests
        .filter((request) => request.phase === 'verify')
        .reduce((sum, request) => sum + request.end - request.start + 1, 0)
    ).toBe(LEGACY_HTTP_COMPLETED + 1)
    expect(
      f.requests
        .filter((request) => request.phase === 'download' && request.ranged)
        .every((request) => request.start >= LEGACY_HTTP_COMPLETED)
    ).toBe(true)
  }, 30_000)

  it.each([false, true])(
    'keeps native progress paused after first-unpause cancellation with a lost response: %s',
    async (lostResponse) => {
      const f = await nativeFixture({ holdDownload: true })
      const { adapter } = await f.start()
      const resume = adapter.resumeTask.bind(adapter)
      const resumeSpy = vi
        .spyOn(adapter, 'resumeTask')
        .mockImplementationOnce(async (gid) => {
          await resume(gid)
          await progressed(adapter, gid)
          f.service.cancel(f.taskId)
          if (lostResponse) throw new Error('Lost resume response')
        })
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('httpVerificationCancelled')
      const uncertain = legacyHttpActivationSchema.parse(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      )
      expect(uncertain.stage).toBe('resume-uncertain')
      expect(
        (await adapter.getTaskStatus(uncertain.engineTaskId))?.status
      ).toBe(TaskStatus.Paused)
      const requests = f.requests.length
      const recovered = new LegacyHttpActivationService(f.deps)
      await recovered.recover()
      expect(f.requests).toHaveLength(requests)
      expect(resumeSpy).toHaveBeenCalledTimes(1)
      expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
        true
      )
      f.releaseDownload()
      await adapter.resumeTask(uncertain.engineTaskId)
      expect((await completed(adapter, uncertain.engineTaskId)).status).toBe(
        TaskStatus.Completed
      )
      expect((await readFile(f.target)).equals(f.payload)).toBe(true)
    },
    30_000
  )

  it('quarantines same-inode edits to old bytes despite a valid native binding and real progress', async () => {
    const f = await nativeFixture({ holdDownload: true })
    const { adapter } = await f.start()
    const resume = adapter.resumeTask.bind(adapter)
    const resumeSpy = vi
      .spyOn(adapter, 'resumeTask')
      .mockImplementationOnce(async (gid) => {
        await resume(gid)
        await progressed(adapter, gid)
        await adapter.pauseTask(gid)
        throw new Error('Lost resume response')
      })
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('Lost resume response')
    const intent = legacyHttpActivationSchema.parse(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    )
    const bytes = await readFile(f.target)
    bytes[LEGACY_HTTP_COMPLETED - 1] ^= 255
    await writeFile(f.target, bytes)
    expect(
      await adapter.verifyLegacyHttpBinding?.({
        engineTaskId: intent.engineTaskId,
        saveDir: intent.saveDir,
        targetPath: intent.targetPath,
        uri: f.db.getTask(f.taskId)!.instances[0].uris[0],
        expected: intent.expected,
        entityTag: intent.resourceValidator.value,
        fileIdentity: intent.files[0].identity,
      })
    ).toBe(true)
    const requests = f.requests.length
    const recovered = new LegacyHttpActivationService(f.deps)
    await recovered.recover()
    expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
      false
    )
    await expect(
      recovered.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('changedSource')
    expect(f.requests).toHaveLength(requests)
    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(await readFile(f.target)).toEqual(bytes)
  }, 30_000)

  it.each(['initial', 'retry-lost-pause-response'] as const)(
    'pauses the native owner when cancelling during %s final persistence',
    async (attempt) => {
      const f = await nativeFixture({ holdDownload: true })
      const { adapter } = await f.start()
      let service = f.service
      if (attempt === 'retry-lost-pause-response') {
        const create = adapter.createDownload.bind(adapter)
        vi.spyOn(adapter, 'createDownload').mockImplementationOnce(
          async (input) => {
            await create(input)
            throw new Error('Lost create response')
          }
        )
        await expect(
          service.activate(f.taskId, async () => f.downloads)
        ).rejects.toThrow('Lost create response')
        service = new LegacyHttpActivationService(f.deps)
        await service.recover()
        const pause = adapter.pauseTask.bind(adapter)
        vi.spyOn(adapter, 'pauseTask').mockImplementationOnce(async (gid) => {
          await pause(gid)
          throw new Error('Lost pause response')
        })
      }
      let resumed = false
      let reached = () => {}
      let release = () => {}
      const entered = new Promise<void>((resolve) => {
        reached = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const resume = adapter.resumeTask.bind(adapter)
      vi.spyOn(adapter, 'resumeTask').mockImplementationOnce(async (gid) => {
        await resume(gid)
        await progressed(adapter, gid)
        resumed = true
      })
      f.deps.runExclusivePersistence = async (operation) => {
        if (resumed) {
          reached()
          await held
        }
        return operation()
      }
      const activation = service.activate(f.taskId, async () => f.downloads)
      await entered
      service.cancel(f.taskId)
      release()
      await expect(activation).rejects.toThrow('httpVerificationCancelled')
      const intent = legacyHttpActivationSchema.parse(
        f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
      )
      expect(intent.stage).toBe('active')
      expect((await adapter.getTaskStatus(intent.engineTaskId))?.status).toBe(
        TaskStatus.Paused
      )
      expect(
        (await readFile(f.target)).subarray(0, LEGACY_HTTP_COMPLETED)
      ).toEqual(f.payload.subarray(0, LEGACY_HTTP_COMPLETED))
      f.releaseDownload()
      await adapter.resumeTask(intent.engineTaskId)
      expect((await completed(adapter, intent.engineTaskId)).status).toBe(
        TaskStatus.Completed
      )
      expect((await readFile(f.target)).equals(f.payload)).toBe(true)
    },
    30_000
  )

  it.each(['changed-profile', 'missing-profile', 'wrong-binding'] as const)(
    'stops only the proven uncertain owner before an explicit retry with %s',
    async (invalid) => {
      const f = await nativeFixture({ holdDownload: true })
      const { adapter } = await f.start()
      const resume = adapter.resumeTask.bind(adapter)
      const resumeSpy = vi
        .spyOn(adapter, 'resumeTask')
        .mockImplementationOnce(async (gid) => {
          await resume(gid)
          await progressed(adapter, gid)
          throw new Error('Lost resume response')
        })
      const pauseSpy = vi.spyOn(adapter, 'pauseTask')
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow('Lost resume response')
      const pair = f.db.getTask(f.taskId)
      if (!pair) throw new Error('Missing migrated task')
      const intent = legacyHttpActivationSchema.parse(
        pair.instances[0].payload.legacyHttpActivation
      )
      expect(intent.stage).toBe('resume-uncertain')
      if (invalid === 'missing-profile')
        await rm(path.join(f.profile, 'system.json'))
      else
        await writeFile(
          path.join(f.profile, 'system.json'),
          JSON.stringify({ changed: true })
        )
      if (invalid === 'wrong-binding') {
        pair.instances[0].uris[0] += '?different-source'
        intent.uriDigest = createHash('sha256')
          .update(pair.instances[0].uris[0])
          .digest('hex')
        pair.instances[0].payload.legacyHttpActivation = intent
        f.db.saveTaskWithInstances(pair)
      }
      const requests = f.requests.length
      await expect(
        f.service.activate(f.taskId, async () => f.downloads)
      ).rejects.toThrow(
        invalid === 'wrong-binding' ? 'activationUncertain' : 'changedSource'
      )
      expect(pauseSpy).toHaveBeenCalledTimes(
        invalid === 'wrong-binding' ? 0 : 1
      )
      expect((await adapter.getTaskStatus(intent.engineTaskId))?.status).toBe(
        invalid === 'wrong-binding' ? TaskStatus.Downloading : TaskStatus.Paused
      )
      expect(canResume(f.taskManager.getById(f.taskId) as DownloadTask)).toBe(
        false
      )
      expect(resumeSpy).toHaveBeenCalledTimes(1)
      expect(f.requests).toHaveLength(requests)
      expect(
        (await readFile(f.target)).subarray(0, LEGACY_HTTP_COMPLETED)
      ).toEqual(f.payload.subarray(0, LEGACY_HTTP_COMPLETED))
    },
    30_000
  )

  it('refuses a redirect introduced after verification without requesting its target or altering old data', async () => {
    const f = await nativeFixture({ redirectAfterVerification: true })
    const { adapter } = await f.start()
    const original = await readFile(f.target)
    await f.service.activate(f.taskId, async () => f.downloads)
    const intent = legacyHttpActivationSchema.parse(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    )
    const task = await completed(adapter, intent.engineTaskId)
    expect(task.status).toBe(TaskStatus.Error)
    expect(f.requests.some((request) => request.phase === 'download')).toBe(
      true
    )
    expect(f.redirectedRequests()).toBe(0)
    expect((await readFile(f.target)).equals(original)).toBe(true)
    expect(await readFile(`${f.target}.aria2`)).toEqual(f.control)
  }, 30_000)

  it('fails a post-verification ETag change with 412 and preserves all old bytes', async () => {
    const f = await nativeFixture({ changeAfterVerification: true })
    const { adapter } = await f.start()
    const original = await readFile(f.target)
    await f.service.activate(f.taskId, async () => f.downloads)
    const intent = legacyHttpActivationSchema.parse(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    )
    const task = await completed(adapter, intent.engineTaskId)
    expect(task.status).toBe(TaskStatus.Error)
    expect(task.errorMessage).toContain('412')
    const downloads = f.requests.filter(
      (request) => request.phase === 'download'
    )
    expect(downloads.length).toBeGreaterThan(0)
    expect(
      downloads.every((request) => request.ifMatch === '"legacy-fixture"')
    ).toBe(true)
    expect((await readFile(f.target)).equals(original)).toBe(true)
    expect(await readFile(`${f.target}.aria2`)).toEqual(f.control)
  }, 30_000)

  it('rejects a mismatch in the last old byte without importing or creating a native task', async () => {
    const f = await nativeFixture({ corruptRemote: true })
    const { adapter } = await f.start()
    const original = await readFile(f.target)
    await expect(
      f.service.activate(f.taskId, async () => f.downloads)
    ).rejects.toThrow('httpContentChanged')
    expect(
      f.db.getTask(f.taskId)?.instances[0].payload.legacyHttpActivation
    ).toBeUndefined()
    expect(await adapter.listActiveAndWaiting()).toEqual([])
    expect((await readFile(f.target)).equals(original)).toBe(true)
    expect(await readFile(`${f.target}.aria2`)).toEqual(f.control)
  }, 30_000)
})
