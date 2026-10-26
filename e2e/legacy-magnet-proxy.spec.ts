import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { aria2BinaryName } from '../src/shared/platform/aria2'
import { Commands } from '../src/shared/protocol/commands'
import { Queries } from '../src/shared/protocol/queries'
import type { TaskCreateCommandResult } from '../src/shared/schemas/add-task'
import { legacyBtRequestSourceSchema } from '../src/shared/schemas/legacy-bt-request'
import type { AddTaskPrefill } from '../src/shared/schemas/show-add-task-window'
import {
  type DownloadTask,
  TaskInstancePhase,
  TaskStatus,
  TaskType,
} from '../src/shared/types/task'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { getFreePort } from './helpers/free-port'

type Encodable = number | string | Uint8Array | { [key: string]: Encodable }

function encode(value: Encodable): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (typeof value === 'string') return encode(Buffer.from(value))
  if (value instanceof Uint8Array)
    return Buffer.concat([Buffer.from(`${value.length}:`), value])
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [encode(key), encode(value[key])]),
    Buffer.from('e'),
  ])
}

async function invoke(
  page: Page,
  channel:
    | (typeof Commands)[keyof typeof Commands]
    | (typeof Queries)[keyof typeof Queries],
  input?: unknown
): Promise<unknown> {
  return page.evaluate(
    ({ channel, input }) => window.motrix.invoke(channel, input),
    { channel, input }
  )
}

async function watchSelectionWindows(app: ElectronApplication) {
  await app.evaluate(({ app, BrowserWindow }) => {
    const state = globalThis as typeof globalThis & {
      legacyMagnetSelectionShown?: boolean
    }
    state.legacyMagnetSelectionShown = false
    const watch = (window: Electron.BrowserWindow) => {
      window.on('show', () => {
        if (window.webContents.getURL().includes('w=add-task'))
          state.legacyMagnetSelectionShown = true
      })
    }
    BrowserWindow.getAllWindows().forEach(watch)
    app.on('browser-window-created', (_event, window) => watch(window))
  })
}

async function selectionWasShown(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          legacyMagnetSelectionShown?: boolean
        }
      ).legacyMagnetSelectionShown === true
  )
}

async function readTaskStorage(app: ElectronApplication, userDataDir: string) {
  return app.evaluate(({ app }, directory) => {
    // Use Electron's ABI instead of opening its database from the test runner.
    const { createRequire } = process.getBuiltinModule('module')
    const path = process.getBuiltinModule('path')
    const requireFromApp = createRequire(
      path.join(app.getAppPath(), 'package.json')
    )
    const Database = requireFromApp(
      'better-sqlite3'
    ) as typeof import('better-sqlite3')
    const database = new Database(path.join(directory, 'motrix.db'), {
      readonly: true,
    })
    try {
      return {
        tasks: database.prepare('SELECT * FROM tasks').all(),
        instances: database.prepare('SELECT * FROM task_instances').all(),
        runs: database.prepare('SELECT * FROM legacy_import_runs').all(),
        items: database.prepare('SELECT * FROM legacy_import_items').all(),
      }
    } finally {
      database.close()
    }
  }, userDataDir)
}

