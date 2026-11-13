import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Commands } from '@shared/protocol/commands'
import { Aria2ProcessInspector } from '../src/core/engine/aria2/aria2-process-inspector'
import {
  expect,
  findAddTaskWindow,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { type HttpFixture, startHttpFixture } from './fixtures/http-server'
import { getFreePort } from './helpers/free-port'

interface Task {
  id: string
  status: string
  uris: string[]
  downloadedBytes: number
  finalPath?: string
}

interface EngineOwnerRecord {
  version: 1
  pid: number
  binaryPath: string
  rpcPort: number
  argumentMarkers: string[]
  startedAt: number
}

function isOwnerRecord(value: unknown): value is EngineOwnerRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.version === 1 &&
    Number.isSafeInteger(record.pid) &&
    Number(record.pid) > 0 &&
    typeof record.binaryPath === 'string' &&
    record.binaryPath.length > 0 &&
    Number.isSafeInteger(record.rpcPort) &&
    Number(record.rpcPort) > 0 &&
    Array.isArray(record.argumentMarkers) &&
    record.argumentMarkers.length >= 1 &&
    record.argumentMarkers.every(
      (marker) => typeof marker === 'string' && marker.startsWith('--')
    ) &&
    Number.isSafeInteger(record.startedAt) &&
    Number(record.startedAt) > 0
  )
}

async function readManagedTaiji(
  userDataDir: string,
  rpcPort: number
): Promise<EngineOwnerRecord> {
  const raw = await readFile(path.join(userDataDir, 'taiji-owner.json'), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!isOwnerRecord(parsed)) {
    throw new Error('taiji-owner.json did not contain a valid owner record')
  }
  expect(parsed.rpcPort).toBe(rpcPort)
  expect(path.basename(parsed.binaryPath)).toMatch(/^taiji(?:\.exe)?$/i)
  expect(parsed.pid).not.toBe(process.pid)
  expect(
    parsed.argumentMarkers.some((marker) =>
      marker.startsWith('--sqlite3-db-path=')
    )
  ).toBe(true)
  return parsed
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

async function assertManagedTaiji(
  inspector: Aria2ProcessInspector,
  owner: EngineOwnerRecord
): Promise<void> {
  const inspected = await inspector.inspectListeningPort(owner.rpcPort)
  expect(inspected?.pid).toBe(owner.pid)
  expect(inspected?.name).toMatch(/^taiji(?:\.exe)?$/i)
  if (inspected?.executablePath) {
    expect(samePath(inspected.executablePath, owner.binaryPath)).toBe(true)
  }
  expect(inspected?.commandLine).toBeTruthy()
  for (const marker of owner.argumentMarkers) {
    expect(inspected?.commandLine).toContain(marker)
  }
}

async function waitForManagedTaijiExit(
  inspector: Aria2ProcessInspector,
  owner: EngineOwnerRecord
): Promise<void> {
  // The parent pipe must close on a hard kill, so taiji checkpoints and exits
  // without an explicit signal from the test or Motrix shutdown hooks.
  await expect
    .poll(() => inspector.isAlive(owner.pid), { timeout: 10_000 })
    .toBe(false)
  await expect
    .poll(
      async () =>
        (await inspector.inspectListeningPort(owner.rpcPort))?.pid ?? null,
      { timeout: 10_000 }
    )
    .toBeNull()
}

async function readFirstTask(page: Page): Promise<Task | undefined> {
  return page.evaluate(async () => {
    const api = (
      window as unknown as {
        motrix?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        }
      }
    ).motrix
    if (!api) return undefined
    const tasks = (await api.invoke('query:listTasks')) as Task[]
    return tasks[0]
  })
}

