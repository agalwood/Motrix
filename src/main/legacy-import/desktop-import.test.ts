// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Aria2ProcessInspector } from '@core/engine/aria2/aria2-process-inspector'
import type { LegacyImportService } from '@core/legacy-import/import-service'
import { TorrentParser } from '@core/torrent/torrent-parser'
import { Commands } from '@shared/protocol/commands'
import {
  makeDownloadTask,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  pick: vi.fn(),
  save: vi.fn(),
  owner: {},
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { fromWebContents: () => mocks.owner },
  dialog: { showOpenDialog: mocks.pick, showSaveDialog: mocks.save },
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
  },
}))
vi.mock('../ipc/trusted-ipc', () => ({
  registerTrustedIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => Promise<unknown>
  ) => mocks.handlers.set(channel, handler),
}))

import {
  defaultLegacyRoots,
  legacyPidRunning,
  registerLegacyImportIpc,
} from './desktop-import'

const roots: string[] = []
afterEach(async () => {
  mocks.handlers.clear()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'motrix-desktop-import-'))
  )
  roots.push(root)
  const oldPath = path.join(root, 'old.zip')
  await writeFile(oldPath, 'original bytes')
  const task = makeDownloadTask({
    id: 'imported',
    name: 'old.zip',
    type: TaskType.Http,
    kind: TaskKind.Direct,
    saveDir: root,
    createdAt: 1,
    updatedAt: 1,
    filename: 'old.zip',
    finalName: 'old.zip',
    finalPath: oldPath,
    diskPath: oldPath,
    source: 'user',
    sourceMeta: null,
    status: TaskStatus.Paused,
    uris: ['https://example.invalid/old.zip'],
    instances: [
      {
        instanceId: 'instance',
        motrixId: 'imported',
        gid: null,
        phase: TaskInstancePhase.HttpDownload,
        status: TaskStatus.Paused,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: oldPath,
        transitionPhase: TransitionPhase.Idle,
        uris: [],
        uriHash: null,
        payload: {
          legacyImport: {
            version: 1,
            sourceId: 'source',
            itemKey: 'key',
            activation: 'inactive',
            storagePolicy: 'legacy-read-only',
            reason: 'fresh-download-required',
            selectionKnown: false,
            selectedFiles: [],
          },
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
  const service = {} as LegacyImportService
  mocks.pick.mockResolvedValue({ canceled: false, filePaths: [root] })
  const getService = vi.fn(() => service)
  registerLegacyImportIpc({
    getService,
    hasConsent: () => true,
    getTask: () => task,
    backupRoot: path.join(root, 'backups'),
    finishInvitation: vi.fn(),
  })
  const event = { sender: {} }
  return { root, oldPath, task, getService, event }
}

describe('desktop legacy import', () => {
  it('creates a separate fresh directory and a single-source draft without reading or modifying old bytes', async () => {
    const { root, oldPath, task, event } = await fixture()
    const result = (await mocks.handlers.get(
      Commands.PrepareLegacyFreshDownload
    )?.(event, { taskId: task.id })) as { saveDir: string; urls: string }
    expect(result.urls).toBe(task.uris[0])
    expect(path.dirname(result.saveDir)).toBe(root)
    expect(path.basename(result.saveDir)).toMatch(/^Motrix-new-/)
    expect(result.saveDir).not.toBe(task.saveDir)
    expect(task.status).toBe(TaskStatus.Paused)
    expect(await readFile(oldPath, 'utf8')).toBe('original bytes')
  })

  it('rejects mirror re-add before a picker instead of turning one task into several downloads', async () => {
    const { task, event } = await fixture()
    task.uris.push('https://mirror.invalid/old.zip')
    await expect(
      mocks.handlers.get(Commands.PrepareLegacyFreshDownload)?.(event, {
        taskId: task.id,
      })
    ).rejects.toThrow('mirrorsUnsupported')
    expect(mocks.pick).not.toHaveBeenCalled()
  })

  it('rejects changed malformed or credentialed task sources before choosing a destination', async () => {
    const { task, event } = await fixture()
    task.uris = ['https://secret:password@example.invalid/file.zip']
    await expect(
      mocks.handlers.get(Commands.PrepareLegacyFreshDownload)?.(event, {
        taskId: task.id,
      })
    ).rejects.toThrow('unsafeSource')
    expect(mocks.pick).not.toHaveBeenCalled()
  })

  it('shares an in-flight preparation so concurrent requests create one directory', async () => {
    const { task, event } = await fixture()
    const handler = mocks.handlers.get(Commands.PrepareLegacyFreshDownload)
    const [first, second] = await Promise.all([
      handler?.(event, { taskId: task.id }),
      handler?.(event, { taskId: task.id }),
    ])
    expect(first).toEqual(second)
    expect(mocks.pick).toHaveBeenCalledOnce()
  })

  it('retains torrent bytes and leaves unknown historical file selection empty in the fresh draft', async () => {
    const { root, task, event } = await fixture()
    const bytes = await readFile(
      new URL('../../core/torrent/__fixtures__/test.torrent', import.meta.url)
    )
    const backup = path.join(root, 'backups', 'run')
    await mkdir(backup, { recursive: true })
    task.torrentMetaPath = path.join(backup, 'retained.torrent')
    await writeFile(task.torrentMetaPath, bytes)
    const meta = await new TorrentParser().parse(bytes.toString('base64'))
    task.type = TaskType.Bt
    task.infoHash = meta.infoHash
    const result = await mocks.handlers.get(
      Commands.PrepareLegacyFreshDownload
    )?.(event, { taskId: task.id })
    expect(result).toMatchObject({
      tab: 'torrent',
      source: 'file',
      base64: bytes.toString('base64'),
      torrentMeta: meta,
      selectedFiles: [],
    })
    expect(await readFile(task.torrentMetaPath)).toEqual(bytes)
  })

  it('does not block a live unrelated process after a recorded PID is reused', async () => {
    vi.spyOn(Aria2ProcessInspector.prototype, 'inspectPid').mockResolvedValue({
      pid: process.pid,
      name: 'node',
      executablePath: process.execPath,
      commandLine: 'node test',
    })
    await expect(legacyPidRunning(process.pid)).resolves.toBe(false)
    vi.spyOn(Aria2ProcessInspector.prototype, 'inspectPid').mockResolvedValue({
      pid: process.pid,
      name: 'unknown',
      executablePath: null,
      commandLine: null,
    })
    await expect(legacyPidRunning(process.pid)).resolves.toBe(true)
  })

  it('refusal blocks all legacy reads and native dialogs', async () => {
    const getService = vi.fn()
    registerLegacyImportIpc({
      getService,
      hasConsent: () => false,
      getTask: () => undefined,
      backupRoot: '',
      finishInvitation: vi.fn(),
    })
    await expect(
      mocks.handlers.get(Commands.PickLegacyImportSource)?.({ sender: {} })
    ).rejects.toThrow('consentRequired')
    expect(getService).not.toHaveBeenCalled()
    expect(mocks.pick).not.toHaveBeenCalled()
  })

  it('isolates unpackaged tests from real profile paths', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('MOTRIX_LEGACY_PROFILE', '')
    expect(defaultLegacyRoots()).toEqual([])
    vi.stubEnv('MOTRIX_LEGACY_PROFILE', '/fixture/motrix')
    expect(defaultLegacyRoots()).toEqual(['/fixture/motrix'])
    vi.stubEnv('MOTRIX_LEGACY_PROFILE', 'relative/path')
    expect(defaultLegacyRoots()).toEqual([])
  })

  it('passes only a preview item to the service and authorizes one native-selected torrent path privately', async () => {
    const f = await fixture()
    const request = {
      previewId: '11111111-1111-4111-8111-111111111111',
      itemId: 'gid:0123456789abcdef',
    }
    let selected: string | null = null
    const authorizeMetadata = vi.fn(
      async (_input, chooseFile: () => Promise<string | null>) => {
        selected = await chooseFile()
        return { previewId: 'refreshed-preview' }
      }
    )
    f.getService.mockReturnValue({
      authorizeMetadata,
    } as unknown as LegacyImportService)
    const chosen = path.join(f.root, 'original.torrent')
    mocks.pick.mockResolvedValue({ canceled: false, filePaths: [chosen] })
    const result = await mocks.handlers.get(
      Commands.PickLegacyTorrentMetadata
    )?.(f.event, request)
    expect(authorizeMetadata).toHaveBeenCalledWith(
      request,
      expect.any(Function)
    )
    expect(selected).toBe(chosen)
    expect(result).toEqual({ previewId: 'refreshed-preview' })
    expect(mocks.pick).toHaveBeenCalledWith(
      mocks.owner,
      expect.objectContaining({
        properties: ['openFile'],
        filters: [{ name: expect.any(String), extensions: ['torrent'] }],
      })
    )
  })

  it('rejects renderer-supplied metadata paths before invoking a native picker or service', async () => {
    const f = await fixture()
    await expect(
      mocks.handlers.get(Commands.PickLegacyTorrentMetadata)?.(f.event, {
        previewId: '11111111-1111-4111-8111-111111111111',
        itemId: 'gid:0123456789abcdef',
        filePath: '/untrusted/file.torrent',
      })
    ).rejects.toThrow()
    expect(f.getService).not.toHaveBeenCalled()
    expect(mocks.pick).not.toHaveBeenCalled()
  })
})
