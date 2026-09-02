import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ArtifactIdentity } from './artifact-identity'
import type {
  ArtifactMutationLease,
  ArtifactMutationLeaseCoordinator,
} from './artifact-mutation-lease'
import { assertValidHookPlan, type HookPlan } from './hook-plan'

export type FinalizeJournalPhase =
  | 'prepared'
  | 'target_staged'
  | 'source_preserved'
  | 'target_installed'
  | 'db_committed'
  | 'cleaned'

export interface FinalizeJournalRecord {
  journalId: string
  phase: FinalizeJournalPhase
  plan: HookPlan
  privateTargetPath?: string
  privateTargetIdentity?: ArtifactIdentity
  targetIdentity?: ArtifactIdentity
  rollbackPath?: string
  removalIntent?: FinalizeRemovalIntent
  quarantineReason?: string
}

export interface FinalizeRemovalIntent {
  artifactPath: string
  quarantinePath: string
  identity: ArtifactIdentity
}

export interface FinalizeJournalRepository {
  prepare(record: FinalizeJournalRecord): Promise<void>
  checkpoint(
    journalId: string,
    patch: Partial<
      Pick<
        FinalizeJournalRecord,
        | 'privateTargetPath'
        | 'privateTargetIdentity'
        | 'targetIdentity'
        | 'rollbackPath'
        | 'removalIntent'
      >
    >
  ): Promise<void>
  advance(
    journalId: string,
    phase: FinalizeJournalPhase,
    patch?: Partial<
      Pick<
        FinalizeJournalRecord,
        | 'privateTargetPath'
        | 'privateTargetIdentity'
        | 'targetIdentity'
        | 'rollbackPath'
        | 'quarantineReason'
      >
    >
  ): Promise<void>
  commitTerminal(record: FinalizeJournalRecord): Promise<void>
  quarantine(journalId: string, reason: string): Promise<void>
  listRecoverable(): Promise<FinalizeJournalRecord[]>
}

export interface FinalizeArtifactOperations {
  identity(artifactPath: string): Promise<ArtifactIdentity | null>
  sameFilesystem(leftPath: string, rightPath: string): Promise<boolean>
  materializePrivate(
    sourcePath: string,
    expected: ArtifactIdentity,
    privateTargetPath: string
  ): Promise<ArtifactIdentity>
  moveNoReplace(
    sourcePath: string,
    expected: ArtifactIdentity,
    targetPath: string
  ): Promise<void>
  makeDurable(artifactPath: string): Promise<void>
  removeKnown(
    artifactPath: string,
    expected: ArtifactIdentity,
    quarantinePath: string
  ): Promise<void>
}

export interface FinalizeCommitResult {
  journalId: string
  targetPath: string
  targetIdentity: ArtifactIdentity
  cleanupPending?: boolean
}

export class FinalizeQuarantinedError extends Error {
  constructor(
    readonly journalId: string,
    readonly reason: string,
    options?: ErrorOptions
  ) {
    super(`finalize journal ${journalId} quarantined: ${reason}`, options)
    this.name = 'FinalizeQuarantinedError'
  }
}

export interface FinalizeCommitterOptions {
  leases: ArtifactMutationLeaseCoordinator
  repository: FinalizeJournalRepository
  fs: FinalizeArtifactOperations
  privatePathFor(plan: HookPlan): string
  rollbackPathFor(plan: HookPlan): string
  exactIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean
  sameContent(left: ArtifactIdentity, right: ArtifactIdentity): boolean
}

export class FinalizeCommitter {
  constructor(private readonly options: FinalizeCommitterOptions) {}

  async commit(
    plan: HookPlan,
    existingLease?: ArtifactMutationLease
  ): Promise<FinalizeCommitResult> {
    assertValidHookPlan(plan)
    const lease =
      existingLease ?? (await this.options.leases.acquire(plan.taskId))
    const ownsLease = existingLease === undefined
    const record: FinalizeJournalRecord = {
      journalId: plan.planId,
      phase: 'prepared',
      plan,
    }
    try {
      await this.requireExactIdentity(
        plan.sourcePath,
        plan.sourceIdentity,
        record
      )
      if (plan.replacement) {
        await this.requireExactIdentity(
          plan.replacement.stagedPath,
          plan.replacement.identity,
          record
        )
      }
      await this.options.repository.prepare(record)
      return await this.commitPrepared(record, lease)
    } catch (error) {
      if (error instanceof FinalizeQuarantinedError) throw error
      await this.compensate(record, lease, error)
      throw error
    } finally {
      if (ownsLease) await lease.release()
    }
  }

