import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  stat,
  statfs,
} from 'node:fs/promises'
import path from 'node:path'
import type {
  OperationDefinition,
  OperationFileBinding,
} from '@motrix/plugin-manifest-schema'
import { AppError, ErrorCode } from '@shared/errors'
import type { OperationFileView } from '@shared/schemas/plugin-operations'
import type {
  FfmpegCapabilityHost,
  FfmpegOpHandle,
} from '../capabilities/ffmpeg'
import {
  type FinalizeArtifactHandle,
  FinalizeFsError,
  type FinalizeRootHandle,
  NativeFinalizeFilesystemAdapter,
} from '../finalize/filesystem-adapter'

export function operationError(reason: string): never {
  throw new AppError(ErrorCode.PluginRuntimeFault, `pluginOperations.${reason}`)
}
interface Grant {
  field: string
  binding: OperationFileBinding
  view: OperationFileView
  root: FinalizeRootHandle
  selected?: FinalizeArtifactHandle
  source: string
  identity: string
  stamp?: string
  extension: string
  snapshot?: string
}
export interface OperationExecution {
  jobId: string
  signal: AbortSignal
  dispatch(method: string, args: unknown[]): Promise<unknown>
  seal(): void
  drain(): Promise<void>
}

/** One draft owns a dedicated native process; cancelling it never kills download work. */
export class OperationFiles {
  readonly native: NativeFinalizeFilesystemAdapter
  private readonly grants = new Map<string, Grant>()
  private readonly preferredOutputs = new Map<string, string>()
  private privateDirectory?: string
  private privateIdentity?: string
  private privateRoot?: FinalizeRootHandle
  private pending = new Set<Promise<unknown>>()
  private mediaHandles = new Set<FfmpegOpHandle<{ outputPath: string }>>()
  private written = new Set<string>()
  private closed = false
  private nativeAborted = false
  private abortWork?: Promise<void>
  private outputStage?: {
    parent: FinalizeRootHandle
    root: FinalizeRootHandle
    name: string
    identity: string
    path: string
  }
  private inputBytes = new Map<string, bigint>()
  private probeCount = 0
  private activeProbes = 0
  private textReads = 0
  private mergeCount = 0
  private progressWindow = { since: 0, count: 0 }

  constructor(
    private readonly deps: {
      binary: string
      storage: string
      definition: OperationDefinition
      assertAllowed(): void
      authorizePath?(candidate: string, mode: 'input' | 'output'): Promise<void>
      ffmpeg: FfmpegCapabilityHost
    }
  ) {
    this.native = new NativeFinalizeFilesystemAdapter(deps.binary)
  }

  private check() {
    if (this.closed) operationError('cancelled')
    this.deps.assertAllowed()
  }