test('legacy magnet keeps its proxy through automatic BT handoff and recovery after engine state loss', async ({
  userDataDir,
  rpcPort,
}) => {
  test.setTimeout(120000)
  const seedPort = await getFreePort()
  const seedRpcPort = await getFreePort()
  const seedSecret = 'isolated-seeder-rpc'
  const proxyUser = 'legacy-proxy-user'
  const proxyPassword = 'legacy-proxy-password@:/%'
  const proxyAuthorization = `Basic ${Buffer.from(`${proxyUser}:${proxyPassword}`).toString('base64')}`
  const ignoredCookie = 'legacy-ignored-cookie'
  const payload = Buffer.alloc(1024 * 1024, 0x61)
  const pieceLength = 16384
  const pieceHash = createHash('sha1')
    .update(payload.subarray(0, pieceLength))
    .digest()
  const info = {
    name: 'legacy-proxy.bin',
    length: payload.length,
    'piece length': pieceLength,
    pieces: Buffer.concat(
      Array.from({ length: payload.length / pieceLength }, () => pieceHash)
    ),
    private: 1,
  }
  const infoHash = createHash('sha1').update(encode(info)).digest('hex')
  let directTrackerRequests = 0
  let legacyProxyRequests = 0
  let invalidProxyAuthorization = 0
  let ignoredHeaderRequests = 0
  let ambientProxyRequests = 0
  const tracker = createServer((request, response) => {
    if (request.headers['x-test-legacy-proxy'] !== '1') directTrackerRequests++
    const body = encode({
      interval: 1,
      'min interval': 1,
      complete: 1,
      incomplete: 0,
      peers: Buffer.from([127, 0, 0, 1, seedPort >> 8, seedPort & 255]),
    })
    response.writeHead(200, { 'Content-Length': body.length })
    response.end(body)
  })
  tracker.listen(0, '127.0.0.1')
  await once(tracker, 'listening')
  const trackerAddress = tracker.address()
  if (!trackerAddress || typeof trackerAddress === 'string')
    throw new Error('Local tracker did not bind')
  const trackerUrl = `http://127.0.0.1:${trackerAddress.port}/announce`
  const proxy = createServer((request, response) => {
    if (request.headers.cookie) ignoredHeaderRequests++
    if (request.headers['proxy-authorization'] !== proxyAuthorization) {
      invalidProxyAuthorization++
      response.writeHead(407).end()
      return
    }
    const target = new URL(request.url ?? '/', trackerUrl)
    if (target.origin !== new URL(trackerUrl).origin) {
      response.writeHead(502).end()
      return
    }
    legacyProxyRequests++
    const upstream = httpRequest(
      target,
      { headers: { 'x-test-legacy-proxy': '1' } },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502)
        upstreamResponse.pipe(response)
      }
    )
    upstream.on('error', () => response.writeHead(502).end())
    upstream.end()
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const proxyAddress = proxy.address()
  if (!proxyAddress || typeof proxyAddress === 'string')
    throw new Error('Local proxy did not bind')
  const proxyUrl = `http://${encodeURIComponent(proxyUser)}:${encodeURIComponent(proxyPassword)}@127.0.0.1:${proxyAddress.port}`
  const ambientProxy = createServer((_request, response) => {
    ambientProxyRequests++
    response.writeHead(502).end()
  })
  ambientProxy.listen(0, '127.0.0.1')
  await once(ambientProxy, 'listening')
  const ambientAddress = ambientProxy.address()
  if (!ambientAddress || typeof ambientAddress === 'string')
    throw new Error('Ambient proxy did not bind')

  let app: ElectronApplication | undefined
  let seed: ChildProcess | undefined
  let seedFailure: Error | undefined
  let seedOutput = ''
  const seedRpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(`http://127.0.0.1:${seedRpcPort}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'legacy-magnet-fixture',
        method: `aria2.${method}`,
        params: [`token:${seedSecret}`, ...params],
      }),
    })
    const result = (await response.json()) as {
      result?: unknown
      error?: { message: string }
    }
    if (result.error) throw new Error(result.error.message)
    return result.result
  }
  const assertNoPrivateSettings = (value: unknown) => {
    const serialized = JSON.stringify(value)
    for (const secret of [
      proxyUser,
      proxyPassword,
      encodeURIComponent(proxyPassword),
      proxyAuthorization,
      proxyUrl,
      ignoredCookie,
    ])
      expect(serialized).not.toContain(secret)
  }
  try {
    const source = path.join(userDataDir, 'legacy-magnet-profile')
    const oldDownloads = path.join(source, 'downloads')
    const freshParent = path.join(userDataDir, 'fresh-downloads')
    const seedDir = path.join(userDataDir, 'seed')
    for (const directory of [oldDownloads, freshParent, seedDir])
      await mkdir(directory, { recursive: true })
    const uri = `magnet:?xt=urn:btih:${infoHash}&dn=legacy-proxy.bin&tr=${encodeURIComponent(trackerUrl)}`
    await writeFile(path.join(seedDir, info.name), payload)
    await writeFile(path.join(source, 'user.json'), '{"theme":"auto"}')
    await writeFile(
      path.join(source, 'system.json'),
      JSON.stringify({ dir: oldDownloads, 'all-proxy': proxyUrl })
    )
    await writeFile(
      path.join(source, 'download.session'),
      `${uri}\n gid=1234567890abcdef\n pause=true\n header=Cookie: ${ignoredCookie}\n`
    )
    await writeFile(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        version: CURRENT_SETTINGS_VERSION,
        app: {
          language: 'en-US',
          autofillClipboardLinks: false,
          checkForUpdatesOnLaunch: false,
          warnBeforeQuit: false,
          magnetFileSelection: false,
        },
        engine: {
          dhtEnabled: false,
          listenPort: await getFreePort(),
          btEnableLpd: false,
        },
        tracker: { autoSync: false, probeEnabled: false, sources: [] },
        proxy: {
          enabled: true,
          protocol: 'http',
          host: '127.0.0.1',
          port: ambientAddress.port,
          bypass: [],
          scopes: {
            download: true,
            updateApp: false,
            updateTrackers: false,
            plugins: false,
          },
        },
        onboarding: { disclaimerAccepted: true },
      })
    )
    seed = spawn(
      path.join(
        process.cwd(),
        'extra',
        process.platform,
        process.arch,
        aria2BinaryName(process.platform)
      ),
      [
        '--no-conf=true',
        '--no-netrc=true',
        '--enable-rpc=true',
        `--rpc-listen-port=${seedRpcPort}`,
        `--rpc-secret=${seedSecret}`,
        `--listen-port=${seedPort}`,
        `--dir=${seedDir}`,
        '--enable-dht=false',
        '--enable-dht6=false',
        '--bt-enable-lpd=false',
        '--enable-peer-exchange=false',
        '--bt-exclude-tracker=*',
        '--seed-ratio=0',
        '--seed-time=5',
        '--max-overall-upload-limit=32K',
        '--console-log-level=warn',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    seed.on('error', (error) => {
      seedFailure = error
    })
    const collect = (chunk: Buffer) => {
      seedOutput = (seedOutput + chunk.toString()).slice(-4096)
    }
    seed.stdout?.on('data', collect)
    seed.stderr?.on('data', collect)
    await expect
      .poll(
        async () => {
          if (seedFailure) throw seedFailure
          if (seed?.exitCode !== null)
            throw new Error(`Local seeder exited: ${seedOutput}`)
          return seedRpc('getVersion').catch(() => undefined)
        },
        { timeout: 10000 }
      )
      .toBeTruthy()
    await seedRpc('addTorrent', [
      encode({ announce: trackerUrl, info }).toString('base64'),
      [],
      { 'bt-seed-unverified': 'true' },
    ])
    app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitForEngineReady(page)
    await watchSelectionWindows(app)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    const group = page.locator('[data-import-group="magnet"]')
    await expect(group).toBeVisible()
    const disclosure = group.locator('button[aria-expanded="false"]')
    if (await disclosure.count()) await disclosure.click()
    await expect(
      page.getByRole('checkbox', { name: info.name, exact: true })
    ).toBeChecked()
    assertNoPrivateSettings(await page.locator('body').textContent())
    await page.screenshot({
      path: test.info().outputPath('legacy-magnet-proxy-preview.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: 'Migrate', exact: true }).click()
    await page.getByRole('button', { name: 'View downloads' }).click()
    const imported = (await invoke(page, Queries.ListTasks)) as DownloadTask[]
    expect(imported).toHaveLength(1)
    const sourceTask = imported[0]
    expect(sourceTask).toMatchObject({
      type: TaskType.Magnet,
      engineTaskId: '',
      status: TaskStatus.Paused,
    })
    expect(sourceTask.instances[0].payload.legacyImport).toMatchObject({
      activation: 'inactive',
      ignoredOptions: ['header'],
    })
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      })
    }, freshParent)
    const prefill = (await invoke(page, Commands.PrepareLegacyFreshDownload, {
      taskId: sourceTask.id,
    })) as AddTaskPrefill
    expect(prefill).toMatchObject({
      tab: 'links',
      urls: uri,
      legacySourceTaskId: sourceTask.id,
    })
    assertNoPrivateSettings(prefill)
    if (prefill.tab !== 'links' || !prefill.saveDir)
      throw new Error('Fresh magnet prefill is missing')
    const result = (await invoke(page, Commands.CreateTask, {
      type: 'bt',
      payload: { kind: 'magnet', uri: prefill.urls },
      selectedFiles: [],
      saveDir: prefill.saveDir,
      legacySourceTaskId: prefill.legacySourceTaskId,
    })) as TaskCreateCommandResult
    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created')
      throw new Error('Fresh magnet was not created')
    const readFresh = async () =>
      ((await invoke(page, Queries.ListTasks)) as DownloadTask[]).find(
        (task) => task.id === result.taskId
      )
    await expect
      .poll(
        async () => {
          const task = await readFresh()
          return (
            task?.type === TaskType.Bt &&
            task.status === TaskStatus.Downloading &&
            task.downloadedBytes >= pieceLength
          )
        },
        { timeout: 30000 }
      )
      .toBe(true)
    expect(await selectionWasShown(app)).toBe(false)
    const fresh = await readFresh()
    const reference = legacyBtRequestSourceSchema.parse(
      fresh?.instances.find(
        (instance) => instance.phase === TaskInstancePhase.BtDownload
      )?.payload.legacyBtRequestSource
    )
    expect(reference.infoHash).toBe(infoHash)
    expect(legacyProxyRequests).toBeGreaterThan(0)
    expect(invalidProxyAuthorization).toBe(0)
    expect(ignoredHeaderRequests).toBe(0)
    expect(directTrackerRequests).toBe(0)
    expect(ambientProxyRequests).toBe(0)
    assertNoPrivateSettings(await invoke(page, Queries.ListTasks))
    assertNoPrivateSettings(await readTaskStorage(app, userDataDir))

    await invoke(page, Commands.PauseTask, result.taskId)
    await expect.poll(async () => (await readFresh())?.status).toBe('paused')
    await invoke(page, Commands.RemoveTask, {
      taskId: sourceTask.id,
      deleteWithFiles: false,
    })
    await rm(source, { recursive: true })
    await app.close()
    app = undefined
    // Lose only aria2 state; the task and immutable migration backup remain.
    for (const name of [
      'aria2.db',
      'aria2.db-wal',
      'aria2.db-shm',
      'aria2.session',
    ])
      await rm(path.join(userDataDir, name), { force: true })
    const requestsBeforeRecovery = legacyProxyRequests
    await seedRpc('changeGlobalOption', [{ 'max-overall-upload-limit': '0' }])
    app = await launchMotrix({
      userDataDir,
      rpcPort: await getFreePort(),
      extraEnv: { MOTRIX_LEGACY_PROFILE: source },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitForEngineReady(page)
    await watchSelectionWindows(app)
    await expect.poll(async () => (await readFresh())?.status).toBe('paused')
    await expect
      .poll(async () => (await readFresh())?.engineTaskId)
      .not.toBe(fresh?.engineTaskId)
    expect((await readFresh())?.engineTaskId).toBeTruthy()
    expect(
      (await readFresh())?.instances[0].payload.legacyBtRequestSource
    ).toEqual(reference)
    await invoke(page, Commands.ResumeTask, result.taskId)
    await expect
      .poll(async () => (await readFresh())?.downloadedBytes, {
        timeout: 30000,
      })
      .toBe(payload.length)
    await expect
      .poll(async () => (await readFresh())?.status, { timeout: 15000 })
      .toMatch(/^(completed|seeding)$/)
    expect(legacyProxyRequests).toBeGreaterThan(requestsBeforeRecovery)
    expect(invalidProxyAuthorization).toBe(0)
    expect(ignoredHeaderRequests).toBe(0)
    expect(directTrackerRequests).toBe(0)
    expect(ambientProxyRequests).toBe(0)
    expect(await selectionWasShown(app)).toBe(false)
    const recovered = await readFresh()
    if (!recovered) throw new Error('Recovered task is missing')
    expect(await readFile(recovered.finalPath)).toEqual(payload)
    expect(recovered.instances[0].payload.legacyBtRequestSource).toEqual(
      reference
    )
    assertNoPrivateSettings(await invoke(page, Queries.ListTasks))
    assertNoPrivateSettings(await readTaskStorage(app, userDataDir))
  } finally {
    await app?.close().catch(() => {})
    if (seed?.pid && seed.exitCode === null && seed.signalCode === null) {
      const exited = once(seed, 'exit')
      seed.kill('SIGTERM')
      const kill = setTimeout(() => seed?.kill('SIGKILL'), 1000)
      kill.unref()
      await exited
      clearTimeout(kill)
    }
    for (const server of [proxy, ambientProxy, tracker]) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})