  private async commitPrepared(
    record: FinalizeJournalRecord,
    _lease: ArtifactMutationLease
  ): Promise<FinalizeCommitResult> {
    const { plan } = record
    const selectedPath = plan.replacement?.stagedPath ?? plan.sourcePath
    const selectedIdentity = plan.replacement?.identity ?? plan.sourceIdentity
    const samePath = finalizePathsEquivalent(plan.sourcePath, plan.targetPath)

    if (samePath && !plan.replacement) {
      await this.requireExactIdentity(
        plan.sourcePath,
        plan.sourceIdentity,
        record
      )
      await this.options.fs.makeDurable(plan.sourcePath)
    } else {
      if (samePath) {
        record.rollbackPath = this.options.rollbackPathFor(plan)
        await this.options.repository.checkpoint(record.journalId, {
          rollbackPath: record.rollbackPath,
        })
        await this.options.fs.moveNoReplace(
          plan.sourcePath,
          plan.sourceIdentity,
          record.rollbackPath
        )
        await this.options.fs.makeDurable(record.rollbackPath)
        await this.options.repository.advance(
          record.journalId,
          'source_preserved',
          { rollbackPath: record.rollbackPath }
        )
        record.phase = 'source_preserved'
      }

      record.privateTargetPath = this.options.privatePathFor(plan)
      await this.options.repository.checkpoint(record.journalId, {
        privateTargetPath: record.privateTargetPath,
        rollbackPath: record.rollbackPath,
      })
      const privateIdentity = await this.options.fs.materializePrivate(
        selectedPath,
        selectedIdentity,
        record.privateTargetPath
      )
      if (!this.options.sameContent(privateIdentity, selectedIdentity)) {
        await this.quarantine(record, 'private target identity mismatch')
      }
      record.privateTargetIdentity = privateIdentity
      await this.options.fs.makeDurable(record.privateTargetPath)
      await this.options.repository.advance(record.journalId, 'target_staged', {
        privateTargetPath: record.privateTargetPath,
        privateTargetIdentity: privateIdentity,
        rollbackPath: record.rollbackPath,
      })
      record.phase = 'target_staged'

      await this.requireExactIdentity(
        record.privateTargetPath,
        privateIdentity,
        record
      )
      await this.options.fs.moveNoReplace(
        record.privateTargetPath,
        privateIdentity,
        plan.targetPath
      )
      await this.options.fs.makeDurable(plan.targetPath)
    }

    const targetIdentity = await this.requireExactIdentity(
      plan.targetPath,
      samePath && !plan.replacement
        ? plan.sourceIdentity
        : (record.privateTargetIdentity as ArtifactIdentity),
      record
    )
    record.targetIdentity = targetIdentity
    await this.options.repository.advance(
      record.journalId,
      'target_installed',
      {
        targetIdentity,
      }
    )
    record.phase = 'target_installed'
    await this.requireExactIdentity(plan.targetPath, targetIdentity, record)

    await this.options.repository.commitTerminal(record)
    record.phase = 'db_committed'
    let cleanupPending = false
    try {
      if (!samePath) {
        await this.requireExactIdentity(
          plan.sourcePath,
          plan.sourceIdentity,
          record
        )
        await this.removeTracked(record, plan.sourcePath, plan.sourceIdentity)
      }
      if (record.rollbackPath) {
        await this.requireExactIdentity(
          record.rollbackPath,
          plan.sourceIdentity,
          record
        )
        await this.removeTracked(
          record,
          record.rollbackPath,
          plan.sourceIdentity
        )
      }
      if (plan.replacement) {
        await this.requireExactIdentity(
          plan.replacement.stagedPath,
          plan.replacement.identity,
          record
        )
        await this.removeTracked(
          record,
          plan.replacement.stagedPath,
          plan.replacement.identity
        )
      }
      await this.options.repository.advance(record.journalId, 'cleaned')
      record.phase = 'cleaned'
    } catch {
      // The user-visible target and database already committed. Leave the
      // journal at db_committed so startup recovery can retry only cleanup.
      cleanupPending = true
    }
    return {
      journalId: record.journalId,
      targetPath: plan.targetPath,
      targetIdentity,
      ...(cleanupPending ? { cleanupPending: true } : {}),
    }
  }

