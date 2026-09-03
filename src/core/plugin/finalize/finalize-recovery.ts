import type { ArtifactMutationLeaseCoordinator } from './artifact-mutation-lease'
import {
  type FinalizeArtifactOperations,
  type FinalizeJournalRecord,
  type FinalizeJournalRepository,
  FinalizeQuarantinedError,
  finalizePathsEquivalent,
  removalQuarantinePath,
} from './finalize-committer'

export interface FinalizeRecoveryOptions {
  repository: FinalizeJournalRepository
  leases: ArtifactMutationLeaseCoordinator
  fs: FinalizeArtifactOperations
  exactIdentity: FinalizeRecoveryIdentityComparator
  sameContent: FinalizeRecoveryIdentityComparator
  /** Production may safely roll back a target whose task DB commit is absent. */
  rollForwardTargetInstalled?: boolean
}

export type FinalizeRecoveryIdentityComparator = (
  left: FinalizeJournalRecord['plan']['sourceIdentity'],
  right: FinalizeJournalRecord['plan']['sourceIdentity']
) => boolean

export class FinalizeRecovery {
  constructor(private readonly options: FinalizeRecoveryOptions) {}

  async recoverAll(): Promise<void> {
    const failures: unknown[] = []
    for (const record of await this.options.repository.listRecoverable()) {
      try {
        await this.recover(record)
      } catch (error) {
        if (!(error instanceof FinalizeQuarantinedError)) failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more finalize journals failed')
    }
  }

  async recover(record: FinalizeJournalRecord): Promise<void> {
    const lease = await this.options.leases.acquire(record.plan.taskId)
    try {
      if (record.quarantineReason) return
      await this.resumeRemovalIntent(record)
      const selected =
        record.plan.replacement?.identity ?? record.plan.sourceIdentity
      const installed = record.targetIdentity ?? selected
      const source = await this.options.fs.identity(record.plan.sourcePath)
      const target = await this.options.fs.identity(record.plan.targetPath)
      const rollback = record.rollbackPath
        ? await this.options.fs.identity(record.rollbackPath)
        : null
      const privateTarget = record.privateTargetPath
        ? await this.options.fs.identity(record.privateTargetPath)
        : null
      const replacement = record.plan.replacement
        ? await this.options.fs.identity(record.plan.replacement.stagedPath)
        : null

      if (record.phase === 'db_committed') {
        if (!target || !this.options.exactIdentity(target, installed)) {
          await this.quarantine(record, 'committed target identity mismatch')
        }
        await this.cleanup(record, source, rollback, privateTarget, replacement)
        return
      }

      if (record.phase === 'target_installed') {
        if (target && this.options.exactIdentity(target, installed)) {
          if (this.options.rollForwardTargetInstalled !== false) {
            await this.options.repository.commitTerminal(record)
            record.phase = 'db_committed'
            await this.cleanup(
              record,
              source,
              rollback,
              privateTarget,
              replacement
            )
          } else if (record.publicationMode === 'move') {
            await this.restoreMovedSource(record, source, target)
          } else {
            await this.restore(
              record,
              target,
              rollback,
              privateTarget,
              replacement
            )
          }
          return
        }
        if (record.publicationMode === 'move') {
          await this.restoreMovedSource(record, source, target)
          return
        }
        await this.restore(record, target, rollback, privateTarget, replacement)
        return
      }

      if (record.phase === 'source_preserved') {
        if (
          rollback &&
          this.options.exactIdentity(rollback, record.plan.sourceIdentity)
        ) {
          await this.restore(
            record,
            target,
            rollback,
            privateTarget,
            replacement
          )
          return
        }
        await this.quarantine(record, 'preserved source is missing or changed')
      }

      if (record.phase === 'target_staged') {
        const expectedInstalled = record.privateTargetIdentity ?? selected
        if (target) {
          if (!this.options.exactIdentity(target, expectedInstalled)) {
            await this.quarantine(record, 'unknown target blocks recovery')
          }
          if (privateTarget) {
            await this.quarantine(
              record,
              'target and private target both exist during recovery'
            )
          }
        } else if (
          !privateTarget ||
          (record.privateTargetIdentity
            ? !this.options.exactIdentity(
                privateTarget,
                record.privateTargetIdentity
              )
            : !this.options.sameContent(privateTarget, selected))
        ) {
          await this.quarantine(record, 'private target is missing or changed')
        }
        const samePathReplacement =
          record.plan.replacement !== undefined &&
          finalizePathsEquivalent(
            record.plan.sourcePath,
            record.plan.targetPath
          )
        if (samePathReplacement) {
          if (
            !rollback ||
            !this.options.exactIdentity(rollback, record.plan.sourceIdentity)
          ) {
            await this.quarantine(
              record,
              'preserved source changed before install recovery'
            )
          }
        } else if (
          !source ||
          !this.options.exactIdentity(source, record.plan.sourceIdentity)
        ) {
          await this.quarantine(
            record,
            'source changed before install recovery'
          )
        }
        await this.restore(record, target, rollback, privateTarget, replacement)
        return
      }

      if (record.phase === 'prepared') {
        if (record.publicationMode === 'move') {
          await this.restoreMovedSource(record, source, target)
          return
        }
        await this.restorePrepared(
          record,
          source,
          target,
          rollback,
          privateTarget,
          replacement
        )
        return
      }
    } finally {
      await lease.release()
    }
  }

  private async restore(
    record: FinalizeJournalRecord,
    target: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    rollback: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    privateTarget: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    replacement: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>
  ): Promise<void> {
    const selected =
      record.plan.replacement?.identity ?? record.plan.sourceIdentity
    const targetIsOriginal =
      record.plan.replacement === undefined &&
      finalizePathsEquivalent(record.plan.sourcePath, record.plan.targetPath)
    if (
      targetIsOriginal &&
      (!target ||
        !this.options.exactIdentity(target, record.plan.sourceIdentity))
    ) {
      await this.quarantine(
        record,
        'same-path original changed during recovery'
      )
    }
    if (target && !targetIsOriginal) {
      const installed =
        record.targetIdentity ?? record.privateTargetIdentity ?? selected
      if (!this.options.exactIdentity(target, installed)) {
        await this.quarantine(record, 'unknown target blocks recovery')
      }
      await this.removeTracked(record, record.plan.targetPath, installed)
    }
    if (privateTarget && record.privateTargetPath) {
      const expectedPrivate = record.privateTargetIdentity
      if (
        expectedPrivate
          ? !this.options.exactIdentity(privateTarget, expectedPrivate)
          : !this.options.sameContent(privateTarget, selected)
      ) {
        await this.quarantine(record, 'unknown private target blocks recovery')
      }
      await this.removeTracked(
        record,
        record.privateTargetPath,
        expectedPrivate ?? privateTarget
      )
    }
    if (rollback && record.rollbackPath) {
      if (!this.options.exactIdentity(rollback, record.plan.sourceIdentity)) {
        await this.quarantine(record, 'unknown rollback blocks recovery')
      }
      await this.options.fs.moveNoReplace(
        record.rollbackPath,
        record.plan.sourceIdentity,
        record.plan.sourcePath
      )
      await this.options.fs.makeDurable(record.plan.sourcePath)
    }
    await this.removeReplacement(record, replacement)
    await this.options.repository.advance(record.journalId, 'cleaned')
  }

  private async cleanup(
    record: FinalizeJournalRecord,
    source: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    rollback: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    privateTarget: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    replacement: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>
  ): Promise<void> {
    if (record.publicationMode === 'move' && source) {
      await this.quarantine(
        record,
        'moved source path unexpectedly exists after commit'
      )
    }
    if (
      record.publicationMode !== 'move' &&
      source &&
      !finalizePathsEquivalent(record.plan.sourcePath, record.plan.targetPath)
    ) {
      if (!this.options.exactIdentity(source, record.plan.sourceIdentity)) {
        await this.quarantine(record, 'cleanup source identity mismatch')
      }
      await this.removeTracked(
        record,
        record.plan.sourcePath,
        record.plan.sourceIdentity
      )
    }
    if (rollback && record.rollbackPath) {
      if (!this.options.exactIdentity(rollback, record.plan.sourceIdentity)) {
        await this.quarantine(record, 'cleanup rollback identity mismatch')
      }
      await this.removeTracked(
        record,
        record.rollbackPath,
        record.plan.sourceIdentity
      )
    }
    if (privateTarget && record.privateTargetPath) {
      const selected =
        record.plan.replacement?.identity ?? record.plan.sourceIdentity
      const expectedPrivate = record.privateTargetIdentity
      if (
        expectedPrivate
          ? !this.options.exactIdentity(privateTarget, expectedPrivate)
          : !this.options.sameContent(privateTarget, selected)
      ) {
        await this.quarantine(
          record,
          'cleanup private target identity mismatch'
        )
      }
      await this.removeTracked(
        record,
        record.privateTargetPath,
        expectedPrivate ?? selected
      )
    }
    await this.removeReplacement(record, replacement)
    await this.options.repository.advance(record.journalId, 'cleaned')
  }

  private async restoreMovedSource(
    record: FinalizeJournalRecord,
    source: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    target: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>
  ): Promise<void> {
    if (
      record.plan.replacement ||
      finalizePathsEquivalent(record.plan.sourcePath, record.plan.targetPath)
    ) {
      await this.quarantine(record, 'invalid move publication journal')
    }
    if (source && target) {
      await this.quarantine(
        record,
        'source and target both exist during move recovery'
      )
    }
    if (source) {
      if (!this.options.exactIdentity(source, record.plan.sourceIdentity)) {
        await this.quarantine(record, 'moved source identity mismatch')
      }
      await this.options.repository.advance(record.journalId, 'cleaned')
      return
    }
    const expectedTarget = record.targetIdentity ?? record.plan.sourceIdentity
    if (!target || !this.options.exactIdentity(target, expectedTarget)) {
      await this.quarantine(record, 'moved target is missing or changed')
    }
    await this.options.fs.moveNoReplace(
      record.plan.targetPath,
      expectedTarget,
      record.plan.sourcePath
    )
    await this.options.fs.makeDurable(record.plan.sourcePath)
    await this.options.repository.advance(record.journalId, 'cleaned')
  }

  private async restorePrepared(
    record: FinalizeJournalRecord,
    source: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    target: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    rollback: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    privateTarget: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>,
    replacement: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>
  ): Promise<void> {
    if (record.rollbackPath) {
      if (source && rollback) {
        await this.quarantine(record, 'prepared source and rollback both exist')
      }
      if (rollback) {
        if (!this.options.exactIdentity(rollback, record.plan.sourceIdentity)) {
          await this.quarantine(record, 'prepared rollback identity mismatch')
        }
        if (source) {
          await this.quarantine(record, 'prepared source blocks rollback')
        }
        await this.options.fs.moveNoReplace(
          record.rollbackPath,
          record.plan.sourceIdentity,
          record.plan.sourcePath
        )
        await this.options.fs.makeDurable(record.plan.sourcePath)
      } else if (
        !source ||
        !this.options.exactIdentity(source, record.plan.sourceIdentity)
      ) {
        await this.quarantine(record, 'prepared source is missing or changed')
      }
    } else if (
      !source ||
      !this.options.exactIdentity(source, record.plan.sourceIdentity)
    ) {
      await this.quarantine(record, 'prepared source is missing or changed')
    }

    if (
      target &&
      !finalizePathsEquivalent(record.plan.sourcePath, record.plan.targetPath)
    ) {
      await this.quarantine(record, 'unexpected target exists while prepared')
    }
    if (privateTarget && record.privateTargetPath) {
      const selected =
        record.plan.replacement?.identity ?? record.plan.sourceIdentity
      if (!this.options.sameContent(privateTarget, selected)) {
        await this.quarantine(
          record,
          'prepared private target identity mismatch'
        )
      }
      await this.removeTracked(record, record.privateTargetPath, privateTarget)
    }
    await this.removeReplacement(record, replacement)
    await this.options.repository.advance(record.journalId, 'cleaned')
  }

  private async removeReplacement(
    record: FinalizeJournalRecord,
    replacement: Awaited<ReturnType<FinalizeArtifactOperations['identity']>>
  ): Promise<void> {
    const planned = record.plan.replacement
    if (!planned || !replacement) return
    if (!this.options.exactIdentity(replacement, planned.identity)) {
      await this.quarantine(record, 'replacement staging identity mismatch')
    }
    await this.removeTracked(record, planned.stagedPath, planned.identity)
  }

  private async resumeRemovalIntent(
    record: FinalizeJournalRecord
  ): Promise<void> {
    const intent = record.removalIntent
    if (!intent) return
    try {
      await this.options.fs.removeKnown(
        intent.artifactPath,
        intent.identity,
        intent.quarantinePath
      )
      record.removalIntent = undefined
      await this.options.repository.checkpoint(record.journalId, {
        removalIntent: undefined,
      })
    } catch (error) {
      await this.quarantine(
        record,
        `persisted removal intent failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async removeTracked(
    record: FinalizeJournalRecord,
    artifactPath: string,
    identity: FinalizeJournalRecord['plan']['sourceIdentity']
  ): Promise<void> {
    const removalIntent = {
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
