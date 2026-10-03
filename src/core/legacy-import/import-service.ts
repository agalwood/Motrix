import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  MotrixDatabase,
  TaskWithInstancesAndFiles,
} from '@core/session/motrix-database'
import { outputPathIdentity } from '@core/task/output-path-identity'
import type { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type LegacyImportPreview,
  type LegacyImportReport,
  type LegacyImportSource,
  legacyCommitRequestSchema,
  legacyImportReportSchema,
  legacyMetadataRequestSchema,
} from '@shared/schemas/legacy-import'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import {
  authorizeLegacySource,
  authorizeLegacyTorrent,
  isLegacyTorrentGrantValid,
  type LegacyCandidate,
  type LegacySnapshot,
  type LegacySource,
  type LegacyTorrentGrant,
  scanLegacySource,
} from './source-scanner'

export interface LegacyImportServiceDeps {
  db: MotrixDatabase
  taskManager: TaskManager
  backupRoot: string
  isProcessRunning: (pid: number) => boolean | Promise<boolean>
  publishTasks: () => void
  runExclusivePersistence?: <T>(operation: () => T | Promise<T>) => Promise<T>
  now?: () => number
}
interface PreviewState {
  dto: LegacyImportPreview
  snapshot: LegacySnapshot
  committedRunId?: string
}
const PREVIEW_TTL = 15 * 60 * 1000
const BATCH_SIZE = 100

export class LegacyImportService {
  private sources = new Map<string, LegacySource>()
  private previews = new Map<string, PreviewState>()
  private cancelled = new Set<string>()
  private activeRun: string | null = null
  private runningJobs = new Map<string, Promise<void>>()
  private admissions = new Set<Promise<LegacyImportReport>>()
  private metadataAdmissions = new Set<Promise<LegacyImportPreview | null>>()
  private metadataGrants = new Map<string, Map<string, LegacyTorrentGrant>>()
  private stopMetadataPicker: (() => void) | null = null
  private draining = false
  private clock: () => number

  constructor(private readonly deps: LegacyImportServiceDeps) {
    this.clock = deps.now ?? Date.now
    for (const row of deps.db.database
      .prepare(
        "SELECT run_id, report FROM legacy_import_runs WHERE json_extract(report, '$.stage') IN ('backing-up', 'committing')"
      )
      .all() as Array<{ run_id: string; report: string }>) {
      const report = legacyImportReportSchema.parse(JSON.parse(row.report))
      if (report.stage === 'committing' || report.stage === 'backing-up') {
        report.stage = 'failed'
        for (const item of report.items) {
          if (item.outcome === 'unprocessed') {
            item.outcome = 'failed'
            item.reason = 'stopped'
          }
        }
        this.saveReport(report)
      }
    }
  }

  setPersistenceLane(
    lane: LegacyImportServiceDeps['runExclusivePersistence']
  ): void {
    this.deps.runExclusivePersistence = lane
  }

  invitationDismissed(): boolean {
    return (
      (
        this.deps.db.database
          .prepare('SELECT dismissed FROM legacy_import_invitation WHERE id=1')
          .get() as { dismissed: number }
      ).dismissed === 1
    )
  }

  dismissInvitation(): void {
    this.deps.db.database
      .prepare('UPDATE legacy_import_invitation SET dismissed=1 WHERE id=1')
      .run()
  }

  async addSource(root: string): Promise<LegacyImportSource> {
    const source = await authorizeLegacySource(root)
    for (const [handle, existing] of this.sources) {
      if (
        existing.root === source.root &&
        existing.identity === source.identity
      )
        return { sourceHandle: handle, name: path.basename(source.root) }
    }
    if (this.sources.size >= 16) throw this.error('tooManySources')
    const sourceHandle = randomUUID()
    this.sources.set(sourceHandle, source)
    return { sourceHandle, name: path.basename(source.root) }
  }

  async discover(roots: readonly string[]): Promise<LegacyImportSource[]> {
    const result: LegacyImportSource[] = []
    for (const root of roots) {
      try {
        const source = await authorizeLegacySource(root)
        await scanLegacySource(source, this.deps.isProcessRunning)
        const dto = await this.addSource(root)
        if (!result.some((entry) => entry.sourceHandle === dto.sourceHandle))
          result.push(dto)
      } catch {
        /* Unrecognized or unavailable defaults do not trigger an invitation. */
      }
    }
    return result
  }