test.describe('task recovery — no pause', () => {
  test('active bytes resume after Electron is hard-killed and managed taiji terminates', async ({
    userDataDir,
  }, testInfo) => {
    const rpcPort = await getFreePort()
    const inspector = new Aria2ProcessInspector()
    let fx: HttpFixture | undefined
    let app: ElectronApplication | undefined

    try {
      // Below taiji's default split threshold this remains a single response;
      // 2 MB at 256 KB/s gives polling time to persist non-zero progress while
      // keeping both launch legs within the E2E timeout.
      fx = await startHttpFixture({
        size: 2 * 1024 * 1024,
        etag: 'motrix-recovery-v1',
        throttleBytesPerSecond: 256 * 1024,
      })

      app = await launchMotrix({ userDataDir, rpcPort })
      let main = await app.firstWindow()
      await main.waitForLoadState('domcontentloaded')
      await waitForEngineReady(main)
      await main.evaluate(
        (channel) =>
          window.motrix.invoke(channel, {
            engine: { split: 1, maxConnectionPerServer: 1 },
          }),
        Commands.UpdateSettings
      )

      await main.getByRole('button', { name: 'New task' }).click()
      const addTaskPage = await findAddTaskWindow(app)
      await addTaskPage.getByRole('textbox', { name: 'URLs' }).fill(fx.fileUrl)
      await addTaskPage.getByRole('button', { name: 'Download' }).click()
      await addTaskPage.waitForEvent('close', { timeout: 5_000 })

      await main.getByRole('link', { name: 'Downloads' }).click()
      await expect
        .poll(async () => (await readFirstTask(main))?.downloadedBytes ?? 0, {
          timeout: 15_000,
        })
        // Cross at least one taiji piece boundary. Killing inside the first
        // piece legitimately causes a resumed request to begin at byte zero,
        // which would not prove that the checkpoint retained any body bytes.
        .toBeGreaterThanOrEqual(1024 * 1024 + 128 * 1024)

      const taskBefore = await readFirstTask(main)
      expect(taskBefore?.id).toBeTruthy()
      expect(taskBefore?.status).toBe('downloading')
      expect(taskBefore?.downloadedBytes).toBeGreaterThan(0)

      const owner = await readManagedTaiji(userDataDir, rpcPort)
      await assertManagedTaiji(inspector, owner)

      // Kill Electron without its shutdown hooks, then wait for the managed taiji child
      // to exit through its parent pipe. Relaunching on the same RPC port is the key
      // regression guard: a surviving orphan can no longer masquerade as a
      // successful recovery.
      app.process().kill('SIGKILL')
      await app.waitForEvent('close', { timeout: 5_000 }).catch(() => {})
      app = undefined
      await waitForManagedTaijiExit(inspector, owner)

      // Only requests received after both processes died count as recovery
      // traffic; the original throttled socket may close asynchronously.
      fx.resetRequests()

      app = await launchMotrix({ userDataDir, rpcPort })
      main = await app.firstWindow()
      await main.waitForLoadState('domcontentloaded')
      await waitForEngineReady(main)
      await main.getByRole('link', { name: 'Downloads' }).click()

      await expect
        .poll(async () => (await readFirstTask(main))?.id, { timeout: 15_000 })
        .toBe(taskBefore?.id)
      await expect
        .poll(async () => (await readFirstTask(main))?.downloadedBytes ?? 0, {
          timeout: 20_000,
        })
        .toBeGreaterThan(taskBefore?.downloadedBytes ?? 0)

      // Range semantics after relaunch are required even when taiji has to
      // re-fetch the interrupted leading piece from its boundary at byte zero.
      // The byte-growth and final digest assertions below cover the rest of
      // the resume contract without depending on taiji's internal piece size.
      await expect
        .poll(
          () =>
            fx?.requests().filter((request) => request.method === 'GET')
              .length ?? 0,
          { timeout: 15_000 }
        )
        .toBeGreaterThan(0)
      const recoveryRequests = fx.requests()
      expect(
        recoveryRequests.some(
          (request) => request.status === 206 && request.range !== null
        ),
        `expected Range recovery traffic, received:\n${JSON.stringify(recoveryRequests, null, 2)}`
      ).toBe(true)

      await expect
        .poll(async () => (await readFirstTask(main))?.status, {
          timeout: 30_000,
        })
        .toBe('completed')

      const taskAfter = await readFirstTask(main)
      expect(taskAfter?.uris).toEqual(taskBefore?.uris)
      expect(taskAfter?.downloadedBytes).toBe(fx.fileSize)
      expect(taskAfter?.finalPath).toBeTruthy()
      expect(await fx.verifyFile(taskAfter?.finalPath ?? '')).toBe(true)
    } finally {
      if (app) await app.close().catch(() => {})
      if (fx) {
        await testInfo.attach('recovery-http-requests', {
          body: Buffer.from(JSON.stringify(fx.requests(), null, 2)),
          contentType: 'application/json',
        })
        await fx.close().catch(() => {})
      }
    }
  })
})
