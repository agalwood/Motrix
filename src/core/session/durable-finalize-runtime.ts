import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  artifactContentEquals,
  artifactIdentityEquals,
  readArtifactIdentity,
} from '@core/plugin/finalize/artifact-identity'
import { ArtifactMutationLeaseCoordinator } from '@core/plugin/finalize/artifact-mutation-lease'
import type { FinalizeArtifactOperations } from '@core/plugin/finalize/finalize-committer'
import {
  type FinalizeCommitResult,
  FinalizeCommitter,
} from '@core/plugin/finalize/finalize-committer'
import { FinalizeRecovery } from '@core/plugin/finalize/finalize-recovery'
import { freezeHookPlan } from '@core/plugin/finalize/hook-plan'
import type { StagedMetadataOp } from '@core/plugin/hooks/staged-effects'
import type { PostDeliveryAdmission } from '@core/plugin/post/delivery-types'
import type { DownloadTask } from '@shared/types/task'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import type Database from 'better-sqlite3'
import { SqliteFinalizeJournalRepository } from './finalize-journal-repository'
import type { SessionManager } from './session-manager'

export interface DurableFinalizeArtifactInput {
  task: DownloadTask
  occurrence: TaskOccurrence | null
  sourcePath: string
  targetPath: string
  replacement?: { pluginId: string; stagedPath: string }
  metadataOps: readonly StagedMetadataOp[]
  contributors: readonly string[]
  postDeliveries: readonly PostDeliveryAdmission[]
  beforeCommit?: () => void
  fileRebase?: { sourceRoot: string; targetRoot: string }
}

export interface DurableFinalizeRuntimeOptions {
  db: Database.Database
  session: Pick<SessionManager, 'persistFinalizedArtifact'>
  fs: FinalizeArtifactOperations
  leases?: ArtifactMutationLeaseCoordinator
  now?: () => number
}

/** Owns the filesystem journal and the one FS→SQLite commit boundary. */
export class DurableFinalizeRuntime {
  private readonly leases: ArtifactMutationLeaseCoordinator
  private readonly now: () => number

  constructor(private readonly options: DurableFinalizeRuntimeOptions) {
    this.leases = options.leases ?? new ArtifactMutationLeaseCoordinator([])
    this.now = options.now ?? Date.now
  }

  async commit(
    input: DurableFinalizeArtifactInput
  ): Promise<FinalizeCommitResult> {
    const lease = await this.leases.acquire(input.task.id)
    try {
      // H8: identity capture is inside the mutation lease, after every
      // engine/Host writer has successfully quiesced.
      const sourceIdentity = await readArtifactIdentity(input.sourcePath)
      const replacement = input.replacement
        ? {
            ...input.replacement,
            identity: await readArtifactIdentity(input.replacement.stagedPath),
          }
        : undefined
      const plan = freezeHookPlan({
        planId: randomUUID(),
        taskId: input.task.id,
        saveDir: input.task.saveDir,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        sourceIdentity,
        replacement,
        metadataOps: input.metadataOps,
        contributors: input.contributors,
      })

      return await this.options.session.persistFinalizedArtifact(
        input.task,
        input.occurrence,
        {
          metadataOps: input.metadataOps,
          postDeliveries: input.postDeliveries,
          beforeCommit: input.beforeCommit,
          fileRebase: input.fileRebase,
        },
        async (commitDatabase) => {
          const repository = new SqliteFinalizeJournalRepository(
            this.options.db,
            {
              now: this.now,
              commitTerminalBoundary: (record) => {
                if (!record.targetIdentity) {
                  throw new Error('finalize target identity is missing')
                }
                commitDatabase({
                  journalId: record.journalId,
                  taskId: input.task.id,
                  targetIdentity: record.targetIdentity,
                  updatedAt: this.now(),
                })
              },
            }
          )
          const committer = new FinalizeCommitter({
            leases: this.leases,
            repository,
            fs: this.options.fs,
            privatePathFor: (candidate) =>
              path.join(
                path.dirname(candidate.targetPath),
                `.motrix-finalize-${candidate.planId}.target`
              ),
            rollbackPathFor: (candidate) =>
              path.join(
                path.dirname(candidate.sourcePath),
                `.motrix-finalize-${candidate.planId}.rollback`
              ),
            exactIdentity: artifactIdentityEquals,
            sameContent: artifactContentEquals,
          })
          return committer.commit(plan, lease)
        }
      )
    } finally {
      await lease.release()
    }
  }

  /** Recover before task restore: committed rows clean up; uncommitted targets roll back. */
  async recoverAll(): Promise<void> {
    const repository = new SqliteFinalizeJournalRepository(this.options.db, {
      now: this.now,
      commitTerminalBoundary: () => {
        throw new Error(
          'startup recovery is configured to roll back uncommitted targets'
        )
      },
    })
    const recovery = new FinalizeRecovery({
      repository,
      leases: this.leases,
      fs: this.options.fs,
      exactIdentity: artifactIdentityEquals,
      sameContent: artifactContentEquals,
      rollForwardTargetInstalled: false,
    })
    await recovery.recoverAll()
  }
}