  async scan(
    sourceHandle: string,
    expectedDigest?: string
  ): Promise<LegacyImportPreview> {
    if (this.draining) throw this.error('busy')
    const source = this.sources.get(sourceHandle)
    if (!source) throw this.error('sourceNotAuthorized')
    let snapshot: LegacySnapshot
    try {
      snapshot = await this.scanSource(source)
    } catch (error) {
      const grants = this.metadataGrants.get(sourceHandle)
      if (
        expectedDigest ||
        !grants?.size ||
        !(error instanceof Error) ||
        !/changedSource/.test(error.message)
      )
        throw error
      const valid = new Map<string, LegacyTorrentGrant>()
      for (const [digest, grant] of grants)
        if (await isLegacyTorrentGrantValid(grant)) valid.set(digest, grant)
      if (valid.size === grants.size) throw error
      snapshot = await scanLegacySource(
        source,
        this.deps.isProcessRunning,
        valid
      )
      if (this.draining) throw this.error('busy')
      this.metadataGrants.set(sourceHandle, valid)
      for (const [id, state] of this.previews)
        if (state.dto.sourceHandle === sourceHandle) this.previews.delete(id)
    }
    if (this.draining) throw this.error('busy')
    if (expectedDigest && snapshot.digest !== expectedDigest)
      throw this.error('changedSource')
    const grants = this.metadataGrants.get(sourceHandle)
    if (grants) {
      const currentEntries = new Set(
        snapshot.candidates.map((candidate) => candidate.entry.digest)
      )
      for (const digest of grants.keys())
        if (!currentEntries.has(digest)) grants.delete(digest)
    }
    const claims = this.claimedPaths()
    const pendingPaths: string[] = []
    for (const candidate of snapshot.candidates) {
      const ledger = this.deps.db.database
        .prepare(
          'SELECT state, entry_digest FROM legacy_import_ledger WHERE source_id=? AND item_key=?'
        )
        .get(snapshot.sourceId, candidate.entry.itemKey) as
        | { state: string; entry_digest: string }
        | undefined
      if (ledger) {
        candidate.item.selectable = false
        candidate.item.reason =
          ledger.state === 'user-deleted'
            ? 'deleted-import'
            : ledger.entry_digest !== candidate.entry.digest
              ? 'changed-source'
              : 'already-imported'
      } else if (candidate.item.selectable && candidate.outputPath) {
        if (this.overlaps(candidate.outputPath, [...claims, ...pendingPaths])) {
          candidate.item.selectable = false
          candidate.item.reason = 'path-conflict'
        } else pendingPaths.push(candidate.outputPath)
      }
    }
    for (const [id, value] of this.previews)
      if (value.dto.expiresAt < this.clock()) this.previews.delete(id)
    while (this.previews.size >= 4) {
      const oldest = this.previews.keys().next().value
      if (!oldest) break
      this.previews.delete(oldest)
    }
    const dto: LegacyImportPreview = {
      previewId: randomUUID(),
      sourceHandle,
      sourceName: path.basename(source.root),
      items: snapshot.candidates.map((candidate) => candidate.item),
      running: snapshot.running,
      checkpointImportAvailable: false,
      expiresAt: this.clock() + PREVIEW_TTL,
    }
    this.previews.set(dto.previewId, { dto, snapshot })
    return dto
  }

  authorizeMetadata(
    input: unknown,
    chooseFile: () => Promise<string | null>
  ): Promise<LegacyImportPreview | null> {
    if (this.draining || this.activeRun || this.metadataAdmissions.size)
      return Promise.reject(this.error('busy'))
    const admission = this.authorizeMetadataAdmission(input, chooseFile)
    this.metadataAdmissions.add(admission)
    void admission
      .finally(() => this.metadataAdmissions.delete(admission))
      .catch(() => {})
    return admission
  }

