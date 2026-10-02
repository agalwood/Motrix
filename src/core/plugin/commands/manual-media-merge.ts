import { randomUUID } from 'node:crypto'
import { link, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import {
  MEDIA_MERGE_COMMAND,
  type MediaMergeJob,
  type MediaMergeProvider,
  mediaMergeJobIdSchema,
  mediaMergeSelectionSchema,
  mediaMergeStartSchema,
} from '@shared/schemas/manual-media-merge'
import { TaskStatus } from '@shared/types/task'
import type { TaskManager } from '../../task/task-manager'
import type { PluginLogCapability } from '../capabilities/interface'
import type { PluginHost } from '../host/plugin-host'
import type { PluginRegistry } from '../plugin-registry'
import { SchemaCache } from './schema-cache'

interface Dependencies {
  registry: PluginRegistry
  host: PluginHost
  tasks: TaskManager
  createLog: (pluginId: string) => PluginLogCapability
  authorizePath?: (file: string) => Promise<unknown>
  /** Keep shutdown aware of the background operation. */
  runWork?: <T>(work: () => Promise<T>) => Promise<T>
}

function fail(reason: string): never {
  throw new AppError(ErrorCode.PluginRuntimeFault, `mediaMerge.${reason}`)
}

/** One bounded job per host; files are published only after the plugin succeeds. */
export class ManualMediaMerge {
  private jobs = new Map<string, MediaMergeJob>()
  private active: { id: string; abort: AbortController } | undefined

  constructor(private readonly deps: Dependencies) {}

  private log(
    pluginId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    fields: Record<string, unknown>
  ): void {
    try {
      this.deps.createLog(pluginId)[level](message, fields)
    } catch {
      // Log destinations must not change a merge result or prevent cleanup.
    }
  }

  state() {
    return {
      providers: this.providers(),
      job: this.active ? (this.jobs.get(this.active.id) ?? null) : null,
    }
  }

  providers(): MediaMergeProvider[] {
    return this.deps.registry.list().flatMap((entry) => {
      const plugin = this.deps.registry.get(entry.id)
      const command = plugin?.manifest.contributes.commands?.find(
        (cmd) => cmd.id === `${entry.id}.${MEDIA_MERGE_COMMAND}` && cmd.public
      )
      return entry.enabled &&
        command &&
        plugin?.manifest.permissions.includes('ffmpeg')
        ? [{ pluginId: entry.id, title: entry.name }]
        : []
    })
  }

  selection(value: unknown): {
    videoInput: string
    audioInput: string
    output: string
  } {
    const ids = mediaMergeSelectionSchema.parse(value)
    if (ids[0] === ids[1]) fail('invalidSelection')
    const files = ids.map((id) => {
      const task = this.deps.tasks.getById(id)
      if (
        !task ||
        task.status !== TaskStatus.Completed ||
        task.fileCount > 1 ||
        !task.finalPath
      )
        fail('invalidSelection')
      return task.finalPath
    })
    const videoInput = files[0]
    const audioInput = files[1]
    return {
      videoInput,
      audioInput,
      output: path.join(
        path.dirname(videoInput),
        `${path.parse(videoInput).name}-merged.mp4`
      ),
    }
  }

  get(value: unknown): MediaMergeJob {
    const job = this.jobs.get(mediaMergeJobIdSchema.parse(value))
    if (!job) fail('jobMissing')
    return { ...job }
  }

  cancel(value: unknown): MediaMergeJob {
    const job = this.get(value)
    if (this.active?.id === job.id && job.status === 'running') {
      const stored = this.jobs.get(job.id)
      if (stored) stored.status = 'cancelling'
      this.log(job.pluginId, 'info', 'Media merge cancellation requested', {
        event: 'media-merge.cancel-requested',
        jobId: job.id,
      })
      this.active.abort.abort()
    }
    return this.get(job.id)
  }

  async start(value: unknown): Promise<MediaMergeJob> {
    const request = mediaMergeStartSchema.parse(value)
    const reject = (reason: string): never => {
      // Never open a log destination for an unrecognized renderer-supplied ID.
      if (this.deps.registry.get(request.pluginId))
        this.log(request.pluginId, 'warn', 'Media merge could not start', {
          event: 'media-merge.rejected',
          reason: `mediaMerge.${reason}`,
        })
      return fail(reason)
    }
    if (this.active) reject('busy')
    if (!this.providers().some((p) => p.pluginId === request.pluginId))
      reject('pluginUnavailable')
    const id = randomUUID()
    const abort = new AbortController()
    this.active = { id, abort }
    let staging: string | undefined
    const startedAt = performance.now()
    let stage = 'preparing'
    let terminalLogged = false
    const files = {
      video: { path: request.videoInput },
      audio: { path: request.audioInput },
      output: { path: request.output },
    }
    const failureDetails = (error: unknown) => {
      let reason = error instanceof Error ? error.message : String(error)
      // Keep file locations in structured path fields, where the existing
      // plugin logger applies its normal/verbose path policy. OS errors can
      // also embed the input or staging paths in their free-form message.
      const locations = [
        request.videoInput,
        request.audioInput,
        request.output,
        ...Object.values(files).map((file) => file.path),
        ...(staging ? [staging] : []),
      ]
      const paths = [
        ...new Set(locations.flatMap((file) => [file, path.dirname(file)])),
      ]
        .filter(
          (file) => path.isAbsolute(file) && file !== path.parse(file).root
        )
        .sort((a, b) => b.length - a.length)
      for (const file of paths)
        reason = reason.replaceAll(file, path.basename(file))
      return {
        reason,
        ...(error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? { errorCode: error.code }
          : {}),
      }
    }
    const finishLog = (
      status: 'completed' | 'cancelled' | 'failed',
      error?: unknown
    ) => {
      if (terminalLogged) return
      terminalLogged = true
      this.log(
        request.pluginId,
        status === 'failed' ? 'error' : 'info',
        `Media merge ${status}`,
        {
          event: `media-merge.${status}`,
          jobId: id,
          stage,
          format: path.extname(files.output.path).slice(1).toLowerCase(),
          files,
          durationMs: Math.round(performance.now() - startedAt),
          ...(error !== undefined && status === 'failed'
            ? failureDetails(error)
            : {}),
        }
      )
    }
    try {
      if (
        ![request.videoInput, request.audioInput, request.output].every(
          path.isAbsolute
        )
      )
        fail('absolutePaths')
      const [videoInput, audioInput] = await Promise.all([
        realpath(request.videoInput),
        realpath(request.audioInput),
      ])
      files.video.path = videoInput
      files.audio.path = audioInput
      await this.deps.authorizePath?.(videoInput)
      await this.deps.authorizePath?.(audioInput)
      const [videoStat, audioStat] = await Promise.all([
        stat(videoInput),
        stat(audioInput),
      ])
      if (
        !videoStat.isFile() ||
        !audioStat.isFile() ||
        !videoStat.size ||
        !audioStat.size
      )
        fail('invalidFiles')
      if (
        videoInput === audioInput ||
        (videoStat.dev === audioStat.dev && videoStat.ino === audioStat.ino)
      )
        fail('sameInput')
      const outputDir = await realpath(path.dirname(request.output))
      const output = path.join(outputDir, path.basename(request.output))
      files.output.path = output
      await this.deps.authorizePath?.(output)
      if (!/\.(mp4|mkv)$/i.test(output)) fail('outputFormat')
      try {
        await lstat(output)
        fail('outputExists')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      staging = await mkdtemp(path.join(outputDir, '.motrix-merge-'))
      const stagedOutput = path.join(staging, path.basename(output))
      const job: MediaMergeJob = {
        id,
        pluginId: request.pluginId,
        status: 'running',
        percent: null,
        output,
      }
      // Keep a bounded history so navigation/reconnect can retrieve recent results.
      while (this.jobs.size >= 20)
        this.jobs.delete(this.jobs.keys().next().value as string)
      this.jobs.set(id, job)
      this.log(request.pluginId, 'info', 'Media merge started', {
        event: 'media-merge.started',
        jobId: id,
        files,
        format: path.extname(output).slice(1).toLowerCase(),
      })
      const directory = staging
      const work = async () => {
        try {
          stage = 'running'
          const plugin = this.deps.registry.get(request.pluginId)
          if (!plugin?.state.enabled) fail('pluginUnavailable')
          const commandId = `${request.pluginId}.${MEDIA_MERGE_COMMAND}`
          const schemas = new SchemaCache()
          schemas.installCommandSchemas(
            request.pluginId,
            plugin.manifest.contributes.commands ?? []
          )
          const args = { videoInput, audioInput, output: stagedOutput }
          schemas.validateArgs(request.pluginId, commandId, args)
          await this.deps.host.activate(request.pluginId)
          abort.signal.throwIfAborted()
          const result = await this.deps.host.invokeCommand(
            request.pluginId,
            commandId,
            args,
            {
              mediaMerge: {
                ...args,
                signal: abort.signal,
                onProgress: (progress) => {
                  job.percent = Math.min(99, Math.max(0, progress.percent))
                },
              },
            }
          )
          stage = 'saving'
          schemas.validateResult(request.pluginId, commandId, result)
          abort.signal.throwIfAborted()
          if (
            !(await lstat(stagedOutput)).isFile() ||
            !(await stat(stagedOutput)).size
          )
            fail('invalidOutput')
          // Same-filesystem hard-link publication is atomic and never replaces an
          // existing file, including one created while FFmpeg was running.
          await link(stagedOutput, output)
          job.status = 'completed'
          job.percent = 100
          finishLog('completed')
        } catch (error) {
          job.status = abort.signal.aborted ? 'cancelled' : 'failed'
          if (job.status === 'failed')
            job.error = error instanceof Error ? error.message : String(error)
          finishLog(job.status, error)
        } finally {
          await rm(directory, { recursive: true, force: true }).catch(
            (error: unknown) => {
              this.log(
                request.pluginId,
                'warn',
                'Media merge temporary files could not be removed',
                {
                  event: 'media-merge.cleanup-failed',
                  jobId: id,
                  ...failureDetails(error),
                }
              )
            }
          )
          this.active = undefined
        }
      }
      const running = this.deps.runWork ? this.deps.runWork(work) : work()
      void running.catch((error: unknown) => {
        job.status = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        finishLog('failed', error)
        this.active = undefined
      })
      return { ...job }
    } catch (error) {
      finishLog('failed', error)
      if (staging)
        await rm(staging, { recursive: true, force: true }).catch(
          () => undefined
        )
      this.active = undefined
      throw error
    }
  }
}
