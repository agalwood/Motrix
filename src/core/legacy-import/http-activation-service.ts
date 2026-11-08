import { createHash, randomUUID } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { newEngineTaskId } from '@core/lib/ids'
import type { AppliedDownloadProxyPolicyReader } from '@core/proxy/applied-download-proxy-policy'
import type {
  MotrixDatabase,
  TaskWithInstances,
} from '@core/session/motrix-database'
import { DirectResourceValidatorService } from '@core/task/direct-resource-validator'
import { outputPathIdentity } from '@core/task/output-path-identity'
import type { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import { AppError, ErrorCode } from '@shared/errors'
import { legacyCheckpointInspectionSchema } from '@shared/schemas/legacy-checkpoint'
import {
  type LegacyHttpActivation,
  legacyHttpActivationSchema,
} from '@shared/schemas/legacy-http-activation'
import { legacyTaskMetadataSchema } from '@shared/schemas/legacy-import'
import { TaskStatus, TaskType } from '@shared/types/task'
import {
  type LegacyHttpRequestContext,
  resolveLegacyHttpRequestContext,
} from './http-request-context'
import { isUnresolvedLegacyMagnet } from './legacy-task-policy'
import { authorizeLegacySource, readLegacyFile } from './source-scanner'

export interface LegacyHttpActivationDeps {
  db: MotrixDatabase
  taskManager: TaskManager
  adapter: EngineAdapter
  backupRoot: string
  proxyPolicy: AppliedDownloadProxyPolicyReader
  isProcessRunning: (pid: number) => boolean | Promise<boolean>
  publishTasks: () => void
  runTaskMutation: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  runExclusivePersistence: <T>(operation: () => T | Promise<T>) => Promise<T>
  verifier?: Pick<DirectResourceValidatorService, 'verifyLegacyContent'>
}
const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
const failure = (key: string) =>
  new AppError(ErrorCode.InvalidSelection, `legacyImport.errors.${key}`)
const identity = (stat: BigIntStats) => ({
  device: String(stat.dev),
  inode: String(stat.ino),
  size: String(stat.size),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs),
})
const sameIdentity = (
  left: ReturnType<typeof identity>,
  right: ReturnType<typeof identity>
) =>
  Object.keys(left).every(
    (key) => left[key as keyof typeof left] === right[key as keyof typeof right]
  )

/** In-place HTTP authorization binds every retained byte before native import. */
export class LegacyHttpActivationService {
  private admission: Promise<unknown> | null = null
  private stopping = false
  private currentTaskId: string | null = null
  private controller: AbortController | null = null
  private cancelPicker: (() => void) | null = null
  private readonly verifier: Pick<
    DirectResourceValidatorService,
    'verifyLegacyContent'
  >
  constructor(private readonly deps: LegacyHttpActivationDeps) {
    this.verifier =
      deps.verifier ?? new DirectResourceValidatorService(undefined, 30_000)
  }

  async availability(taskId: string) {
    const pair = this.deps.db.getTask(taskId)
    const marker = legacyTaskMetadataSchema.safeParse(
      pair?.instances[0]?.payload.legacyImport
    )
    let reason: string | null = null
    if (
      !pair ||
      !marker.success ||
      pair.task.taskType !== TaskType.Http ||
      pair.instances.length !== 1
    )
      reason = 'activationSourceMissing'
    else if (pair.instances[0].uris.length !== 1) reason = 'mirrorsUnsupported'
    else if (!marker.data.origin) reason = 'activationSourceMissing'
    else if (
      !this.deps.adapter.verifyLegacyHttpBinding ||
      !(await this.deps.adapter.supportsLegacyCheckpointImport?.())
    )
      reason = 'checkpointUnavailable'
    else if (!(await this.deps.adapter.supportsLegacyHttpActivation?.()))
      reason = 'httpRequestUnsupported'
    return {
      available: reason === null,
      reason: reason ? `legacyImport.errors.${reason}` : null,
      directory: pair?.task.saveDir ?? '',
    }
  }

