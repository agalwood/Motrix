import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsManager } from '@core/settings/settings-manager'
import { FinalNamePickerImpl } from '@core/task/final-name-picker'
import { MediaTaskCoordinator } from '@core/task/media-task-coordinator'
import {
  makeBridgeReceiverDeps,
  makeDirectSubmit,
  makeExtensionContext,
} from '@test-utils/bridge-receiver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeReceiver } from './bridge-receiver'

describe('bridge default save directory', () => {
  let root: string
  let settings: SettingsManager
  let oldDir: string
  let newDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'motrix-save-dir-'))
    oldDir = join(root, 'old')
    newDir = join(root, 'new')
    await Promise.all([mkdir(oldDir), mkdir(newDir)])
    settings = new SettingsManager(join(root, 'settings.json'))
    await settings.update({ app: { defaultSaveDir: oldDir } })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('uses a committed directory change without recreating the receiver', async () => {
    const deps = makeBridgeReceiverDeps({
      getDefaultSaveDir: () => settings.getApp().defaultSaveDir,
    })
    const createTask = vi.spyOn(deps, 'createTask')
    const pickName = vi.spyOn(deps, 'pickName')
    const receiver = new BridgeReceiver(deps)
    const ctx = makeExtensionContext()
    await receiver.handle(makeDirectSubmit('before-change'), ctx)
    const update = await settings.update({ app: { defaultSaveDir: newDir } })
    expect(update.saved).toBe(true)
    expect(
      JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).app
        .defaultSaveDir
    ).toBe(newDir)
    await receiver.handle(makeDirectSubmit('after-change'), ctx)
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ saveDir: oldDir })
    expect(createTask.mock.calls[1]?.[0]).toMatchObject({ saveDir: newDir })
    expect(pickName).toHaveBeenLastCalledWith(newDir, 'file.zip')
  })

  for (const suffix of ['', '.motrix']) {
    it(`deduplicates against files in the newly selected directory (${suffix || 'final'})`, async () => {
      const picker = new FinalNamePickerImpl({
        exists: async (path) => {
          try {
            await access(path)
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
      const createTask = vi.spyOn(deps, 'createTask')
      const receiver = new BridgeReceiver(deps)
      await writeFile(join(newDir, `file.zip${suffix}`), 'keep')
      await settings.update({ app: { defaultSaveDir: newDir } })
      await receiver.handle(makeDirectSubmit(), makeExtensionContext())
      expect(createTask.mock.calls[0]?.[0]).toMatchObject({
        saveDir: newDir,
        filename: 'file (1).zip',
      })
      expect(await readFile(join(newDir, `file.zip${suffix}`), 'utf8')).toBe(
        'keep'
      )
    })
  }

  it('reads settings only after the startup gate resolves', async () => {
    const gate = Promise.withResolvers<void>()
    const getDefaultSaveDir = vi.fn(() => settings.getApp().defaultSaveDir)
    const deps = makeBridgeReceiverDeps({
      getDefaultSaveDir,
      waitForReady: () => gate.promise,
    })
    const pickName = vi.spyOn(deps, 'pickName')
    const createTask = vi.spyOn(deps, 'createTask')
    const receiver = new BridgeReceiver(deps)
    const pending = receiver.handle(makeDirectSubmit(), makeExtensionContext())
    expect(getDefaultSaveDir).not.toHaveBeenCalled()
    expect(pickName).not.toHaveBeenCalled()
    expect(createTask).not.toHaveBeenCalled()
    await settings.update({ app: { defaultSaveDir: newDir } })
    gate.resolve()
    await pending
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ saveDir: newDir })
    expect(getDefaultSaveDir).toHaveBeenCalledOnce()
  })

  it('does not select a directory when the startup gate fails', async () => {
    const getDefaultSaveDir = vi.fn(() => newDir)
    const receiver = new BridgeReceiver(
      makeBridgeReceiverDeps({
        getDefaultSaveDir,
        waitForReady: async () => {
          throw new Error('startup failed')
        },
      })
    )
    await expect(
      receiver.handle(makeDirectSubmit(), makeExtensionContext())
    ).rejects.toThrow('startup failed')
    expect(getDefaultSaveDir).not.toHaveBeenCalled()
  })

  it('preserves a pending and cached task across setting changes, but uses the new directory for a new key', async () => {
    const gate = Promise.withResolvers<string>()
    const getDefaultSaveDir = vi.fn(() => settings.getApp().defaultSaveDir)
    const pickName = vi
      .fn(async (_dir: string, name: string) => name)
      .mockImplementationOnce(() => gate.promise)
    const deps = makeBridgeReceiverDeps({ getDefaultSaveDir, pickName })
    const createTask = vi.spyOn(deps, 'createTask')
    const receiver = new BridgeReceiver(deps)
    const ctx = makeExtensionContext()
    const pending = receiver.handle(makeDirectSubmit('same-logical-task'), ctx)
    await settings.update({ app: { defaultSaveDir: newDir } })
    const replay = receiver.handle(makeDirectSubmit('same-logical-task'), ctx)
    gate.resolve('file.zip')
    const [first, duplicate] = await Promise.all([pending, replay])
    expect(duplicate).toEqual(first)
    expect(
      await receiver.handle(makeDirectSubmit('same-logical-task'), ctx)
    ).toEqual(first)
    expect(createTask).toHaveBeenCalledOnce()
    expect(getDefaultSaveDir).toHaveBeenCalledOnce()
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ saveDir: oldDir })
    const next = await receiver.handle(
      makeDirectSubmit('new-logical-task'),
      ctx
    )
    expect(next.taskId).not.toBe(first.taskId)
    expect(createTask.mock.calls[1]?.[0]).toMatchObject({ saveDir: newDir })
    expect(getDefaultSaveDir).toHaveBeenCalledTimes(2)
  })

  it('uses current settings when retrying a failed pre-creation attempt', async () => {
    const pickName = vi
      .fn(async (_dir: string, name: string) => name)
      .mockRejectedValueOnce(new Error('pick failed'))
    const deps = makeBridgeReceiverDeps({
      getDefaultSaveDir: () => settings.getApp().defaultSaveDir,
      pickName,
    })
    const createTask = vi.spyOn(deps, 'createTask')
    const receiver = new BridgeReceiver(deps)
    const ctx = makeExtensionContext()
    await expect(
      receiver.handle(makeDirectSubmit('retry-failed-key'), ctx)
    ).rejects.toThrow('pick failed')
    expect(createTask).not.toHaveBeenCalled()
    await settings.update({ app: { defaultSaveDir: newDir } })
    await receiver.handle(makeDirectSubmit('retry-failed-key'), ctx)
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ saveDir: newDir })
  })

  it('keeps the committed directory when a settings write fails', async () => {
    const receiverDeps = makeBridgeReceiverDeps({
      getDefaultSaveDir: () => settings.getApp().defaultSaveDir,
    })
    const createTask = vi.spyOn(receiverDeps, 'createTask')
    const receiver = new BridgeReceiver(receiverDeps)
    // A directory at the destination deterministically prevents atomic replacement.
    await rm(join(root, 'settings.json'))
    await mkdir(join(root, 'settings.json'))
    await expect(
      settings.update({ app: { defaultSaveDir: newDir } })
    ).rejects.toThrow()
    expect(settings.getApp().defaultSaveDir).toBe(oldDir)
    await receiver.handle(makeDirectSubmit(), makeExtensionContext())
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ saveDir: oldDir })
  })

  for (const enabled of [false, true]) {
    it(`passes the changed directory to magnets with file selection ${enabled}`, async () => {
      const deps = makeBridgeReceiverDeps({
        getDefaultSaveDir: () => settings.getApp().defaultSaveDir,
        isMagnetFileSelectionEnabled: () => enabled,
      })
      const createTask = vi.spyOn(deps, 'createTask')
      const selectFiles = vi.spyOn(deps, 'submitMagnetForFileSelection')
      const receiver = new BridgeReceiver(deps)
      await settings.update({ app: { defaultSaveDir: newDir } })
      const params = makeDirectSubmit()
      params.selection = {
        kind: 'magnet',
        uri: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789',
      }
      await receiver.handle(params, makeExtensionContext())
      if (enabled) {
        expect(selectFiles).toHaveBeenCalledWith(
          params.selection.uri,
          newDir,
          expect.any(Object)
        )
        expect(createTask).not.toHaveBeenCalled()
      } else {
        expect(createTask.mock.calls[0]?.[0]).toMatchObject({ saveDir: newDir })
        expect(selectFiles).not.toHaveBeenCalled()
      }
    })
  }

  it('retains the chosen directory when an async direct resolver reroutes to mux', async () => {
    const resolveStarted = Promise.withResolvers<void>()
    const releaseResolve = Promise.withResolvers<void>()
    const submit = vi
      .spyOn(MediaTaskCoordinator.prototype, 'submit')
      .mockResolvedValue({ taskId: 'mux-task' })
    const deps = makeBridgeReceiverDeps({
      getDefaultSaveDir: () => settings.getApp().defaultSaveDir,
      ffmpegBinaryPath: '/test/ffmpeg',
      resolveToMux: async () => {
        resolveStarted.resolve()
        await releaseResolve.promise
        return {
          title: 'Resolved title',
          videoUrl: 'https://example.com/video',
          audioUrl: 'https://example.com/audio',
          container: 'mp4',
        }
      },
    })
    const pickName = vi.spyOn(deps, 'pickName')
    const receiver = new BridgeReceiver(deps)
    const pending = receiver.handle(makeDirectSubmit(), makeExtensionContext())
    await resolveStarted.promise
    await settings.update({ app: { defaultSaveDir: newDir } })
    releaseResolve.resolve()
    await pending
    expect(pickName).toHaveBeenLastCalledWith(oldDir, 'Resolved title.mp4')
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      saveDir: oldDir,
      finalName: 'Resolved title.mp4',
    })
  })

  for (const kind of ['hls', 'dash', 'mux'] as const) {
    it(`passes a stable directory to the ${kind} media job`, async () => {
      const fetchStarted = Promise.withResolvers<void>()
      const manifest = Promise.withResolvers<string>()
      const submit = vi
        .spyOn(MediaTaskCoordinator.prototype, 'submit')
        .mockResolvedValue({ taskId: 'media-task' })
      const deps = makeBridgeReceiverDeps({
        getDefaultSaveDir: () => settings.getApp().defaultSaveDir,
        ffmpegBinaryPath: '/test/ffmpeg',
        fetchManifest: () => {
          fetchStarted.resolve()
          return manifest.promise
        },
      })
      const receiver = new BridgeReceiver(deps)
      await settings.update({ app: { defaultSaveDir: newDir } })
      const params = makeDirectSubmit()
      if (params.selection.kind !== 'direct') throw new Error('expected direct')
      const primary = params.selection.primary
      params.selection =
        kind === 'mux'
          ? { kind, video: primary, audio: primary, container: 'mp4' }
          : { kind, primary, container: 'mp4' }
      const pending = receiver.handle(params, makeExtensionContext())
      if (kind !== 'mux') {
        await fetchStarted.promise
        await settings.update({ app: { defaultSaveDir: oldDir } })
        manifest.resolve(
          kind === 'hls'
            ? '#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n'
            : '<MPD type="static" mediaPresentationDuration="PT2S"><Period duration="PT2S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" initialization="init.mp4" media="segment-$Number$.m4s"/><Representation id="v" bandwidth="1000"/></AdaptationSet></Period></MPD>'
        )
      }
      await pending
      expect(submit.mock.calls[0]?.[0]).toMatchObject({ kind, saveDir: newDir })
    })
  }
})