  async pick(
    field: string,
    candidate: string,
    values: Record<string, unknown>
  ): Promise<OperationFileView> {
    this.check()
    const binding = this.deps.definition.files?.[field]
    if (!binding || !path.isAbsolute(candidate) || candidate.includes('\0'))
      operationError('invalidFile')
    const output = binding.kind === 'output-file'
    await this.deps.authorizePath?.(candidate, output ? 'output' : 'input')
    const location = output
      ? path.join(
          await realpath(path.dirname(candidate)),
          path.basename(candidate)
        )
      : await realpath(candidate)
    await this.deps.authorizePath?.(location, output ? 'output' : 'input')
    const name = path.basename(location)
    if ((await this.native.sanitizeName(name)) !== name)
      operationError('invalidFile')
    const extension = path.extname(name).slice(1).toLowerCase()
    const allowed =
      binding.kind === 'output-file' && binding.extensionFrom
        ? [values[binding.extensionFrom]]
        : binding.extensions
    if (allowed && !allowed.includes(extension)) operationError('fileType')
    if (output) {
      try {
        await lstat(location)
        operationError('outputExists')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    }
    const parent = await this.native.openRoot(
      path.dirname(location),
      undefined,
      !output
    )
    let selected: FinalizeArtifactHandle | undefined
    try {
      let selectedStamp: string | undefined
      let identity = parent.identity ?? ''
      if (!output) {
        const before = await stat(location, { bigint: true })
        if (
          !before.isFile() ||
          before.size <= 0n ||
          (binding.use === 'text' && before.size > 1048576n)
        )
          operationError('invalidFile')
        if (before.size > 8n * 1024n ** 3n) operationError('resourceLimit')
        this.inputBytes.set(field, before.size)
        selected = await this.native.openSelectedFile(parent, name)
        const after = await stat(location, { bigint: true })
        const stamp = (s: typeof before) =>
          `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
        if (stamp(before) !== stamp(after)) operationError('fileChanged')
        selectedStamp = stamp(after)
        identity = `${before.dev}:${before.ino}`
      }
      this.check()
      const previous = this.grants.get(field)
      const view = { ref: randomUUID(), name, location }
      this.grants.set(field, {
        field,
        binding,
        view,
        root: parent,
        selected,
        source: location,
        identity,
        extension,
        stamp: selectedStamp,
      })
      if (output) this.preferredOutputs.set(field, location)
      if (previous) {
        if (previous.selected) await this.native.close(previous.selected)
        await this.native.close(previous.root)
      }
      // A suggested output derived from a replaced input must be confirmed again.
      for (const [key, grant] of this.grants) {
        if (
          key !== field &&
          grant.binding.kind === 'output-file' &&
          grant.binding.suggestedName?.stemFrom === field
        ) {
          this.preferredOutputs.delete(key)
          this.grants.delete(key)
          await this.native.close(grant.root)
        }
      }
      return view
    } catch (e) {
      if (selected) await this.native.close(selected).catch(() => undefined)
      await this.native.close(parent).catch(() => undefined)
      throw e
    }
  }

  views(): Record<string, OperationFileView> {
    return Object.fromEntries(
      [...this.grants].map(([key, value]) => [key, value.view])
    )
  }

  picker(field: string, values: Record<string, unknown>) {
    const binding = this.deps.definition.files?.[field]
    if (!binding) operationError('invalidFile')
    const extensions =
      binding.kind === 'output-file' && binding.extensionFrom
        ? [String(values[binding.extensionFrom] ?? '')]
        : binding.extensions
    let defaultPath =
      this.grants.get(field)?.source ?? this.preferredOutputs.get(field)
    if (defaultPath && binding.kind === 'output-file' && extensions?.[0])
      defaultPath = path.join(
        path.dirname(defaultPath),
        `${path.parse(defaultPath).name}.${extensions[0]}`
      )
    if (
      !defaultPath &&
      binding.kind === 'output-file' &&
      binding.suggestedName
    ) {
      const input = this.grants.get(binding.suggestedName.stemFrom)
      if (input && extensions?.[0])
        defaultPath = path.join(
          path.dirname(input.source),
          `${path.parse(input.source).name}${binding.suggestedName.suffix}.${extensions[0]}`
        )
    }
    return {
      kind:
        binding.kind === 'output-file' ? ('save' as const) : ('open' as const),
      extensions,
      defaultPath,
    }
  }

  async synchronize(values: Record<string, unknown>): Promise<void> {
    this.check()
    for (const [key, grant] of this.grants) {
      if (
        grant.binding.kind === 'output-file' &&
        grant.binding.extensionFrom &&
        values[grant.binding.extensionFrom] !== grant.extension
      ) {
        this.grants.delete(key)
        await this.native.close(grant.root)
      }
    }
  }

  suggestions(values: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.deps.definition.files ?? {}).flatMap(
        ([field, binding]) => {
          if (binding.kind !== 'output-file' || this.grants.has(field))
            return []
          const candidate = this.picker(field, values).defaultPath
          return candidate ? [[field, candidate]] : []
        }
      )
    )
  }

  repeatInputs(): { field: string; source: string; stamp: string }[] {
    return [...this.grants.values()].flatMap((grant) =>
      grant.selected && grant.stamp
        ? [{ field: grant.field, source: grant.source, stamp: grant.stamp }]
        : []
    )
  }

  async restoreInput(
    input: { field: string; source: string; stamp: string },
    values: Record<string, unknown>
  ): Promise<void> {
    if (this.deps.definition.files?.[input.field]?.kind !== 'input-file')
      operationError('invalidGrant')
    const s = await stat(input.source, { bigint: true })
    if (`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` !== input.stamp)
      operationError('fileChanged')
    await this.pick(input.field, input.source, values)
    if (this.grants.get(input.field)?.stamp !== input.stamp)
      operationError('fileChanged')
  }

  validate(args: Record<string, unknown>): void {
    this.check()
    for (const [key, binding] of Object.entries(
      this.deps.definition.files ?? {}
    )) {
      const grant = this.grants.get(key)
      if (!grant || args[key] !== grant.view.ref) operationError('invalidGrant')
      if (
        binding.kind === 'output-file' &&
        binding.extensionFrom &&
        grant.extension !== args[binding.extensionFrom]
      )
        operationError('invalidGrant')
    }
  }

  async prepare(checkpoint?: (state: object) => Promise<void>): Promise<void> {
    this.check()
    await mkdir(this.deps.storage, { recursive: true, mode: 0o700 })
    const storage = await realpath(this.deps.storage)
    const total = [...this.inputBytes.values()].reduce(
      (sum, size) => sum + size,
      0n
    )
    const space = await statfs(storage, { bigint: true })
    if (
      total > 16n * 1024n ** 3n ||
      space.bavail * space.bsize < total * 3n + 64n * 1024n ** 2n
    )
      operationError('resourceLimit')
    const parent = await this.native.openRoot(storage)
    const name = `job-${randomUUID()}`
    this.privateRoot = await this.native.createPrivateRoot(parent, name)
    this.privateDirectory = path.join(storage, name)
    const s = await lstat(this.privateDirectory, { bigint: true })
    this.privateIdentity = `${s.dev}:${s.ino}`
    await this.native.close(parent)
    const capabilities = await this.native.capabilities()
    if (
      !capabilities.heldRoots ||
      !capabilities.heldArtifacts ||
      !capabilities.renameNoReplace
    )
      operationError('unsupported')
    await checkpoint?.({
      directory: this.privateDirectory,
      privateIdentity: this.privateIdentity,
    })
    for (const grant of this.grants.values()) {
      this.check()
      const relative = `${grant.view.ref}.${grant.extension || 'input'}`
      grant.snapshot = path.join(this.privateDirectory, relative)
      if (grant.selected) {
        // Give a stable, actionable error for changes already visible before
        // copying. The native held-handle checks still guard races during IO.
        const current = await stat(grant.source, { bigint: true }).catch(() =>
          operationError('fileChanged')
        )
        if (
          `${current.dev}:${current.ino}:${current.size}:${current.mtimeNs}:${current.ctimeNs}` !==
          grant.stamp
        )
          operationError('fileChanged')
        await this.track(
          this.native.copySelectedFile(
            grant.selected,
            this.privateRoot,
            relative
          )
        )
      }
    }
    this.check()
  }

  private file(
    ref: unknown,
    kind: OperationFileBinding['kind'],
    use?: 'media' | 'text'
  ): Grant {
    this.check()
    const grant = [...this.grants.values()].find((g) => g.view.ref === ref)
    if (
      !grant ||
      grant.binding.kind !== kind ||
      (use && grant.binding.use !== use) ||
      !grant.snapshot
    )
      operationError('invalidGrant')
    return grant
  }
  private async track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    try {
      return await promise
    } finally {
      this.pending.delete(promise)
    }
  }

  execution(
    jobId: string,
    signal: AbortSignal,
    progress: (percent: number | null) => void
  ): OperationExecution {
    const dispatch = async (
      method: string,
      args: unknown[]
    ): Promise<unknown> => {
      this.check()
      signal.throwIfAborted()
      if (method === 'progress') {
        const now = Date.now()
        if (now - this.progressWindow.since > 1000)
          this.progressWindow = { since: now, count: 0 }
        if (++this.progressWindow.count > 20) operationError('resourceLimit')
        const value = args[0] as { fraction?: unknown }
        if (
          typeof value?.fraction === 'number' &&
          Number.isFinite(value.fraction)
        )
          progress(Math.min(99, Math.max(0, value.fraction * 100)))
        return undefined
      }
      if (method === 'probe') {
        const file = this.file(args[0], 'input-file', 'media')
        if (++this.probeCount > 4 || this.activeProbes >= 2)
          operationError('resourceLimit')
        this.activeProbes++
        try {
          const info = await this.track(
            this.deps.ffmpeg.probe({
              path: file.snapshot as string,
              localOnly: true,
              signal,
            })
          )
          return {
            durationMs: info.durationMs,
            streams: info.streams.slice(0, 32).map((s) => ({
              type: ['video', 'audio', 'subtitle'].includes(s.type)
                ? s.type
                : 'other',
              codec: s.codec?.slice(0, 64),
            })),
          }
        } finally {
          this.activeProbes--
        }
      }
      if (method === 'mergeStreams') {
        const value = args[0] as Record<string, unknown>
        const video = this.file(value?.video, 'input-file', 'media')
        const audio = this.file(value?.audio, 'input-file', 'media')
        const output = this.file(value?.output, 'output-file', 'media')
        if (video.identity === audio.identity || video === audio)
          operationError('sameInput')
        if (
          !['mp4', 'mkv'].includes(String(value.format)) ||
          output.extension !== value.format
        )
          operationError('fileType')
        if (++this.mergeCount > 1 || this.written.has(output.view.ref))
          operationError('resourceLimit')
        this.written.add(output.view.ref)
        const handle = this.deps.ffmpeg.mergeStreams({
          videoInput: video.snapshot as string,
          audioInput: audio.snapshot as string,
          output: output.snapshot as string,
          signal,
          localOnly: true,
          expectedDurationMs:
            typeof value.expectedDurationMs === 'number' &&
            Number.isFinite(value.expectedDurationMs)
              ? Math.max(0, value.expectedDurationMs)
              : 0,
        })
        this.mediaHandles.add(handle)
        void handle.result.catch(() => undefined)
        const pump = (async () => {
          for await (const p of handle.progress)
            progress(Math.min(99, Math.max(0, p.percent)))
        })()
        let quotaExceeded = false
        let checking = false
        const maximum =
          [...this.inputBytes.values()].reduce((sum, size) => sum + size, 0n) +
          64n * 1024n ** 2n
        const monitor = setInterval(() => {
          if (checking) return
          checking = true
          void lstat(output.snapshot as string, { bigint: true })
            .then(async (file) => {
              const space = await statfs(this.privateDirectory as string, {
                bigint: true,
              })
              if (
                file.size > maximum ||
                space.bavail * space.bsize < 64n * 1024n ** 2n
              ) {
                quotaExceeded = true
                handle.abort()
              }
            })
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') {
                quotaExceeded = true
                handle.abort()
              }
            })
            .finally(() => {
              checking = false
            })
        }, 1000)
        monitor.unref()
        try {
          await this.track(Promise.all([handle.result, pump]))
        } catch (error) {
          if (quotaExceeded) operationError('resourceLimit')
          throw error
        } finally {
          clearInterval(monitor)
        }
        return undefined
      }
      if (method === 'readText') {
        const file = this.file(args[0], 'input-file', 'text')
        if (++this.textReads > 4) operationError('resourceLimit')
        const input = await open(
          file.snapshot as string,
          constants.O_RDONLY | constants.O_NOFOLLOW
        )
        try {
          const size = (await input.stat()).size
          if (size > 1048576) operationError('resourceLimit')
          const buffer = Buffer.alloc(size + 1)
          const { bytesRead } = await input.read(buffer, 0, buffer.length, 0)
          if (bytesRead !== size) operationError('fileChanged')
          return new TextDecoder('utf-8', { fatal: true }).decode(
            buffer.subarray(0, size)
          )
        } finally {
          await input.close()
        }
      }
      if (method === 'writeText') {
        const file = this.file(args[0], 'output-file', 'text')
        const content = args[1]
        if (
          typeof content !== 'string' ||
          Buffer.byteLength(content) > 1048576 ||
          this.written.has(file.view.ref)
        )
          operationError('resourceLimit')
        this.written.add(file.view.ref)
        const output = await open(file.snapshot as string, 'wx', 0o600)
        try {
          await output.writeFile(content)
          await output.sync()
        } finally {
          await output.close()
        }
        return undefined
      }
      operationError('unsupported')
    }
    return {
      jobId,
      signal,
      dispatch: (method, args) => this.track(dispatch(method, args)),
      seal: () => this.seal(),
      drain: () => this.drain(),
    }
  }

  seal(): void {
    if (this.closed) return
    this.closed = true
    for (const handle of this.mediaHandles) handle.abort()
    this.nativeAborted = true
    this.abortWork = this.native.abort()
    void this.abortWork.catch(() => undefined)
  }
  async drain(): Promise<void> {
    if (this.abortWork) await this.abortWork
    await Promise.allSettled([
      ...this.pending,
      ...[...this.mediaHandles].map((h) => h.result),
    ])
  }

  async validateOutput(
    result: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Grant | undefined> {
    this.check()
    const output = [...this.grants.values()].find(
      (g) => g.binding.kind === 'output-file'
    )
    if (!output) return undefined
    if (
      result[output.field] !== output.view.ref ||
      !output.snapshot ||
      !this.written.has(output.view.ref)
    )
      operationError('invalidOutput')
    const file = await lstat(output.snapshot)
    if (
      !file.isFile() ||
      file.size === 0 ||
      (output.binding.use === 'text' && file.size > 1048576)
    )
      operationError('invalidOutput')
    if (output.binding.use === 'media') {
      const info = await this.track(
        this.deps.ffmpeg.probe({
          path: output.snapshot,
          localOnly: true,
          signal,
        })
      )
      if (
        !info.streams.some((s) => s.type === 'video') ||
        !info.streams.some((s) => s.type === 'audio') ||
        !(output.extension === 'mp4'
          ? info.format?.includes('mov') || info.format?.includes('mp4')
          : info.format?.includes('matroska'))
      )
        operationError('invalidOutput')
    }
    return output
  }

  /** Copy into a held private target root before entering the publication gate. */
  async stageOutput(
    output: Grant,
    checkpoint: (state: object) => Promise<void>
  ): Promise<void> {
    this.check()
    if (!this.privateRoot || !output.snapshot) operationError('invalidOutput')
    const name = `.motrix-operation-${randomUUID()}`
    const root = await this.native.createPrivateRoot(output.root, name)
    this.outputStage = {
      parent: output.root,
      root,
      name,
      identity: root.identity as string,
      path: path.join(path.dirname(output.source), name),
    }
    await checkpoint({
      directory: this.privateDirectory,
      privateIdentity: this.privateIdentity,
      targetStage: { path: this.outputStage.path, identity: root.identity },
      output: output.source,
    })
    const file = await this.native.openSelectedFile(
      this.privateRoot,
      path.basename(output.snapshot)
    )
    await this.track(this.native.copySelectedFile(file, root, 'output'))
    await this.native.close(file)
    this.check()
  }
  async publish(output: Grant): Promise<string> {
    const current = await this.native.openRoot(
      path.dirname(output.source),
      output.root.identity
    )
    await this.native.close(current)
    if (!this.outputStage) operationError('invalidOutput')
    const file = await this.native.openArtifact(
      this.outputStage.root,
      'output',
      'rename'
    )
    try {
      await this.native.renameOpenedNoReplace(
        file,
        output.root,
        path.basename(output.source)
      )
    } catch (error) {
      if (error instanceof FinalizeFsError && error.code === 'target_exists')
        operationError('outputExists')
      throw error
    } finally {
      await this.native.close(file).catch(() => undefined)
    }
    return output.source
  }

  async cleanup(): Promise<boolean> {
    await this.drain()
    let clean = true
    if (this.outputStage) {
      const adapter = this.nativeAborted
        ? new NativeFinalizeFilesystemAdapter(this.deps.binary)
        : this.native
      try {
        const stage = this.outputStage
        const parent = this.nativeAborted
          ? await adapter.openRoot(path.dirname(stage.path))
          : stage.parent
        const root = this.nativeAborted
          ? await adapter.openRoot(stage.path)
          : stage.root
        if (root.identity !== stage.identity) operationError('fileChanged')
        try {
          const artifact = await adapter.openArtifact(root, 'output')
          await adapter.removeOpened(artifact, '.discard', false)
          await adapter.close(artifact)
        } catch (error) {
          // Only an absent output is benign; mutation/conflict is preserved.
          if (
            !['not_found', 'path_not_found'].includes(
              String((error as { code?: string }).code)
            )
          ) {
            try {
              await lstat(path.join(stage.path, 'output'))
              throw error
            } catch (missing) {
              if ((missing as NodeJS.ErrnoException).code !== 'ENOENT')
                throw missing
            }
          }
        }
        await adapter.removePrivateRoot(parent, stage.name, root)
      } catch {
        clean = false
      } finally {
        if (this.nativeAborted) await adapter.dispose()
      }
    }
    await this.native.dispose()
    if (this.privateDirectory) {
      try {
        const s = await lstat(this.privateDirectory, { bigint: true })
        if (s.isSymbolicLink() || `${s.dev}:${s.ino}` !== this.privateIdentity)
          operationError('fileChanged')
        await rm(this.privateDirectory, { recursive: true })
      } catch {
        clean = false
      }
    }
    return clean
  }
}
