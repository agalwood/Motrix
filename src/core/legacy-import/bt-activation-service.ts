import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { newEngineTaskId } from '@core/lib/ids'
import type {
  MotrixDatabase,
  TaskWithInstances,
} from '@core/session/motrix-database'
import { parseBtFileLayout } from '@core/task/bt-storage-layout'
import { outputPathIdentity } from '@core/task/output-path-identity'
import type { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type LegacyBtActivation,
  legacyBtActivationSchema,
} from '@shared/schemas/legacy-bt-activation'
import type { LegacyCheckpointFile } from '@shared/schemas/legacy-checkpoint'
import { legacyTaskMetadataSchema } from '@shared/schemas/legacy-import'
import { TaskStatus, TaskType } from '@shared/types/task'
import parseTorrent from 'parse-torrent'
import { authorizeLegacySource, readLegacyFile } from './source-scanner'

export interface LegacyBtActivationDeps {
  db: MotrixDatabase
  taskManager: TaskManager
  adapter: EngineAdapter
  backupRoot: string
  isProcessRunning: (pid: number) => boolean | Promise<boolean>
  publishTasks: () => void
  runTaskMutation: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  runExclusivePersistence: <T>(operation: () => T | Promise<T>) => Promise<T>
}
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const failure = (key: string) =>
  new AppError(ErrorCode.InvalidSelection, `legacyImport.errors.${key}`)

/** Explicit in-place BT authorization. Unknown mutations retain their durable identity. */
export class LegacyBtActivationService {
  private admission: Promise<unknown> | null = null
  private stopping = false
  private cancelPicker: (() => void) | null = null
  constructor(private readonly deps: LegacyBtActivationDeps) {}

  async availability(taskId: string) {
    const pair = this.deps.db.getTask(taskId)
    const marker = legacyTaskMetadataSchema.safeParse(
      pair?.instances[0]?.payload.legacyImport
    )
    let reason: string | null = null
    if (
      !pair ||
      !marker.success ||
      pair.task.taskType !== TaskType.Bt ||
      !pair.task.torrentMetaPath
    )
      reason = 'metadataRequired'
    else if (!marker.data.selectionKnown || !marker.data.selectedFiles.length)
      reason = 'selectionRequired'
    else if (!marker.data.origin?.torrentDigest)
      reason = 'activationSourceMissing'
    else if (!(await this.deps.adapter.supportsLegacyBtActivation?.()))
      reason = 'checkpointUnavailable'
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
    const operation = this.deps.runTaskMutation([taskId], async () => {
      const pair = this.requireTask(taskId)
      const previous = pair.instances[0].payload.legacyBtActivation
      if (previous !== undefined) {
        await this.reconcile(pair, true)
        return true
      }
      const available = await this.availability(taskId)
      if (!available.available)
        throw new AppError(
          ErrorCode.EngineFeatureUnavailable,
          available.reason ?? 'legacyImport.errors.failed'
        )
      if (this.stopping) return false
      const picked = await Promise.race([
        chooseDirectory(available.directory),
        new Promise<null>((resolve) => {
          this.cancelPicker = () => resolve(null)
        }),
      ])
      this.cancelPicker = null
      if (!picked || this.stopping) return false
      // Resolve the current row after the picker; no stale task grants survive removal/change.
      if (JSON.stringify(this.requireTask(taskId)) !== JSON.stringify(pair))
        throw failure('changedSource')
      const intent = await this.prepare(pair, picked)
      this.deps.taskManager.reserveEngineTaskId(intent.engineTaskId)
      await this.persist(pair, intent, false)
      await this.reconcile(this.requireTask(taskId), true)
      return true
    })
    this.admission = operation
    void operation
      .finally(() => {
        this.admission = null
        this.cancelPicker = null
      })
      .catch(() => {})
    return operation
  }

  /** Runs before ordinary restore. Recovery may bind an exact paused GID, but never unpauses. */
  async recover(): Promise<void> {
    for (const pair of this.deps.db.getAllTasks()) {
      if (
        !Object.hasOwn(pair.instances[0]?.payload ?? {}, 'legacyBtActivation')
      )
        continue
      if (pair.task.aggStatus === TaskStatus.Completed) continue
      try {
        await this.deps.runTaskMutation([pair.task.motrixId], () =>
          this.reconcile(pair, false)
        )
      } catch {
        // A failed proof must remove ordinary resume/adoption authorization.
        const intent = legacyBtActivationSchema.safeParse(
          pair.instances[0].payload.legacyBtActivation
        )
        if (intent.success) await this.persist(pair, intent.data, false)
      }
    }
  }