  activate(
    taskId: string,
    chooseDirectory: (directory: string) => Promise<string | null>
  ): Promise<boolean> {
    if (this.stopping || this.admission) return Promise.reject(failure('busy'))
    this.currentTaskId = taskId
    const controller = new AbortController()
    this.controller = controller
    const operation = this.deps.runTaskMutation([taskId], async () => {
      const pair = this.requireTask(taskId)
      const previous = pair.instances[0].payload.legacyHttpActivation
      if (previous !== undefined) {
        await this.withCurrentProxy((assertCurrent) =>
          this.reconcile(
            pair,
            true,
            controller.signal,
            undefined,
            assertCurrent
          )
        )
        return true
      }
      const available = await this.availability(taskId)
      if (!available.available)
        throw new AppError(
          ErrorCode.EngineFeatureUnavailable,
          available.reason ?? 'legacyImport.errors.failed'
        )
      if (this.stopping || controller.signal.aborted) return false
      const picked = await Promise.race([
        chooseDirectory(available.directory),
        new Promise<null>((resolve) => {
          this.cancelPicker = () => resolve(null)
        }),
      ])
      this.cancelPicker = null
      if (!picked || this.stopping || controller.signal.aborted) return false
      if (JSON.stringify(this.requireTask(taskId)) !== JSON.stringify(pair))
        throw failure('changedSource')
      await this.withCurrentProxy(async (assertCurrent) => {
        const prepared = await this.prepare(pair, picked, controller.signal)
        this.checkCancelled(controller.signal)
        assertCurrent()
        this.deps.taskManager.reserveEngineTaskId(prepared.intent.engineTaskId)
        await this.persist(pair, prepared.intent, false)
        await this.reconcile(
          this.requireTask(taskId),
          true,
          controller.signal,
          prepared.context,
          assertCurrent
        )
      })
      return true
    })
    this.admission = operation
    void operation
      .finally(() => {
        this.admission = null
        this.cancelPicker = null
        this.currentTaskId = null
        this.controller = null
      })
      .catch(() => {})
    return operation
  }

  private withCurrentProxy<T>(
    operation: (assertCurrent: () => void) => Promise<T>
  ): Promise<T> {
    return this.deps.proxyPolicy.runWithSnapshot((snapshot, lease) => {
      if (!snapshot) throw failure('httpRequestUnsupported')
      return operation(() => lease.assertCurrent())
    })
  }

  cancel(taskId: string): void {
    if (this.currentTaskId !== taskId) return
    this.controller?.abort()
    this.cancelPicker?.()
  }

  /** Passive startup recovery never imports, adds, verifies remotely, or unpauses. */
  async recover(): Promise<void> {
    for (const pair of this.deps.db.getAllTasks()) {
      if (
        !Object.hasOwn(
          pair.instances[0]?.payload ?? {},
          'legacyHttpActivation'
        ) ||
        pair.task.aggStatus === TaskStatus.Completed ||
        pair.task.taskType !== TaskType.Http ||
        pair.instances.length !== 1 ||
        !legacyTaskMetadataSchema.safeParse(
          pair.instances[0]?.payload.legacyImport
        ).success
      )
        continue
      try {
        await this.deps.runTaskMutation([pair.task.motrixId], () =>
          this.reconcile(pair, false)
        )
      } catch {
        const intent = legacyHttpActivationSchema.safeParse(
          pair.instances[0].payload.legacyHttpActivation
        )
        if (
          intent.success &&
          legacyTaskMetadataSchema.safeParse(
            pair.instances[0]?.payload.legacyImport
          ).success
        )
          await this.persist(pair, intent.data, false)
      }
    }
  }

  async drain(): Promise<void> {
    this.stopping = true
    this.controller?.abort()
    this.cancelPicker?.()
    await this.admission?.catch(() => {})
  }

  private async requireCapability(): Promise<void> {
    if (
      !this.deps.adapter.verifyLegacyHttpBinding ||
      !(await this.deps.adapter.supportsLegacyCheckpointImport?.())
    )
      throw failure('checkpointUnavailable')
    if (!(await this.deps.adapter.supportsLegacyHttpActivation?.()))
      throw failure('httpRequestUnsupported')
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (this.stopping || signal?.aborted)
      throw failure('httpVerificationCancelled')
  }

