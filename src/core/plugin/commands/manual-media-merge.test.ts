// @vitest-environment node
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { MediaMergeArgs } from '@shared/schemas/manual-media-merge'
import { TaskStatus } from '@shared/types/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskManager } from '../../task/task-manager'
import { LogCapabilityHost } from '../capabilities/log'
import type { ManualMergeContext } from '../host/capability-bridge'
import type { PluginHost } from '../host/plugin-host'
import type { PluginRegistry } from '../plugin-registry'
import { ManualMediaMerge } from './manual-media-merge'

const pluginId = 'test.merger'
const command = {
  id: `${pluginId}.mergeStreams`,
  public: true,
  argsSchema: {
    type: 'object',
    required: ['videoInput', 'audioInput', 'output'],
    properties: {
      videoInput: { type: 'string' },
      audioInput: { type: 'string' },
      output: { type: 'string' },
    },
  },
  resultSchema: {
    type: 'object',
    required: ['outputPath'],
    properties: { outputPath: { type: 'string' } },
  },
}

describe('manual media merge', () => {
  let dir: string
  let args: MediaMergeArgs & { pluginId: string }
  let service: ManualMediaMerge
  let invoke: ReturnType<typeof vi.fn>
  let enabled: boolean
  let completion: Promise<unknown>
  let tasks: Map<string, unknown>
  let logDir: string
  let logs: LogCapabilityHost
  let createLog: ReturnType<typeof vi.fn<LogCapabilityHost['create']>>
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'manual-merge-')))
    logDir = await mkdtemp(path.join(tmpdir(), 'manual-merge-logs-'))
    logs = new LogCapabilityHost({ pluginLogsDir: logDir })
    createLog = vi.fn((id: string) => logs.create(id))
    args = {
      pluginId,
      videoInput: path.join(dir, 'video.mp4'),
      audioInput: path.join(dir, 'audio.mp4'),
      output: path.join(dir, 'merged.mp4'),
    }
    await Promise.all([
      writeFile(args.videoInput, 'video'),
      writeFile(args.audioInput, 'audio'),
    ])
    enabled = true
    tasks = new Map()
    invoke = vi.fn(
      async (
        _plugin: string,
        _command: string,
        values: MediaMergeArgs,
        options: { mediaMerge: ManualMergeContext }
      ) => {
        options.mediaMerge.onProgress({ percent: 50, speed: '2x', timeMs: 500 })
        await writeFile(values.output, 'video+audio')
        return { outputPath: values.output }
      }
    )
    service = new ManualMediaMerge({
      createLog,
      registry: {
        list: () => [{ id: pluginId, name: 'Merger', enabled }],
        get: (id: string) =>
          id === pluginId
            ? {
                state: { enabled },
                manifest: {
                  permissions: ['ffmpeg'],
                  contributes: { commands: [command] },
                },
              }
            : undefined,
      } as unknown as PluginRegistry,
      host: {
        activate: vi.fn(),
        invokeCommand: invoke,
      } as unknown as PluginHost,
      tasks: {
        getById: (id: string) => tasks.get(id),
      } as unknown as TaskManager,
      runWork: (work) => {
        const result = work()
        completion = result
        return result
      },
    })
  })
  afterEach(async () => {
    await logs.flush()
    await rm(dir, { recursive: true, force: true })
    await rm(logDir, { recursive: true, force: true })
  })

  it('publishes the finished output without changing either source', async () => {
    const job = await service.start(args)
    await completion
    expect(service.get(job.id)).toMatchObject({
      status: 'completed',
      percent: 100,
      output: args.output,
    })
    expect(await readFile(args.output, 'utf8')).toBe('video+audio')
    expect(await readFile(args.videoInput, 'utf8')).toBe('video')
    expect(await readFile(args.audioInput, 'utf8')).toBe('audio')
    expect(
      (await readdir(dir)).some((name) => name.startsWith('.motrix-merge-'))
    ).toBe(false)
    expect(service.state().job).toBeNull()
    const entries = logs.getTail(pluginId, 100)
    expect(entries.map((entry) => entry.event)).toEqual([
      'media-merge.started',
      'media-merge.completed',
    ])
    expect(entries[1]).toMatchObject({
      level: 'info',
      jobId: job.id,
      stage: 'saving',
      format: 'mp4',
      durationMs: expect.any(Number),
      files: {
        video: { path: 'video.mp4' },
        audio: { path: 'audio.mp4' },
        output: { path: 'merged.mp4' },
      },
    })
    expect(JSON.stringify(entries)).not.toContain(dir)
    expect(JSON.stringify(entries)).not.toContain('.motrix-merge-')
    await logs.flush()
    const written = (
      await readFile(path.join(logDir, pluginId, 'logs/current.ndjson'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(written.map((entry) => entry.event)).toEqual(
      entries.map((entry) => entry.event)
    )
    expect(logs.getTail('other.plugin', 100)).toEqual([])
  })

  it('refuses to overwrite existing outputs or inputs', async () => {
    await writeFile(args.output, 'existing')
    await expect(service.start(args)).rejects.toThrow('mediaMerge.outputExists')
    await expect(
      service.start({ ...args, output: args.videoInput })
    ).rejects.toThrow('mediaMerge.outputExists')
    expect(await readFile(args.output, 'utf8')).toBe('existing')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not overwrite a file created during the merge', async () => {
    invoke.mockImplementation(async (_p, _c, values: MediaMergeArgs) => {
      await writeFile(values.output, 'merged')
      await writeFile(args.output, 'racing writer')
      return { outputPath: values.output }
    })
    const job = await service.start(args)
    await completion
    expect(service.get(job.id).status).toBe('failed')
    expect(await readFile(args.output, 'utf8')).toBe('racing writer')
    expect(await readdir(dir)).toHaveLength(3)
    expect(logs.getTail(pluginId, 1)[0]).toMatchObject({
      event: 'media-merge.failed',
      level: 'error',
      stage: 'saving',
      errorCode: 'EEXIST',
      jobId: job.id,
    })
    expect(
      logs
        .getTail(pluginId, 100)
        .some((entry) => entry.event === 'media-merge.completed')
    ).toBe(false)
    expect(JSON.stringify(logs.getTail(pluginId, 100))).not.toContain(dir)
  })

  it('cleans temporary data when the plugin fails', async () => {
    invoke.mockImplementation(async (_p, _c, values: MediaMergeArgs) => {
      await writeFile(values.output, 'partial')
      throw new Error('unsupported codec')
    })
    const job = await service.start(args)
    await completion
    expect(service.get(job.id)).toMatchObject({
      status: 'failed',
      error: 'unsupported codec',
    })
    expect(logs.getTail(pluginId, 1)[0]).toMatchObject({
      event: 'media-merge.failed',
      level: 'error',
      stage: 'running',
      reason: 'unsupported codec',
      jobId: job.id,
    })
    expect((await readdir(dir)).sort()).toEqual(['audio.mp4', 'video.mp4'])
  })

  it('cancels a running operation and blocks concurrent starts until drained', async () => {
    invoke.mockImplementation(
      async (
        _p,
        _c,
        _values,
        { mediaMerge }: { mediaMerge: ManualMergeContext }
      ) => {
        await new Promise<void>((resolve) =>
          mediaMerge.signal.addEventListener('abort', () => resolve(), {
            once: true,
          })
        )
        throw new Error('aborted')
      }
    )
    const job = await service.start(args)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    await expect(service.start(args)).rejects.toThrow('mediaMerge.busy')
    expect(service.cancel(job.id).status).toBe('cancelling')
    service.cancel(job.id)
    await completion
    expect(service.get(job.id).status).toBe('cancelled')
    expect(logs.getTail(pluginId, 100).map((entry) => entry.event)).toEqual([
      'media-merge.started',
      'media-merge.rejected',
      'media-merge.cancel-requested',
      'media-merge.cancelled',
    ])
    expect(logs.getTail(pluginId, 1)[0]).toMatchObject({
      level: 'info',
      jobId: job.id,
    })
    expect((await readdir(dir)).sort()).toEqual(['audio.mp4', 'video.mp4'])
  })

  it('only offers enabled plugins with the public merger command', async () => {
    expect(service.providers()).toEqual([{ pluginId, title: 'Merger' }])
    enabled = false
    expect(service.providers()).toEqual([])
    await expect(service.start(args)).rejects.toThrow(
      'mediaMerge.pluginUnavailable'
    )
  })

  it('rejects missing, identical, relative, empty or unsupported inputs/outputs', async () => {
    await expect(
      service.start({ ...args, audioInput: args.videoInput })
    ).rejects.toThrow('mediaMerge.sameInput')
    await expect(
      service.start({ ...args, videoInput: 'relative.mp4' })
    ).rejects.toThrow('mediaMerge.absolutePaths')
    await expect(
      service.start({ ...args, output: path.join(dir, 'out.txt') })
    ).rejects.toThrow('mediaMerge.outputFormat')
    await writeFile(args.audioInput, '')
    await expect(service.start(args)).rejects.toThrow('mediaMerge.invalidFiles')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('accepts two complete single-file downloads and rejects other selections', () => {
    tasks.set('v', {
      status: TaskStatus.Completed,
      fileCount: 1,
      finalPath: args.videoInput,
    })
    tasks.set('a', {
      status: TaskStatus.Completed,
      fileCount: 1,
      finalPath: args.audioInput,
    })
    expect(service.selection(['v', 'a'])).toMatchObject({
      videoInput: args.videoInput,
      audioInput: args.audioInput,
    })
    expect(() => service.selection(['v', 'v'])).toThrow(
      'mediaMerge.invalidSelection'
    )
    tasks.set('a', {
      status: TaskStatus.Downloading,
      finalPath: args.audioInput,
    })
    expect(() => service.selection(['v', 'a'])).toThrow(
      'mediaMerge.invalidSelection'
    )
  })
  it('logs a preparation failure without starting a job or leaking its missing path', async () => {
    const missing = path.join(dir, 'missing.mp4')
    await expect(
      service.start({ ...args, videoInput: missing })
    ).rejects.toThrow('ENOENT')
    const entries = logs.getTail(pluginId, 100)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      event: 'media-merge.failed',
      stage: 'preparing',
      errorCode: 'ENOENT',
      reason: expect.stringContaining('missing.mp4'),
    })
    expect(JSON.stringify(entries)).not.toContain(dir)
    expect(invoke).not.toHaveBeenCalled()
    expect(service.state().job).toBeNull()
  })

  it('does not create a log destination for an unknown plugin ID', async () => {
    await expect(
      service.start({ ...args, pluginId: '../../elsewhere' })
    ).rejects.toThrow('mediaMerge.pluginUnavailable')
    expect(createLog).not.toHaveBeenCalled()
  })

  it('keeps successful output and cleanup independent of logging failures', async () => {
    createLog.mockImplementation(() => {
      throw new Error('log unavailable')
    })
    const job = await service.start(args)
    await completion
    expect(service.get(job.id).status).toBe('completed')
    expect(await readFile(args.output, 'utf8')).toBe('video+audio')
    expect((await readdir(dir)).sort()).toEqual([
      'audio.mp4',
      'merged.mp4',
      'video.mp4',
    ])
    expect(service.state().job).toBeNull()
  })

  it('keeps explicit verbose paths and delivers log events to existing subscribers', async () => {
    logs.setVerbose(pluginId, true)
    const received = vi.fn()
    const unsubscribe = logs.subscribe(received)
    const job = await service.start(args)
    await completion
    expect(received).toHaveBeenCalledTimes(2)
    expect(received).toHaveBeenLastCalledWith(
      pluginId,
      expect.objectContaining({
        event: 'media-merge.completed',
        jobId: job.id,
        files: {
          video: { path: args.videoInput },
          audio: { path: args.audioInput },
          output: { path: args.output },
        },
      })
    )
    unsubscribe()
  })
})