  async drain(): Promise<void> {
    this.stopping = true
    this.cancelPicker?.()
    await this.admission?.catch(() => {})
  }

  private requireTask(taskId: string): TaskWithInstances {
    const pair = this.deps.db.getTask(taskId)
    const marker = legacyTaskMetadataSchema.safeParse(
      pair?.instances[0]?.payload.legacyImport
    )
    if (
      !pair ||
      !marker.success ||
      pair.instances.length !== 1 ||
      pair.task.taskType !== TaskType.Bt ||
      !pair.task.torrentMetaPath
    )
      throw failure('activationSourceMissing')
    return pair
  }

  private async metadata(pair: TaskWithInstances): Promise<Buffer> {
    const marker = legacyTaskMetadataSchema.parse(
      pair.instances[0].payload.legacyImport
    )
    const file = await this.backupFile(pair.task.torrentMetaPath ?? '')
    if (file.digest !== marker.origin?.torrentDigest)
      throw failure('changedSource')
    return file.bytes
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

  private async sourceStillClosed(pair: TaskWithInstances): Promise<void> {
    const marker = legacyTaskMetadataSchema.parse(
      pair.instances[0].payload.legacyImport
    )
    const origin = marker.origin
    if (!origin) throw failure('activationSourceMissing')
    const source = await authorizeLegacySource(origin.root)
    if (source.identity !== origin.identity || source.root !== origin.root)
      throw failure('changedSource')
    for (const file of origin.profileFiles) {
      if (
        !['download.session', 'system.json', 'user.json'].includes(
          file.relativePath
        )
      )
        throw failure('changedSource')
      if (
        (await readLegacyFile(source, file.relativePath))?.digest !==
        file.digest
      )
        throw failure('changedSource')
    }
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
  }

  private async prepare(
    pair: TaskWithInstances,
    picked: string
  ): Promise<LegacyBtActivation> {
    await this.sourceStillClosed(pair)
    const marker = legacyTaskMetadataSchema.parse(
      pair.instances[0].payload.legacyImport
    )
    const metadata = await this.metadata(pair)
    const layout = await parseBtFileLayout(metadata)
    const torrent = await parseTorrent(metadata)
    if (
      layout.infoHash !== pair.task.infoHash ||
      layout.torrentRootName !== pair.task.finalName ||
      layout.isPrivate !== pair.task.isPrivate
    )
      throw failure('changedSource')
    if (
      !marker.selectionKnown ||
      !marker.selectedFiles.length ||
      new Set(marker.selectedFiles).size !== marker.selectedFiles.length ||
      marker.selectedFiles.some((index) => index >= layout.files.length)
    )
      throw failure('selectionRequired')
    const saveDir = await realpath(picked)
    // The picker authorizes precisely the original parent; relocation/remapping is unsupported.
    if (
      saveDir !== pair.task.saveDir ||
      path.join(saveDir, layout.torrentRootName) !== pair.task.finalPath
    )
      throw failure('originalDirectoryRequired')
    const root = await this.safeStat(saveDir, true)
    await this.noConflicts(pair)
    let offset = 0
    const inodes = new Set<string>()
    const files: LegacyCheckpointFile[] = []
    for (const [index, file] of (torrent.files ?? []).entries()) {
      const filename = path.join(saveDir, file.path)
      if (
        !filename.startsWith(`${saveDir}${path.sep}`) ||
        (layout.multiFile &&
          !filename.startsWith(`${pair.task.finalPath}${path.sep}`))
      )
        throw failure('unsafePath')
      const stat = await this.safeStat(filename, false).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw failure('payloadMissing')
        throw error
      })
      const identity = `${stat.dev}:${stat.ino}`
      if (inodes.has(identity)) throw failure('unsafePath')
      inodes.add(identity)
      if (
        !Number.isSafeInteger(file.length) ||
        file.length < 0 ||
        !layout.files[index]
      )
        throw failure('changedSource')
      files.push({
        path: filename,
        offset,
        length: file.length,
        identity: {
          device: String(stat.dev),
          inode: String(stat.ino),
          size: String(stat.size),
          mtimeNs: String(stat.mtimeNs),
          ctimeNs: String(stat.ctimeNs),
        },
      })
      offset += file.length
    }
    const control = await readLegacyFile(
      await authorizeLegacySource(saveDir),
      `${layout.torrentRootName}.aria2`,
      true
    )
    if (!control) throw failure('controlRequired')
    const inspection = await this.deps.adapter.inspectLegacyCheckpoint?.(
      new Uint8Array(control.bytes)
    )
    if (!inspection) throw failure('checkpointUnavailable')
    if (
      inspection.type !== 'bt' ||
      inspection.infoHash !== layout.infoHash ||
      inspection.totalBytes !== offset ||
      inspection.pieceBytes !== torrent.pieceLength
    )
      throw failure('changedSource')
    const controlBackupPath = await this.saveControl(control.bytes)
    await this.sourceStillClosed(pair)
    const controlAgain = await readLegacyFile(
      await authorizeLegacySource(saveDir),
      `${layout.torrentRootName}.aria2`
    )
    if (
      controlAgain?.digest !== control.digest ||
      controlAgain.identity !== control.identity
    )
      throw failure('changedSource')
    return legacyBtActivationSchema.parse({
      version: 1,
      stage: 'import-uncertain',
      token: `bt_${randomUUID().replaceAll('-', '_')}`,
      engineTaskId: newEngineTaskId(undefined, 'legacy BT activation'),
      targetPath: pair.task.finalPath,
      saveDir,
      rootIdentity: `${root.dev}:${root.ino}`,
      controlBackupPath,
      controlDigest: inspection.sourceDigest,
      torrentDigest: sha256(metadata),
      expected: {
        type: 'bt',
        totalBytes: inspection.totalBytes,
        pieceBytes: inspection.pieceBytes,
        infoHash: layout.infoHash,
      },
      files,
      selectedFiles: marker.selectedFiles,
      trackers: pair.task.trackers.flat(),
      isPrivate: layout.isPrivate,
    })
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
          (stat.mode & 0o022n) !== 0n ||
          (process.getuid && BigInt(process.getuid()) !== stat.uid)
    )
      throw failure('payloadUnsafe')
    return stat
  }

  private async noConflicts(pair: TaskWithInstances): Promise<void> {
    const target = outputPathIdentity(pair.task.finalPath)
    for (const other of this.deps.db.getAllTasks()) {
      if (other.task.motrixId === pair.task.motrixId) continue
      const claimed = [
        other.task.finalPath,
        ...other.instances.map((instance) => instance.diskPath),
      ].filter(Boolean)
      if (
        other.task.infoHash === pair.task.infoHash ||
        claimed.some((value) => {
          const identity = outputPathIdentity(value)
          return (
            target === identity ||
            target.startsWith(`${identity}${path.sep}`) ||
            identity.startsWith(`${target}${path.sep}`)
          )
        })
      )
        throw failure('pathConflict')
    }
    const owned = legacyBtActivationSchema.safeParse(
      pair.instances[0].payload.legacyBtActivation
    )
    const rows = [
      ...(await this.deps.adapter.listActiveAndWaiting()),
      ...(await this.deps.adapter.listStopped()),
    ]
    if (
      rows.some(
        (row) =>
          row.infoHash?.toLowerCase() === pair.task.infoHash &&
          row.gid !== (owned.success ? owned.data.engineTaskId : null)
      )
    )
      throw failure('pathConflict')
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
        constants.O_NOFOLLOW,
      0o600
    )
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    for (const name of [directory, source.root]) {
      const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    return filename
  }

  private async persist(
    pair: TaskWithInstances,
    intent: LegacyBtActivation,
    bound: boolean
  ): Promise<TaskWithInstances> {
    const next = structuredClone(pair)
    const marker = legacyTaskMetadataSchema.parse(
      next.instances[0].payload.legacyImport
    )
    next.instances[0].payload = {
      ...next.instances[0].payload,
      legacyBtActivation: intent,
      legacyImport: {
        ...marker,
        activation: bound ? 'active' : 'activating',
        storagePolicy: 'legacy-bt-in-place',
      },
    }
    if (bound) {
      next.instances[0].gid = intent.engineTaskId
      next.instances[0].diskPath = intent.targetPath
      next.task.saveDir = intent.saveDir
    }
    next.task.updatedAt = next.instances[0].updatedAt = Date.now()
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
    resume: boolean
  ): Promise<void> {
    const intent = legacyBtActivationSchema.parse(
      pair.instances[0].payload.legacyBtActivation
    )
    if (!(await this.deps.adapter.supportsLegacyBtActivation?.()))
      throw failure('checkpointUnavailable')
    if (
      pair.task.finalPath !== intent.targetPath ||
      pair.task.saveDir !== intent.saveDir ||
      pair.task.infoHash !== intent.expected.infoHash ||
      pair.task.isPrivate !== intent.isPrivate
    )
      throw failure('changedSource')
    const metadata = await this.metadata(pair)
    if (sha256(metadata) !== intent.torrentDigest)
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
      // Never trust consumed alone: the durable add phase and full live identity must agree.
      if (
        !['create-uncertain', 'bound', 'active'].includes(intent.stage) ||
        receipt.status === 'absent'
      )
        throw failure('activationUncertain')
      if (
        !engine ||
        engine.infoHash?.toLowerCase() !== intent.expected.infoHash ||
        engine.engineTaskId !== intent.engineTaskId
      )
        throw failure('activationUncertain')
      if (
        !(await this.deps.adapter.verifyLegacyBtBinding?.({
          engineTaskId: intent.engineTaskId,
          saveDir: intent.saveDir,
          infoHash: intent.expected.infoHash ?? '',
          files: intent.files,
          selectedFiles: intent.selectedFiles,
          trackers: intent.trackers,
          isPrivate: intent.isPrivate,
        }))
      )
        throw failure('activationUncertain')
      if (
        intent.stage === 'create-uncertain' &&
        engine.status !== TaskStatus.Paused
      ) {
        await this.deps.adapter.pauseTask(intent.engineTaskId)
        engine = await this.deps.adapter.getTaskStatus(intent.engineTaskId)
      }
      if (!engine) throw failure('activationUncertain')
      if (
        intent.stage !== 'active' ||
        (resume && engine.status === TaskStatus.Paused)
      ) {
        await this.sourceStillClosed(pair)
        await this.noConflicts(pair)
      }
      if (intent.stage !== 'active') {
        intent.stage = 'bound'
        pair = await this.persist(pair, intent, true)
      }
      if (resume && engine.status === TaskStatus.Paused && !this.stopping) {
        // Binding is durable before this side effect. Ordinary resume can now safely address only this GID.
        await this.deps.adapter.resumeTask(intent.engineTaskId)
        intent.stage = 'active'
        await this.persist(pair, intent, true)
      }
      return
    }
    if (
      receipt.status === 'consumed' ||
      ['create-uncertain', 'bound', 'active'].includes(intent.stage)
    )
      throw failure('activationUncertain')
    if (this.stopping) return
    await this.sourceStillClosed(pair)
    await this.noConflicts(pair)
    const root = await this.safeStat(intent.saveDir, true)
    if (`${root.dev}:${root.ino}` !== intent.rootIdentity)
      throw failure('changedSource')
    for (const file of intent.files) {
      const stat = await this.safeStat(file.path, false)
      const identity = file.identity
      if (
        String(stat.dev) !== identity.device ||
        String(stat.ino) !== identity.inode ||
        String(stat.size) !== identity.size ||
        String(stat.mtimeNs) !== identity.mtimeNs ||
        String(stat.ctimeNs) !== identity.ctimeNs
      )
        throw failure('changedSource')
    }
    if (receipt.status === 'absent') {
      if (intent.stage !== 'import-uncertain')
        throw failure('activationUncertain')
      const control = await this.backupFile(intent.controlBackupPath)
      if (control.digest !== intent.controlDigest)
        throw failure('changedSource')
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
    if (this.stopping) return
    await this.sourceStillClosed(pair)
    // Save before dispatch: an unknown response cannot lead to a blind second add.
    intent.stage = 'create-uncertain'
    pair = await this.persist(pair, intent, false)
    if (
      !this.deps.taskManager.isEngineTaskIdRetired(intent.engineTaskId) &&
      !this.deps.taskManager.getByEngineTaskId(intent.engineTaskId)
    )
      this.deps.taskManager.reserveEngineTaskId(intent.engineTaskId)
    const gid = await this.deps.adapter.addTorrent({
      metadata,
      saveDir: intent.saveDir,
      gid: intent.engineTaskId,
      selectedFiles: intent.selectedFiles.map((index) => index + 1),
      pause: true,
      checkIntegrity: true,
      btSeedUnverified: false,
      isPrivate: intent.isPrivate,
      legacyCheckpointActivation: {
        token: intent.token,
        targetPath: intent.targetPath,
      },
      durableMetadata: {
        path: pair.task.torrentMetaPath ?? '',
        digest: intent.torrentDigest,
      },
      extraEngineOptions: { 'bt-tracker': intent.trackers.join(',') },
    })
    if (gid !== intent.engineTaskId) throw failure('activationUncertain')
    await this.reconcile(pair, resume)
  }
}