  private async authorizeMetadataAdmission(
    input: unknown,
    chooseFile: () => Promise<string | null>
  ): Promise<LegacyImportPreview | null> {
    const { previewId, itemId } = legacyMetadataRequestSchema.parse(input)
    const preview = this.previews.get(previewId)
    const current = () => {
      if (
        !preview ||
        this.previews.get(previewId) !== preview ||
        preview.dto.expiresAt < this.clock()
      )
        throw this.error('expiredPreview')
      if (this.draining || this.activeRun || preview.committedRunId)
        throw this.error('busy')
      const candidate = preview.snapshot.candidates.find(
        (entry) => entry.item.itemId === itemId
      )
      if (
        candidate?.item.type !== 'bt' ||
        candidate.item.selectable ||
        candidate.item.reason !== 'metadata-required' ||
        !candidate.torrentReferencePath
      )
        throw this.error('invalidSelection')
      return candidate
    }
    const candidate = current()
    if (!preview) throw this.error('expiredPreview')
    const unchanged = async () => {
      current()
      const snapshot = await this.scanSource(preview.snapshot.source)
      current()
      if (snapshot.digest !== preview.snapshot.digest)
        throw this.error('changedSource')
      if (snapshot.running) throw this.error('running')
    }
    await unchanged()
    let selected: string | null
    try {
      selected = await Promise.race([
        chooseFile(),
        new Promise<null>((resolve) => {
          this.stopMetadataPicker = () => resolve(null)
        }),
      ])
    } finally {
      this.stopMetadataPicker = null
    }
    if (!selected) return null
    await unchanged()
    const grant = await authorizeLegacyTorrent(
      selected,
      candidate.torrentReferencePath ?? ''
    )
    const previous =
      this.metadataGrants.get(preview.dto.sourceHandle) ??
      new Map<string, LegacyTorrentGrant>()
    const trialGrants = new Map(previous)
    trialGrants.set(candidate.entry.digest, grant)
    const trial = await scanLegacySource(
      preview.snapshot.source,
      this.deps.isProcessRunning,
      trialGrants
    )
    const resolved = trial.candidates.find(
      (entry) => entry.entry.digest === candidate.entry.digest
    )
    if (!resolved?.torrent || !resolved.torrentRelativePath)
      throw this.error('metadataMismatch')
    await unchanged()
    // Admission owns the single metadata mutation lane. No previous grant or
    // preview changes until every chosen-file/source check has succeeded.
    this.metadataGrants.set(preview.dto.sourceHandle, trialGrants)
    try {
      const refreshed = await this.scan(preview.dto.sourceHandle, trial.digest)
      for (const [id, state] of this.previews)
        if (
          id !== refreshed.previewId &&
          state.dto.sourceHandle === preview.dto.sourceHandle
        )
          this.previews.delete(id)
      return refreshed
    } catch (error) {
      this.metadataGrants.set(preview.dto.sourceHandle, previous)
      throw error
    }
  }

  private scanSource(source: LegacySource): Promise<LegacySnapshot> {
    const handle = [...this.sources].find(
      ([, existing]) =>
        existing.root === source.root && existing.identity === source.identity
    )?.[0]
    return scanLegacySource(
      source,
      this.deps.isProcessRunning,
      handle ? this.metadataGrants.get(handle) : undefined
    )
  }

  commit(input: unknown): Promise<LegacyImportReport> {
    if (this.draining) return Promise.reject(this.error('busy'))
    const admission = this.commitAdmission(input)
    this.admissions.add(admission)
    void admission
      .finally(() => this.admissions.delete(admission))
      .catch(() => {})
    return admission
  }