  private async checkCancelledAfterResume(
    engineTaskId: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (!signal?.aborted && !this.stopping) return
    let stopped = await this.deps.adapter.getTaskStatus(engineTaskId)
    const isStopped = () =>
      stopped?.engineTaskId === engineTaskId &&
      [TaskStatus.Paused, TaskStatus.Completed, TaskStatus.Error].includes(
        stopped.status
      )
    if (!isStopped() && stopped?.engineTaskId === engineTaskId) {
      // A lost pause response is safe only when a later status proves that
      // the intended task is paused or has already finished.
      await this.deps.adapter.pauseTask(engineTaskId).catch(() => {})
      stopped = await this.deps.adapter.getTaskStatus(engineTaskId)
    }
    if (!isStopped()) throw failure('activationUncertain')
    this.checkCancelled(signal)
  }

  private requireTask(taskId: string): TaskWithInstances {
    const pair = this.deps.db.getTask(taskId)
    if (
      pair?.instances.length !== 1 ||
      pair.task.taskType !== TaskType.Http ||
      !legacyTaskMetadataSchema.safeParse(
        pair.instances[0].payload.legacyImport
      ).success
    )
      throw failure('activationSourceMissing')
    if (pair.instances[0].uris.length !== 1) throw failure('mirrorsUnsupported')
    return pair
  }

  private async sourceContext(
    pair: TaskWithInstances
  ): Promise<LegacyHttpRequestContext> {
    const marker = legacyTaskMetadataSchema.parse(
      pair.instances[0].payload.legacyImport
    )
    const origin = marker.origin
    if (!origin) throw failure('activationSourceMissing')
    const source = await authorizeLegacySource(origin.root)
    if (source.identity !== origin.identity || source.root !== origin.root)
      throw failure('changedSource')
    const profiles = new Map<string, Uint8Array>()
    for (const file of origin.profileFiles) {
      if (
        !['download.session', 'system.json', 'user.json'].includes(
          file.relativePath
        ) ||
        profiles.has(file.relativePath)
      )
        throw failure('changedSource')
      const read = await readLegacyFile(source, file.relativePath, true)
      if (!read || read.digest !== file.digest) throw failure('changedSource')
      profiles.set(file.relativePath, read.bytes)
    }
    const session = profiles.get('download.session')
    const system = profiles.get('system.json')
    if (
      profiles.size !== 3 ||
      !session ||
      !system ||
      sha256(session) !== origin.sessionDigest
    )
      throw failure('changedSource')
    const pidFile = await readLegacyFile(source, 'engine.pid', true)
    if (pidFile) {
      const pid = Number(pidFile.bytes.toString('utf8').trim())
      if (
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        (await this.deps.isProcessRunning(pid))
      )
        throw failure('running')
    }
    const context = resolveLegacyHttpRequestContext({
      session,
      system,
      itemKey: marker.itemKey,
      uris: pair.instances[0].uris,
      targetPath: pair.task.finalPath,
    })
    const route = this.deps.proxyPolicy.snapshot()
    if (!route) throw failure('httpRequestUnsupported')
    return { ...context, proxy: route.proxy ?? '', noProxy: route.noProxy }
  }

  private async prepare(
    pair: TaskWithInstances,
    picked: string,
    signal: AbortSignal
  ) {
    const saveDir = await realpath(picked)
    if (
      saveDir !== pair.task.saveDir ||
      path.join(saveDir, pair.task.finalName) !== pair.task.finalPath
    )
      throw failure('originalDirectoryRequired')
    const context = await this.sourceContext(pair)
    const root = await this.safeStat(saveDir, true)
    await this.noConflicts(pair)
    const control = await this.originalControl(pair)
    const inspected = await this.deps.adapter.inspectLegacyCheckpoint?.(
      new Uint8Array(control.bytes)
    )
    const parsed = legacyCheckpointInspectionSchema.safeParse(inspected)
    if (!parsed.success) throw failure('checkpointUnavailable')
    const inspection = parsed.data
    if (
      inspection.type !== 'http' ||
      inspection.infoHash !== null ||
      inspection.sourceDigest !== control.digest ||
      inspection.totalBytes <= 0
    )
      throw failure('changedSource')
    const fileIdentity = await this.verifyPayload(
      pair.task.finalPath,
      inspection.totalBytes,
      inspection.ranges,
      context,
      signal
    )
    const validated = fileIdentity.validator
    await this.checkOriginal(
      pair,
      `${root.dev}:${root.ino}`,
      control.digest,
      control.identity,
      fileIdentity.identity
    )
    await this.sourceContext(pair)
    this.checkCancelled(signal)
    const controlBackupPath = await this.saveControl(control.bytes)
    return {
      context,
      intent: legacyHttpActivationSchema.parse({
        version: 1,
        stage: 'import-uncertain',
        token: `http_${randomUUID().replaceAll('-', '_')}`,
        engineTaskId: newEngineTaskId(undefined, 'legacy HTTP activation'),
        targetPath: pair.task.finalPath,
        saveDir,
        rootIdentity: `${root.dev}:${root.ino}`,
        controlBackupPath,
        controlDigest: control.digest,
        controlIdentity: control.identity,
        uriDigest: sha256(context.uri),
        expected: {
          type: 'http',
          totalBytes: inspection.totalBytes,
          pieceBytes: inspection.pieceBytes,
          infoHash: null,
        },
        files: [
          {
            path: pair.task.finalPath,
            offset: 0,
            length: inspection.totalBytes,
            identity: fileIdentity.identity,
          },
        ],
        completedBytes: inspection.completedBytes,
        retainedContentDigest: fileIdentity.retainedContentDigest,
        resourceValidator: validated,
      }),
    }
  }