  private async compensate(
    record: FinalizeJournalRecord,
    _lease: ArtifactMutationLease,
    cause: unknown
  ): Promise<void> {
    if (record.phase === 'db_committed' || record.phase === 'cleaned') return
    try {
      const installedIdentity =
        record.targetIdentity ?? record.privateTargetIdentity
      const target = await this.options.fs.identity(record.plan.targetPath)
      if (
        target &&
        installedIdentity &&
        this.options.exactIdentity(target, installedIdentity)
      ) {
        await this.removeTracked(
          record,
          record.plan.targetPath,
          installedIdentity
        )
      } else if (target) {
        await this.quarantine(record, 'compensation target identity mismatch')
      }
      if (record.rollbackPath) {
        await this.requireExactIdentity(
          record.rollbackPath,
          record.plan.sourceIdentity,
          record
        )
        await this.options.fs.moveNoReplace(
          record.rollbackPath,
          record.plan.sourceIdentity,
          record.plan.sourcePath
        )
        await this.options.fs.makeDurable(record.plan.sourcePath)
      }
      if (record.privateTargetPath) {
        const privateTarget = await this.options.fs.identity(
          record.privateTargetPath
        )
        if (privateTarget) {
          const expectedPrivate = record.privateTargetIdentity
          const selected =
            record.plan.replacement?.identity ?? record.plan.sourceIdentity
          if (
            expectedPrivate
              ? !this.options.exactIdentity(privateTarget, expectedPrivate)
              : !this.options.sameContent(privateTarget, selected)
          ) {
            await this.quarantine(
              record,
              'compensation private target identity mismatch'
            )
          }
          await this.removeTracked(
            record,
            record.privateTargetPath,
            expectedPrivate ?? privateTarget
          )
        }
      }
    } catch (compensationError) {
      await this.options.repository.quarantine(
        record.journalId,
        `compensation failed after ${String(cause)}: ${String(compensationError)}`
      )
      throw new FinalizeQuarantinedError(
        record.journalId,
        'compensation failed',
        { cause: compensationError }
      )
    }
  }

  private async requireExactIdentity(
    artifactPath: string,
    expected: ArtifactIdentity,
    record: FinalizeJournalRecord
  ): Promise<ArtifactIdentity> {
    const actual = await this.options.fs.identity(artifactPath)
    if (!actual || !this.options.exactIdentity(actual, expected)) {
      await this.quarantine(record, `identity mismatch at ${artifactPath}`)
    }
    return actual as ArtifactIdentity
  }

  private async removeTracked(
    record: FinalizeJournalRecord,
    artifactPath: string,
    identity: ArtifactIdentity
  ): Promise<void> {
    const removalIntent: FinalizeRemovalIntent = {
      artifactPath,
      quarantinePath: removalQuarantinePath(record.journalId, artifactPath),
      identity,
    }
    record.removalIntent = removalIntent
    await this.options.repository.checkpoint(record.journalId, {
      removalIntent,
    })
    await this.options.fs.removeKnown(
      artifactPath,
      identity,
      removalIntent.quarantinePath
    )
    record.removalIntent = undefined
    await this.options.repository.checkpoint(record.journalId, {
      removalIntent: undefined,
    })
  }

  private async quarantine(
    record: FinalizeJournalRecord,
    reason: string
  ): Promise<never> {
    await this.options.repository.quarantine(record.journalId, reason)
    throw new FinalizeQuarantinedError(record.journalId, reason)
  }
}

export function removalQuarantinePath(
  journalId: string,
  artifactPath: string
): string {
  const digest = createHash('sha256')
    .update(journalId)
    .update('\0')
    .update(path.resolve(artifactPath))
    .digest('hex')
    .slice(0, 32)
  return path.join(
    path.dirname(artifactPath),
    `.motrix-finalize-remove-${digest}`
  )
}

export function finalizePathsEquivalent(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}