  private async commitAdmission(input: unknown): Promise<LegacyImportReport> {
    const request = legacyCommitRequestSchema.parse(input)
    const preview = this.previews.get(request.previewId)
    if (!preview || preview.dto.expiresAt < this.clock())
      throw this.error('expiredPreview')
    if (preview.committedRunId) return this.getRun(preview.committedRunId)
    if (this.activeRun || this.metadataAdmissions.size) throw this.error('busy')
    const ids = new Set(request.itemIds)
    if (
      ids.size !== request.itemIds.length ||
      request.itemIds.some(
        (id) =>
          !preview.dto.items.some(
            (item) => item.itemId === id && item.selectable
          )
      )
    )
      throw this.error('invalidSelection')
    // Lock before the first await: two simultaneous commits cannot pass admission.
    const runId = randomUUID()
    this.activeRun = runId
    try {
      const refreshed = await this.scanSource(preview.snapshot.source)
      if (refreshed.digest !== preview.snapshot.digest)
        throw this.error('changedSource')
      if (refreshed.running) throw this.error('running')
      const selected = preview.snapshot.candidates.filter((candidate) =>
        ids.has(candidate.item.itemId)
      )
      this.assertNoConflicts(selected, preview.snapshot.sourceId)
      const report: LegacyImportReport = {
        runId,
        stage: 'backing-up',
        processed: 0,
        total: selected.length,
        imported: 0,
        backupCreated: false,
        items: preview.dto.items.map((item) => ({
          ...item,
          outcome: ids.has(item.itemId) ? 'unprocessed' : 'skipped',
          taskId: null,
          reason:
            item.selectable && !ids.has(item.itemId)
              ? 'not-selected'
              : item.reason,
        })),
      }
      this.deps.db.database
        .prepare(
          'INSERT INTO legacy_import_runs (run_id,source_id,snapshot_digest,report,created_at) VALUES (?,?,?,?,?)'
        )
        .run(
          runId,
          preview.snapshot.sourceId,
          preview.snapshot.digest,
          JSON.stringify(report),
          this.clock()
        )
      const backup = await this.backup(preview.snapshot, runId)
      // The source and liveness guard must still hold after the potentially slow backup.
      const afterBackup = await this.scanSource(preview.snapshot.source)
      if (afterBackup.digest !== preview.snapshot.digest)
        throw this.error('changedSource')
      if (afterBackup.running) throw this.error('running')
      report.backupCreated = true
      report.stage = 'committing'
      this.deps.db.database
        .prepare(
          'UPDATE legacy_import_runs SET backup_path=?,report=? WHERE run_id=?'
        )
        .run(backup, JSON.stringify(report), runId)
      preview.committedRunId = runId
      const job = this.runBatches(
        preview.snapshot,
        selected,
        backup,
        report
      ).finally(() => {
        this.activeRun = null
        this.runningJobs.delete(runId)
        this.cancelled.delete(runId)
      })
      this.runningJobs.set(runId, job)
      void job.catch(() => {})
      return this.getRun(runId)
    } catch (error) {
      const row = this.deps.db.database
        .prepare('SELECT report FROM legacy_import_runs WHERE run_id=?')
        .get(runId) as { report: string } | undefined
      if (row) {
        const report = legacyImportReportSchema.parse(JSON.parse(row.report))
        report.stage = 'failed'
        this.saveReport(report)
      }
      this.activeRun = null
      throw error
    }
  }

  getRun(runId: string): LegacyImportReport {
    const row = this.deps.db.database
      .prepare('SELECT report FROM legacy_import_runs WHERE run_id=?')
      .get(runId) as { report: string } | undefined
    if (!row) throw this.error('unknownRun')
    return legacyImportReportSchema.parse(JSON.parse(row.report))
  }

  cancel(runId: string): LegacyImportReport {
    if (this.activeRun === runId) this.cancelled.add(runId)
    return this.getRun(runId)
  }

  async drain(): Promise<void> {
    this.draining = true
    this.stopMetadataPicker?.()
    if (this.activeRun) this.cancelled.add(this.activeRun)
    // Backup and admission can still hold the database before a batch job exists.
    // Shutdown must wait for both phases before its caller closes the database.
    await Promise.allSettled(this.admissions)
    await Promise.allSettled(this.metadataAdmissions)
    await Promise.allSettled(this.runningJobs.values())
  }

  async retry(runId: string): Promise<LegacyImportReport> {
    const report = this.getRun(runId)
    const state = [...this.previews.values()].find(
      (preview) => preview.committedRunId === runId
    )
    if (!state) throw this.error('rescanRequired')
    const failed = report.items
      .filter(
        (item) => item.outcome === 'failed' || item.outcome === 'unprocessed'
      )
      .map((item) => item.itemId)
    if (!failed.length) return report
    const refreshed = await this.scan(state.dto.sourceHandle)
    return this.commit({ previewId: refreshed.previewId, itemIds: failed })
  }