  private async verifyPayload(
    target: string,
    totalBytes: number,
    ranges: readonly { offset: number; length: number }[],
    context: LegacyHttpRequestContext,
    signal?: AbortSignal
  ) {
    this.checkCancelled(signal)
    await this.requireCapability()
    const before = await this.safeStat(target, false).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw failure('payloadMissing')
      throw error
    })
    if (
      before.size > BigInt(totalBytes) ||
      ranges.some((range) => BigInt(range.offset + range.length) > before.size)
    )
      throw failure('changedSource')
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    )
    try {
      const opened = await handle.stat({ bigint: true })
      if (
        !sameIdentity(identity(before), identity(opened)) ||
        !opened.isFile() ||
        opened.nlink !== 1n
      )
        throw failure('changedSource')
      const retainedContentHash = createHash('sha256')
      let rangeIndex = 0
      let rangeOffset = ranges[0]?.offset ?? 0
      const result = await this.verifier.verifyLegacyContent({
        uri: context.uri,
        totalBytes,
        ranges,
        options: context,
        signal,
        read: async (offset, length) => {
          this.checkCancelled(signal)
          const range = ranges[rangeIndex]
          // Hash exactly the ordered bytes compared by remote verification.
          if (
            !range ||
            offset !== rangeOffset ||
            length <= 0 ||
            length > range.offset + range.length - offset
          )
            throw failure('changedSource')
          const bytes = Buffer.alloc(length)
          let cursor = 0
          while (cursor < length) {
            const { bytesRead } = await handle.read(
              bytes,
              cursor,
              length - cursor,
              offset + cursor
            )
            if (!bytesRead) throw failure('changedSource')
            cursor += bytesRead
          }
          retainedContentHash.update(bytes)
          rangeOffset += length
          if (rangeOffset === range.offset + range.length) {
            rangeIndex++
            rangeOffset = ranges[rangeIndex]?.offset ?? 0
          }
          return bytes
        },
      })
      this.checkCancelled(signal)
      if (
        rangeIndex !== ranges.length ||
        !sameIdentity(
          identity(opened),
          identity(await handle.stat({ bigint: true }))
        ) ||
        !sameIdentity(
          identity(opened),
          identity(await this.safeStat(target, false))
        )
      )
        throw failure('changedSource')
      return {
        identity: identity(opened),
        retainedContentDigest: retainedContentHash.digest('hex'),
        validator: result.validator,
      }
    } catch (error) {
      this.checkCancelled(signal)
      throw error
    } finally {
      await handle.close()
    }
  }

  private async retainedContentDigest(
    intent: LegacyHttpActivation,
    signal?: AbortSignal
  ): Promise<string> {
    const control = await this.backupFile(intent.controlBackupPath)
    if (control.digest !== intent.controlDigest) throw failure('changedSource')
    const inspection = legacyCheckpointInspectionSchema.parse(
      await this.deps.adapter.inspectLegacyCheckpoint?.(
        new Uint8Array(control.bytes)
      )
    )
    if (
      inspection.sourceDigest !== intent.controlDigest ||
      inspection.type !== 'http' ||
      inspection.totalBytes !== intent.expected.totalBytes ||
      inspection.pieceBytes !== intent.expected.pieceBytes ||
      inspection.completedBytes !== intent.completedBytes
    )
      throw failure('changedSource')
    const root = await this.safeStat(intent.saveDir, true)
    const before = await this.safeStat(intent.targetPath, false)
    if (
      `${root.dev}:${root.ino}` !== intent.rootIdentity ||
      String(before.dev) !== intent.files[0].identity.device ||
      String(before.ino) !== intent.files[0].identity.inode ||
      before.size > BigInt(intent.expected.totalBytes) ||
      inspection.ranges.some(
        (range) => BigInt(range.offset + range.length) > before.size
      )
    )
      throw failure('changedSource')
    const handle = await open(
      intent.targetPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    )
    try {
      if (
        !sameIdentity(
          identity(before),
          identity(await handle.stat({ bigint: true }))
        )
      )
        throw failure('changedSource')
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(1024 * 1024)
      for (const range of inspection.ranges) {
        let offset = range.offset
        const end = range.offset + range.length
        while (offset < end) {
          this.checkCancelled(signal)
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, end - offset),
            offset
          )
          if (!bytesRead) throw failure('changedSource')
          hash.update(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
      }
      if (
        !sameIdentity(
          identity(before),
          identity(await handle.stat({ bigint: true }))
        ) ||
        !sameIdentity(
          identity(before),
          identity(await this.safeStat(intent.targetPath, false))
        )
      )
        throw failure('changedSource')
      this.checkCancelled(signal)
      return hash.digest('hex')
    } finally {
      await handle.close()
    }
  }

  private async originalControl(pair: TaskWithInstances) {
    const control = await readLegacyFile(
      await authorizeLegacySource(pair.task.saveDir ?? ''),
      `${pair.task.finalName}.aria2`,
      true
    )
    if (!control) throw failure('controlRequired')
    if (!control.identity) throw failure('changedSource')
    return { ...control, identity: control.identity }
  }

  private async checkOriginal(
    pair: TaskWithInstances,
    rootIdentity: string,
    controlDigest: string,
    controlIdentity: string,
    fileIdentity: ReturnType<typeof identity>
  ) {
    const root = await this.safeStat(pair.task.saveDir ?? '', true)
    const control = await this.originalControl(pair)
    if (
      `${root.dev}:${root.ino}` !== rootIdentity ||
      control.digest !== controlDigest ||
      control.identity !== controlIdentity ||
      !sameIdentity(
        identity(await this.safeStat(pair.task.finalPath, false)),
        fileIdentity
      )
    )
      throw failure('changedSource')
  }

  private async safeStat(filename: string, directory: boolean) {
    if (
      !path.isAbsolute(filename) ||
      path.resolve(filename) !== filename ||
      (await realpath(filename)) !== filename
    )
      throw failure('unsafePath')
    let current = path.parse(filename).root
    for (const part of filename.slice(current.length).split(path.sep)) {
      current = path.join(current, part)
      const stat = await lstat(current)
      if (
        stat.isSymbolicLink() ||
        (current !== filename && !stat.isDirectory())
      )
        throw failure('unsafePath')
    }
    const stat = await lstat(filename, { bigint: true })
    if (
      directory
        ? !stat.isDirectory()
        : !stat.isFile() ||
          stat.nlink !== 1n ||
          (process.platform !== 'win32' && (stat.mode & 0o022n) !== 0n) ||
          (process.getuid && BigInt(process.getuid()) !== stat.uid)
    )
      throw failure('payloadUnsafe')
    return stat
  }

  private async noConflicts(pair: TaskWithInstances): Promise<void> {
    const target = outputPathIdentity(pair.task.finalPath)
    const overlaps = (filename: string) => {
      const other = outputPathIdentity(filename)
      return (
        target === other ||
        target.startsWith(`${other}${path.sep}`) ||
        other.startsWith(`${target}${path.sep}`)
      )
    }
    for (const other of this.deps.db.getAllTasks()) {
      if (isUnresolvedLegacyMagnet(other)) continue
      if (
        other.task.motrixId !== pair.task.motrixId &&
        [
          other.task.finalPath,
          ...other.instances.map((instance) => instance.diskPath),
        ]
          .filter(Boolean)
          .some(overlaps)
      )
        throw failure('pathConflict')
    }
    const owned = legacyHttpActivationSchema.safeParse(
      pair.instances[0].payload.legacyHttpActivation
    )
    const rows = [
      ...(await this.deps.adapter.listActiveAndWaiting()),
      ...(await this.deps.adapter.listStopped()),
    ]
    for (const row of rows) {
      if (owned.success && row.gid === owned.data.engineTaskId) continue
      const task = await this.deps.adapter.getTaskStatus(row.gid)
      if (task?.diskPath && overlaps(task.diskPath))
        throw failure('pathConflict')
      const files = await this.deps.adapter.getTaskFiles(row.gid)
      if (files.some((file) => file.path && overlaps(file.path)))
        throw failure('pathConflict')
    }
  }

  private async saveControl(bytes: Uint8Array): Promise<string> {
    const source = await authorizeLegacySource(this.deps.backupRoot)
    if (source.root !== path.resolve(this.deps.backupRoot))
      throw failure('unsafeBackup')
    const directory = path.join(source.root, `activation-${randomUUID()}`)
    await mkdir(directory, { mode: 0o700 })
    const filename = path.join(directory, 'control.snapshot')
    const file = await open(
      filename,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    if (process.platform !== 'win32') {
      for (const name of [directory, source.root]) {
        const handle = await open(
          name,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        )
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    }
    return filename
  }

  private async backupFile(filename: string) {
    const source = await authorizeLegacySource(this.deps.backupRoot)
    const relative = path.relative(source.root, filename)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw failure('unsafeBackup')
    const file = await readLegacyFile(source, relative)
    if (!file) throw failure('activationSourceMissing')
    return file
  }

  private async persist(
    pair: TaskWithInstances,
    intent: LegacyHttpActivation,
    bound: boolean
  ): Promise<TaskWithInstances> {
    const next = structuredClone(pair)
    const instance = next.instances[0]
    const marker = legacyTaskMetadataSchema.parse(instance.payload.legacyImport)
    instance.payload = {
      ...instance.payload,
      legacyHttpActivation: structuredClone(intent),
      legacyImport: {
        ...marker,
        activation: bound ? 'active' : 'activating',
        storagePolicy: 'legacy-http-in-place',
      },
    }
    if (bound) {
      instance.gid = intent.engineTaskId
      instance.diskPath = intent.targetPath
      next.task.saveDir = intent.saveDir
      next.task.totalBytes = instance.totalBytes = intent.expected.totalBytes
      next.task.downloadedBytes = instance.downloadedBytes = Math.max(
        instance.downloadedBytes,
        intent.completedBytes
      )
      next.task.sizeWhenDone = intent.expected.totalBytes
      next.task.pieceLength = intent.expected.pieceBytes
      instance.progress = (instance.downloadedBytes / instance.totalBytes) * 100
    }
    next.task.updatedAt = instance.updatedAt = Date.now()
    await this.deps.runExclusivePersistence(() =>
      this.deps.db.saveTaskWithInstances(next)
    )
    this.deps.taskManager.set(
      next.task.motrixId,
      taskRowToDownloadTask(next.task, next.instances)
    )
    this.deps.publishTasks()
    return next
  }

  private async reconcile(
    pair: TaskWithInstances,
    resume: boolean,
    signal?: AbortSignal,
    verifiedContext?: LegacyHttpRequestContext,
    assertProxyCurrent?: () => void
  ): Promise<void> {
    const intent = legacyHttpActivationSchema.parse(
      pair.instances[0].payload.legacyHttpActivation
    )
    await this.requireCapability()
    if (
      pair.task.finalPath !== intent.targetPath ||
      pair.task.saveDir !== intent.saveDir ||
      pair.instances[0].uris.length !== 1 ||
      sha256(pair.instances[0].uris[0]) !== intent.uriDigest
    )
      throw failure('changedSource')
    const receipt = await this.deps.adapter.reconcileLegacyCheckpoint?.({
      token: intent.token,
      targetPath: intent.targetPath,
    })
    if (!receipt) throw failure('checkpointUnavailable')
    if (
      receipt.status !== 'absent' &&
      (receipt.engineTaskId !== intent.engineTaskId ||
        receipt.sourceDigest !== intent.controlDigest)
    )
      throw failure('changedSource')
    let engine = await this.deps.adapter.getTaskStatus(intent.engineTaskId)
    if (engine) {
      if (
        !['create-uncertain', 'bound', 'resume-uncertain', 'active'].includes(
          intent.stage
        ) ||
        receipt.status === 'absent' ||
        engine.engineTaskId !== intent.engineTaskId
      )
        throw failure('activationUncertain')
      const binding = {
        engineTaskId: intent.engineTaskId,
        saveDir: intent.saveDir,
        targetPath: intent.targetPath,
        uri: pair.instances[0].uris[0],
        expected: intent.expected,
        entityTag: intent.resourceValidator.value,
        fileIdentity: {
          device: intent.files[0].identity.device,
          inode: intent.files[0].identity.inode,
        },
      }
      // Prove ownership and stop an uncertain writer before reading the old
      // profile: missing credentials must not leave that owner downloading.
      if (!(await this.deps.adapter.verifyLegacyHttpBinding?.(binding)))
        throw failure('activationUncertain')
      if (
        (!resume || intent.stage !== 'active' || signal?.aborted) &&
        ![TaskStatus.Paused, TaskStatus.Completed, TaskStatus.Error].includes(
          engine.status
        )
      ) {
        await this.deps.adapter.pauseTask(intent.engineTaskId)
        engine = await this.deps.adapter.getTaskStatus(intent.engineTaskId)
      }
      if (!engine || engine.engineTaskId !== intent.engineTaskId)
        throw failure('activationUncertain')
      if (resume) this.checkCancelled(signal)
      if (
        intent.stage !== 'active' &&
        ![TaskStatus.Paused, TaskStatus.Completed, TaskStatus.Error].includes(
          engine.status
        )
      )
        throw failure('activationUncertain')
      if (intent.stage !== 'active') {
        const request = verifiedContext ?? (await this.sourceContext(pair))
        if (
          !(await this.deps.adapter.verifyLegacyHttpBinding?.({
            ...binding,
            request,
          }))
        )
          throw failure('activationUncertain')
      }
      if (intent.stage === 'resume-uncertain') {
        // The first unpause may have written new bytes before its response or
        // final app save was lost. Only the exact paused native owner may keep
        // that progress, and every previously verified byte must still match.
        if (
          (await this.retainedContentDigest(intent, signal)) !==
          intent.retainedContentDigest
        )
          throw failure('changedSource')
        intent.stage = 'active'
      }
      if (
        intent.stage !== 'active' &&
        !sameIdentity(
          identity(await this.safeStat(intent.targetPath, false)),
          intent.files[0].identity
        )
      )
        throw failure('changedSource')
      await this.noConflicts(pair)
      // Keep evidence that this task has already started: its payload may
      // legitimately have grown since the original verified checkpoint.
      if (intent.stage !== 'active') intent.stage = 'bound'
      pair = await this.persist(pair, intent, true)
      if (resume && engine.status === TaskStatus.Paused) {
        if (intent.stage !== 'active') {
          intent.retainedContentDigest ??= await this.retainedContentDigest(
            intent,
            signal
          )
          intent.stage = 'resume-uncertain'
          pair = await this.persist(pair, intent, true)
        }
        this.checkCancelled(signal)
        try {
          assertProxyCurrent?.()
          await this.deps.adapter.resumeTask(intent.engineTaskId)
          this.checkCancelled(signal)
          intent.stage = 'active'
          await this.persist(pair, intent, true)
        } catch (error) {
          await this.checkCancelledAfterResume(intent.engineTaskId, signal)
          throw error
        }
        // The RPC and the final save are both cancellation points.
        await this.checkCancelledAfterResume(intent.engineTaskId, signal)
      }
      return
    }
    if (
      receipt.status === 'consumed' ||
      ['create-uncertain', 'bound', 'resume-uncertain', 'active'].includes(
        intent.stage
      )
    )
      throw failure('activationUncertain')
    // Import and add are user-triggered mutations, never startup recovery work.
    if (!resume) {
      await this.persist(pair, intent, false)
      return
    }
    this.checkCancelled(signal)
    let context = verifiedContext ?? (await this.sourceContext(pair))
    await this.noConflicts(pair)
    await this.checkOriginal(
      pair,
      intent.rootIdentity,
      intent.controlDigest,
      intent.controlIdentity,
      intent.files[0].identity
    )
    const control = await this.backupFile(intent.controlBackupPath)
    if (control.digest !== intent.controlDigest) throw failure('changedSource')
    if (!verifiedContext) {
      const inspection = legacyCheckpointInspectionSchema.parse(
        await this.deps.adapter.inspectLegacyCheckpoint?.(
          new Uint8Array(control.bytes)
        )
      )
      if (
        inspection.sourceDigest !== intent.controlDigest ||
        inspection.type !== 'http' ||
        inspection.totalBytes !== intent.expected.totalBytes ||
        inspection.pieceBytes !== intent.expected.pieceBytes ||
        inspection.completedBytes !== intent.completedBytes
      )
        throw failure('changedSource')
      const verified = await this.verifyPayload(
        intent.targetPath,
        intent.expected.totalBytes,
        inspection.ranges,
        context,
        signal
      )
      if (!sameIdentity(verified.identity, intent.files[0].identity))
        throw failure('changedSource')
      intent.resourceValidator = verified.validator
      intent.retainedContentDigest = verified.retainedContentDigest
      pair = await this.persist(pair, intent, false)
    }
    context = await this.sourceContext(pair)
    await this.checkOriginal(
      pair,
      intent.rootIdentity,
      intent.controlDigest,
      intent.controlIdentity,
      intent.files[0].identity
    )
    this.checkCancelled(signal)
    await this.requireCapability()
    if (receipt.status === 'absent') {
      if (intent.stage !== 'import-uncertain')
        throw failure('activationUncertain')
      assertProxyCurrent?.()
      const imported = await this.deps.adapter.importLegacyCheckpoint?.({
        token: intent.token,
        engineTaskId: intent.engineTaskId,
        targetPath: intent.targetPath,
        controlFile: new Uint8Array(control.bytes),
        sourceDigest: intent.controlDigest,
        expected: intent.expected,
        files: intent.files,
      })
      if (imported?.status !== 'created') throw failure('activationUncertain')
    }
    intent.stage = 'checkpoint'
    pair = await this.persist(pair, intent, false)
    this.checkCancelled(signal)
    context = await this.sourceContext(pair)
    await this.checkOriginal(
      pair,
      intent.rootIdentity,
      intent.controlDigest,
      intent.controlIdentity,
      intent.files[0].identity
    )
    // The durable unknown-create state forbids blind retries after lost responses.
    intent.stage = 'create-uncertain'
    pair = await this.persist(pair, intent, false)
    if (this.stopping || signal?.aborted) {
      // No create was dispatched, so a later explicit retry may safely reverify.
      intent.stage = 'checkpoint'
      await this.persist(pair, intent, false)
      this.checkCancelled(signal)
    }
    if (
      !this.deps.taskManager.isEngineTaskIdRetired(intent.engineTaskId) &&
      !this.deps.taskManager.getByEngineTaskId(intent.engineTaskId)
    )
      this.deps.taskManager.reserveEngineTaskId(intent.engineTaskId)
    assertProxyCurrent?.()
    const gid = await this.deps.adapter.createDownload({
      uris: [context.uri],
      saveDir: intent.saveDir,
      filename: pair.task.finalName,
      gid: intent.engineTaskId,
      headers: {
        ...context.headers,
        'If-Match': intent.resourceValidator.value,
        'Accept-Encoding': 'identity',
      },
      userAgent: context.userAgent,
      proxy: context.proxy,
      noProxy: context.noProxy,
      pause: true,
      resumePolicy: 'checkpoint',
      fileAllocation: 'none',
      totalSizeBytes: intent.expected.totalBytes,
      extraEngineOptions: {
        'piece-length': String(intent.expected.pieceBytes),
      },
      legacyCheckpointActivation: {
        token: intent.token,
        targetPath: intent.targetPath,
      },
    })
    if (gid !== intent.engineTaskId) throw failure('activationUncertain')
    await this.reconcile(
      pair,
      resume && !signal?.aborted && !this.stopping,
      signal,
      undefined,
      assertProxyCurrent
    )
    this.checkCancelled(signal)
  }
}
