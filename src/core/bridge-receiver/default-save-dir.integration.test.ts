// @vitest-environment node
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import { SettingsManager } from '@core/settings/settings-manager'
import { finalizeTask } from '@core/task/actions/finalize-task'
import {
  type CreateTaskDeps,
  handleCreateTask,
} from '@core/task/create-task-handler'
import { DirectResourceValidatorService } from '@core/task/direct-resource-validator'
import { FinalNamePickerImpl } from '@core/task/final-name-picker'
import { TorrentMetaStoreImpl } from '@core/task/torrent-meta-store'
import {
  type Aria2Handle,
  bundledAria2Exists,
  canBindLoopbackTcp,
  connectAdapter,
  spawnAria2ForTest,
} from '@test-utils/aria2'
import {
  makeBridgeReceiverDeps,
  makeDirectSubmit,
  makeExtensionContext,
} from '@test-utils/bridge-receiver'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BridgeReceiver } from './bridge-receiver'

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'bridge save directories with the bundled engine',
  () => {
    let root: string
    let server: Server
    let baseUrl: string
    let engine: Aria2Handle
    let wired: Awaited<ReturnType<typeof connectAdapter>>

    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(path.join(tmpdir(), 'motrix-save-dir-engine-'))
      )
      server = createServer((request, response) => {
        if (request.url?.startsWith('/filename-')) {
          response.setHeader(
            'Content-Disposition',
            "attachment; filename*=UTF-8''BCUninstaller_6.3.0_portable.7z"
          )
        }
        response.end(`fixture:${request.url}`)
      })
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      )
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('missing HTTP address')
      baseUrl = `http://127.0.0.1:${address.port}`
      engine = await spawnAria2ForTest({
        baseDir: root,
        extraArgs: ['--http-accept-gzip=true', '--no-want-digest-header=false'],
      })
      wired = await connectAdapter(engine)
    }, 30_000)

    afterAll(async () => {
      wired?.disconnect()
      await engine?.kill()
      server?.closeAllConnections()
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()))
      if (root) await rm(root, { recursive: true, force: true })
    })

    it('lands automatic, legacy Windows and right-click downloads under the response filename', async () => {
      const profile = await wired.adapter.inspectDirectResourceMetadataProfile()
      expect(profile).not.toBeNull()
      wired.adapter.setDirectResourceMetadataProfile(profile)
      const filename = 'BCUninstaller_6.3.0_portable.7z'
      for (const [origin, hint] of [
        ['automatic', filename],
        ['legacy', String.raw`E:\Downloads\BCUninstaller_6.3.0_portable.7z`],
        ['right-click', ''],
      ]) {
        const dir = path.join(root, `filename-${origin}`)
        await mkdir(dir)
        const settings = new SettingsManager(path.join(dir, 'settings.json'))
        await settings.update({ app: { defaultSaveDir: dir } })
        const picker = new FinalNamePickerImpl({
          exists: async (candidate) =>
            access(candidate).then(
              () => true,
              () => false
            ),
        })
        const deps = makeBridgeReceiverDeps({
          getDefaultSaveDir: () => dir,
          pickName: (saveDir, name) => picker.pick(saveDir, name),
        })
        const torrentMetaStore = new TorrentMetaStoreImpl(root)
        const createTaskDeps: CreateTaskDeps = {
          adapter: wired.adapter,
          settingsManager: settings,
          finalNamePicker: picker,
          torrentMetaStore,
          taskManager: deps.taskManager,
          activityRecorder: deps.activityRecorder,
          eventBus: { emit: () => {} },
          directResourceProxyPolicy: new AppliedDownloadProxyPolicy({
            noProxy: '',
          }),
          directResourceValidator: new DirectResourceValidatorService(),
          publishTaskUpdate: () => {},
        }
        deps.createTask = (request, _unused, options) =>
          handleCreateTask(request, createTaskDeps, options)
        const receiver = new BridgeReceiver(deps)
        const params = makeDirectSubmit(`filename-${origin}`)
        if (params.selection.kind !== 'direct')
          throw new Error('expected direct')
        params.selection.primary.url = `${baseUrl}/filename-${origin}`
        params.meta.suggestedFilename = hint
        const { taskId } = await receiver.handle(params, makeExtensionContext())
        const task = deps.taskManager.getById(taskId)
        if (!task) throw new Error('missing task')
        await vi.waitFor(
          async () => {
            expect((await wired.rpc.tellStatus(task.engineTaskId)).status).toBe(
              'complete'
            )
          },
          { timeout: 10_000, interval: 50 }
        )
        expect(task.finalName).toBe(filename)
        await finalizeTask(taskId, {
          taskManager: Object.assign(deps.taskManager, {
            persist: async () => {},
          }),
          adapter: wired.adapter,
          fs: {
            renameAtomic: rename,
            removePathRecursive: (file) =>
              rm(file, { recursive: true, force: true }),
          },
          torrentMetaStore,
          settings: { get: () => ({ bt: { seedTime: 0, seedRatio: 0 } }) },
          eventBus: { emit: () => {} },
          activityRecorder: deps.activityRecorder,
          publishTaskUpdate: () => {},
          publishTaskUpdateNow: () => {},
          log: { info: () => {}, warn: () => {}, error: () => {} },
        })
        expect(await readFile(path.join(dir, filename), 'utf8')).toBe(
          `fixture:/filename-${origin}`
        )
        await expect(
          access(path.join(dir, `${filename}.motrix`))
        ).rejects.toThrow()
      }
    }, 30_000)

    it('writes new tasks to the committed directory and preserves existing task paths', async () => {
      const oldDir = path.join(root, 'old')
      const newDir = path.join(root, 'new 中文 directory')
      await Promise.all([mkdir(oldDir), mkdir(newDir)])
      const settings = new SettingsManager(path.join(root, 'settings.json'))
      await settings.update({ app: { defaultSaveDir: oldDir } })
      const picker = new FinalNamePickerImpl({
        exists: async (candidate) => {
          try {
            await access(candidate)
            return true
          } catch {
            return false
          }
        },
      })
      const deps = makeBridgeReceiverDeps({
        getDefaultSaveDir: () => settings.getApp().defaultSaveDir,
        pickName: (dir, name) => picker.pick(dir, name),
      })
      const createTaskDeps: CreateTaskDeps = {
        adapter: wired.adapter,
        settingsManager: settings,
        finalNamePicker: picker,
        torrentMetaStore: new TorrentMetaStoreImpl(root),
        taskManager: deps.taskManager,
        activityRecorder: deps.activityRecorder,
        eventBus: { emit: () => {} },
        directResourceProxyPolicy: new AppliedDownloadProxyPolicy({
          noProxy: '',
        }),
        publishTaskUpdate: () => {},
      }
      const created = new Map<string, string>()
      deps.createTask = async (request, _unused, options) => {
        const result = await handleCreateTask(request, createTaskDeps, options)
        created.set(result.taskId, result.gid)
        return result
      }
      const receiver = new BridgeReceiver(deps)
      const context = makeExtensionContext()
      const submit = async (key: string, dir: string, filename: string) => {
        const params = makeDirectSubmit(key)
        if (params.selection.kind !== 'direct')
          throw new Error('expected direct')
        params.selection.primary.url = `${baseUrl}/${key}`
        const { taskId } = await receiver.handle(params, context)
        const gid = created.get(taskId)
        if (!gid) throw new Error('missing engine id')
        await vi.waitFor(
          async () => {
            const status = await wired.rpc.tellStatus(gid)
            expect(status.status).toBe('complete')
            expect(status.dir).toBe(dir)
          },
          { timeout: 10_000, interval: 50 }
        )
        const task = deps.taskManager.getById(taskId)
        if (!task) throw new Error('missing task')
        expect(task.saveDir).toBe(dir)
        expect(task.finalPath).toBe(path.join(dir, filename))
        // This fixture runs the engine, not the application poll/finalize loop.
        expect(task.diskPath).toBe(path.join(dir, `${filename}.motrix`))
        expect(await readFile(task.diskPath, 'utf8')).toBe(`fixture:/${key}`)
        return task
      }
      const first = await submit('first-download', oldDir, 'file.zip')
      await settings.update({ app: { defaultSaveDir: newDir } })
      await wired.rpc.changeGlobalOption({ dir: newDir })
      await writeFile(path.join(newDir, 'file.zip'), 'existing file')
      await submit('second-download', newDir, 'file (1).zip')
      expect(first.saveDir).toBe(oldDir)
      expect(await readFile(first.diskPath, 'utf8')).toBe(
        'fixture:/first-download'
      )
      expect(await readFile(path.join(newDir, 'file.zip'), 'utf8')).toBe(
        'existing file'
      )
      await expect(
        access(path.join(oldDir, 'file (1).zip.motrix'))
      ).rejects.toThrow()
    }, 25_000)
  }
)