  private async runBatches(
    snapshot: LegacySnapshot,
    selected: LegacyCandidate[],
    backup: string,
    report: LegacyImportReport
  ): Promise<void> {
    try {
      for (let offset = 0; offset < selected.length; offset += BATCH_SIZE) {
        // Yield at every boundary so a stop request can run before the next commit.
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (this.cancelled.has(report.runId)) break
        const batch = selected.slice(offset, offset + BATCH_SIZE)
        let committed = false
        let preflightPassed = false
        const commit = async () => {
          const refreshed = await this.scanSource(snapshot.source)
          if (refreshed.digest !== snapshot.digest)
            throw this.error('changedSource')
          if (refreshed.running) throw this.error('running')
          if (this.cancelled.has(report.runId)) return
          preflightPassed = true
          this.assertNoConflicts(batch, snapshot.sourceId)
          const now = this.clock()
          const graphs = batch.map((candidate) =>
            this.graph(candidate, snapshot.sourceId, backup, now)
          )
          const next: LegacyImportReport = structuredClone(report)
          for (let index = 0; index < batch.length; index++) {
            const item = next.items.find(
              (entry) => entry.itemId === batch[index].item.itemId
            )
            if (!item) throw this.error('invalidSelection')
            item.outcome = 'imported'
            item.taskId = graphs[index].task.motrixId
          }
          next.processed += batch.length
          next.imported += batch.length
          this.deps.db.saveLegacyImportBatch(graphs, () => {
            const ledger = this.deps.db.database.prepare(
              'INSERT INTO legacy_import_ledger (source_id,item_key,entry_digest,task_id,state) VALUES (?,?,?,?,?)'
            )
            const items = this.deps.db.database.prepare(
              'INSERT INTO legacy_import_items VALUES (?,?,?,?)'
            )
            for (let index = 0; index < batch.length; index++) {
              ledger.run(
                snapshot.sourceId,
                batch[index].entry.itemKey,
                batch[index].entry.digest,
                graphs[index].task.motrixId,
                'imported'
              )
              items.run(
                report.runId,
                batch[index].entry.itemKey,
                'imported',
                graphs[index].task.motrixId
              )
            }
            this.saveReport(next)
          })
          Object.assign(report, next)
          committed = true
          for (const graph of graphs)
            this.deps.taskManager.add(
              taskRowToDownloadTask(graph.task, graph.instances)
            )
          this.deps.publishTasks()
        }
        try {
          if (this.deps.runExclusivePersistence)
            await this.deps.runExclusivePersistence(commit)
          else await commit()
        } catch (error) {
          // A downstream observer or persistence-lane wrapper can fail after
          // SQLite committed. Its exception cannot undo durable import results.
          if (committed) continue
          // A stale source invalidates every remaining batch, not just this one.
          if (!preflightPassed) throw error
          for (const candidate of batch) {
            const item = report.items.find(
              (entry) => entry.itemId === candidate.item.itemId
            )
            if (item) {
              item.outcome = 'failed'
              item.reason = 'commit-failed'
            }
          }
          report.processed += batch.length
          this.saveReport(report)
        }
      }
      const stopped = this.cancelled.has(report.runId)
      report.stage = stopped ? 'cancelled' : 'completed'
      if (stopped)
        for (const item of report.items)
          if (item.outcome === 'unprocessed') item.reason = 'stopped'
      this.saveReport(report)
    } catch (error) {
      report.stage = 'failed'
      const changed =
        error instanceof Error && /changedSource|\.running$/.test(error.message)
      for (const item of report.items) {
        if (item.outcome !== 'unprocessed') continue
        item.outcome = 'failed'
        item.reason = changed ? 'changed-source' : 'commit-failed'
        report.processed++
      }
      this.saveReport(report)
    }
  }

  private graph(
    candidate: LegacyCandidate,
    sourceId: string,
    backup: string,
    now: number
  ): TaskWithInstancesAndFiles {
    const id = randomUUID()
    const finalPath = candidate.outputPath
    if (!finalPath) throw this.error('unsafePath')
    const type =
      candidate.item.type === 'bt'
        ? TaskType.Bt
        : candidate.item.type === 'magnet'
          ? TaskType.Magnet
          : TaskType.Http
    const torrentMetaPath = candidate.torrentRelativePath
      ? path.join(backup, candidate.torrentRelativePath)
      : null
    const payload = {
      legacyImport: {
        version: 1,
        sourceId,
        itemKey: candidate.entry.itemKey,
        activation: 'inactive',
        storagePolicy: 'legacy-read-only',
        reason: candidate.item.reason,
        selectionKnown: candidate.selectionKnown,
        selectedFiles: candidate.selectedFiles,
      },
    }
    return {
      task: {
        motrixId: id,
        name: candidate.item.name,
        kind: type === TaskType.Http ? TaskKind.Direct : TaskKind.Bt,
        taskType: type,
        category: null,
        priority: 0,
        tags: null,
        createdAt: now,
        updatedAt: now,
        saveDir: path.dirname(finalPath),
        finalPath,
        finalName: candidate.item.name,
        torrentMetaPath,
        infoHash: candidate.torrent?.infoHash ?? null,
        totalBytes: candidate.torrent?.totalSize ?? 0,
        downloadedBytes: 0,
        sizeWhenDone: 0,
        fileCount: candidate.torrent?.files.length ?? 1,
        isPrivate: candidate.torrent?.isPrivate ?? false,
        trackers: candidate.trackers,
        pieceLength: 0,
        aggStatus: TaskStatus.Paused,
        finishedAt: null,
        errorMessage: null,
        errorCode: null,
        errorDetailKey: null,
        errorDetailParams: null,
        diagnosisRevision: 0,
        uploadedBytesBaseline: 0,
        source: 'user',
        sourceMeta: null,
      },
      instances: [
        {
          instanceId: randomUUID(),
          motrixId: id,
          gid: null,
          phase:
            type === TaskType.Http
              ? TaskInstancePhase.HttpDownload
              : TaskInstancePhase.BtDownload,
          status: TaskStatus.Paused,
          progress: 0,
          totalBytes: candidate.torrent?.totalSize ?? 0,
          downloadedBytes: 0,
          uploadedBytes: 0,
          diskPath: finalPath,
          transitionPhase: TransitionPhase.Idle,
          uris: type === TaskType.Bt ? [] : candidate.entry.uris,
          uriHash: null,
          payload,
          createdAt: now,
          updatedAt: now,
        },
      ],
      files:
        candidate.torrent?.files.map((file) => ({
          fileIndex: file.index,
          path: file.path,
          size: file.size,
          selected: candidate.selectedFiles.includes(file.index),
        })) ?? [],
    }
  }

  private saveReport(report: LegacyImportReport): void {
    this.deps.db.database
      .prepare('UPDATE legacy_import_runs SET report=? WHERE run_id=?')
      .run(JSON.stringify(report), report.runId)
  }

  private claimedPaths(): string[] {
    return this.deps.db
      .getAllTasks()
      .flatMap(({ task, instances }) => [
        task.finalPath,
        ...instances.map((instance) => instance.diskPath),
      ])
      .filter(Boolean)
  }

  private overlaps(value: string, others: string[]): boolean {
    const identity = outputPathIdentity(value)
    return others.some((other) => {
      const candidate = outputPathIdentity(other)
      return (
        identity === candidate ||
        identity.startsWith(`${candidate}${path.sep}`) ||
        candidate.startsWith(`${identity}${path.sep}`)
      )
    })
  }

  private assertNoConflicts(
    candidates: LegacyCandidate[],
    sourceId: string
  ): void {
    const claims = this.claimedPaths()
    for (const candidate of candidates) {
      if (
        !candidate.outputPath ||
        this.overlaps(candidate.outputPath, claims) ||
        this.deps.db.database
          .prepare(
            'SELECT 1 FROM legacy_import_ledger WHERE source_id=? AND item_key=?'
          )
          .get(sourceId, candidate.entry.itemKey)
      )
        throw this.error('pathConflict')
      claims.push(candidate.outputPath)
    }
  }

  private async backup(
    snapshot: LegacySnapshot,
    runId: string
  ): Promise<string> {
    await mkdir(this.deps.backupRoot, { recursive: true, mode: 0o700 })
    const root = await lstat(this.deps.backupRoot)
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (await realpath(this.deps.backupRoot)) !==
        path.resolve(this.deps.backupRoot)
    )
      throw this.error('unsafeBackup')
    if (process.platform !== 'win32') await chmod(this.deps.backupRoot, 0o700)
    const target = path.join(this.deps.backupRoot, runId)
    await mkdir(target, { mode: 0o700 })
    const directories = new Set([target])
    const write = async (relativePath: string, bytes: Uint8Array) => {
      const filename = path.join(target, relativePath)
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
      if (
        !(await realpath(path.dirname(filename))).startsWith(
          `${target}${path.sep}`
        ) &&
        path.dirname(filename) !== target
      )
        throw this.error('unsafeBackup')
      for (
        let directory = path.dirname(filename);
        directory !== target;
        directory = path.dirname(directory)
      )
        directories.add(directory)
      const handle = await open(
        filename,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600
      )
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    for (const file of snapshot.files)
      await write(file.relativePath, file.bytes)
    await write(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          version: 1,
          sourceId: snapshot.sourceId,
          snapshotDigest: snapshot.digest,
          files: snapshot.files.map(({ relativePath, digest }) => ({
            relativePath,
            digest,
          })),
        })
      )
    )
    // Node cannot open directory handles for fsync on Windows; each file has
    // already been flushed. POSIX also flushes nested directory entries and
    // the parent that owns this run before any database reference is committed.
    if (process.platform !== 'win32') {
      for (const directory of [...directories]
        .sort((a, b) => b.length - a.length)
        .concat(this.deps.backupRoot)) {
        const handle = await open(
          directory,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        )
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    }
    return target
  }

  private error(reason: string): AppError {
    return new AppError(
      ErrorCode.IpcInvalidPayload,
      `legacyImport.errors.${reason}`
    )
  }
}
