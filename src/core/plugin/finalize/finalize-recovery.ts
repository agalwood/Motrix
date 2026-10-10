import path from 'node:path'
import { getLogger } from '@core/logger'
import type {
  ArtifactMutationLease,
  ArtifactMutationLeaseCoordinator,
} from './artifact-mutation-lease'
import {
  type FinalizeArtifactOperations,
  type FinalizeJournalRecord,
  type FinalizeJournalRepository,
  FinalizeQuarantinedError,
  finalizePathsEquivalent,
  prepareRemovalIntent,
  publishReserved,
} from './finalize-committer'
import {
  FinalizeRecoveryDeferredError,
  isUnavailableArtifactError,
} from './finalize-recovery-errors'
import {
  linkPublicationConfirmed,
  selectRemovalSurvivor,
} from './finalize-removal-safety'
import {
  reservationMatches,
  reservedArtifactMatches,
} from './reserved-identity'

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
        if (isUnavailableArtifactError(error)) {
          getLogger('finalize').warn(
            { journalId: record.journalId, err: error },
            'finalize recovery deferred until artifacts are available'
          )
          continue
        }
        if (!(error instanceof FinalizeQuarantinedError)) failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more finalize journals failed')
    }
  }

  async recoverTask(
    taskId: string,
    lease: ArtifactMutationLease
  ): Promise<void> {
    for (const record of await this.options.repository.listRecoverable(
      taskId
    )) {
      await this.recover(record, lease)
    }
  }

  async recover(
    record: FinalizeJournalRecord,
    existingLease?: ArtifactMutationLease
  ): Promise<void> {
    const lease =
      existingLease ?? (await this.options.leases.acquire(record.plan.taskId))
    try {
      if (record.quarantineReason) {
        if (!this.options.repository.resumeQuarantined) return
        // Legacy compensation failures can be reopened only for an ordinary
        // move with exactly one surviving, identity-verified name.
        if (!isRetryableMoveQuarantine(record)) return
        const source = await this.options.fs.identity(record.plan.sourcePath)
        const target = await this.options.fs.identity(record.plan.targetPath)
        const surviving = source ?? target
        if (
          !surviving ||
          Boolean(source) === Boolean(target) ||
          !this.options.exactIdentity(surviving, record.plan.sourceIdentity)
        )
          return
        await this.options.fs.makeDurable(
          source ? record.plan.sourcePath : record.plan.targetPath
        )
        await this.options.repository.resumeQuarantined(record)
        record.quarantineReason = undefined
      }
      if (record.publicationIntent?.method === 'reserved_rename') {
        await this.recoverReserved(record)
        return
      }
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

      // An unmounted disk or unavailable share can look exactly like ENOENT.
      // Absence alone is not evidence of a conflicting identity. Keep the
      // durable checkpoint so reconnecting the storage can resume recovery.
      if (!source && !target && !rollback && !privateTarget)
        throw new FinalizeRecoveryDeferredError(
          'finalize artifacts are unavailable; retry recovery'
        )

      const linked =
        record.publicationIntent?.method === 'hard_link'
          ? record.publicationIntent
          : undefined
      if (linked && target && !linkPublicationConfirmed(record)) {
        await this.quarantine(
          record,
          'hard-link publication ownership is unconfirmed'
        )
      }
      if (
        linked &&
        target &&
        (record.phase === 'prepared' || record.phase === 'target_staged')
      ) {
        const linkSource = await this.options.fs.identity(linked.sourcePath)
        if (
          !linkSource ||
          !this.options.exactIdentity(linkSource, linked.identity) ||
          !this.options.exactIdentity(target, linked.identity)
        ) {
          await this.quarantine(record, 'linked publication identity mismatch')
        }
        if (this.options.rollForwardTargetInstalled !== false) {
          await this.options.fs.makeDurable(record.plan.targetPath)
          await this.options.repository.advance(
            record.journalId,
            'target_installed',
            { targetIdentity: linked.identity }
          )
          record.targetIdentity = linked.identity
          record.phase = 'target_installed'
        }
      }

      if (record.phase === 'db_committed') {
        if (!target)
          throw new FinalizeRecoveryDeferredError(
            'committed target is unavailable; retry recovery'
          )
        if (!this.options.exactIdentity(target, installed)) {
          await this.quarantine(record, 'committed target identity mismatch')
        }
        await this.cleanup(record, source, rollback, privateTarget, replacement)
        return
      }

      if (record.phase === 'target_installed') {
        if (
          target &&
          this.options.exactIdentity(target, record.targetIdentity ?? installed)
        ) {
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
          if (privateTarget && !record.publicationIntent) {
            await this.quarantine(
              record,
              'target and private target both exist during recovery'
            )
          }
        } else if (
          privateTarget &&
          (record.privateTargetIdentity
            ? !this.options.exactIdentity(
                privateTarget,
                record.privateTargetIdentity
              )
            : !this.options.sameContent(privateTarget, selected))
        ) {
          await this.quarantine(record, 'private target identity mismatch')
        }
        // Both output names can be gone after an interrupted rollback. The
        // original must still be verified below before closing that journal.
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
      if (!existingLease) await lease.release()
    }
  }

  private async recoverReserved(record: FinalizeJournalRecord): Promise<void> {
    let intent = record.publicationIntent
    if (intent?.method !== 'reserved_rename')
      throw new Error('invalid reserved journal')
    const ownership = intent.ownership
    const sourceDirectory = path.dirname(intent.sourcePath)
    const volumeAvailable = async () => {
      if (!this.options.fs.reservedVolumeIdentity) return !ownership
      const id = await this.options.fs.reservedVolumeIdentity(sourceDirectory)
      return ownership ? id === ownership.volumeId : id !== null
    }
    if (!(await volumeAvailable())) return
    const quarantine = async (reason: string) => {
      // Recheck after IO: detaching between the volume probe and stat is retryable.
      if (await volumeAvailable()) await this.quarantine(record, reason)
    }
    const matches: FinalizeRecoveryIdentityComparator = ownership
      ? (actual, expected) =>
          reservedArtifactMatches(actual, expected, ownership)
      : this.options.exactIdentity
    const source = await this.options.fs.identity(intent.sourcePath)
    let target = await this.options.fs.identity(record.plan.targetPath)
    if (source) {
      if (record.phase !== 'prepared' || !matches(source, intent.identity))
        return quarantine('reserved source identity or phase mismatch')
      if (
        target &&
        (ownership
          ? !reservationMatches(target, ownership.token)
          : !intent.reservationIdentity ||
            !this.options.exactIdentity(target, intent.reservationIdentity))
      )
        return quarantine('reserved target ownership is unconfirmed')
      // Startup has no task/effects commit boundary. Preserve both names until
      // explicit retry enters SessionManager's serialized terminal transaction.
      if (this.options.rollForwardTargetInstalled === false) return
      if (!target && intent.reservationIdentity) {
        intent = { ...intent, reservationIdentity: undefined }
        await this.options.repository.checkpoint(record.journalId, {
          publicationIntent: intent,
        })
        record.publicationIntent = intent
      }
      target = await publishReserved(
        record,
        this.options.fs,
        this.options.repository
      )
    } else if (
      !target ||
      !matches(target, record.targetIdentity ?? intent.identity)
    ) {
      // An empty exFAT file may acquire a new ID. Without an acknowledged
      // identity transition, an equal empty digest cannot establish ownership.
      return quarantine('reserved installed target identity is unconfirmed')
    }
    if (!target) return quarantine('reserved target is missing')
    if (
      record.targetIdentity &&
      !this.options.exactIdentity(target, record.targetIdentity)
    ) {
      await this.options.repository.checkpoint(record.journalId, {
        targetIdentity: target,
      })
      record.targetIdentity = target
    }
    await this.options.fs.makeDurable(record.plan.targetPath)
    const verifyInstalled = async () => {
      const current = await this.options.fs.identity(record.plan.targetPath)
      if (!current || !this.options.exactIdentity(current, target)) {
        if (!(await volumeAvailable()))
          throw new Error('reserved volume is unavailable')
        await this.quarantine(record, 'reserved target changed before commit')
      }
    }
    await verifyInstalled()
    if (record.phase === 'prepared') {
      await this.options.repository.advance(
        record.journalId,
        'target_installed',
        { targetIdentity: target }
      )
      record.targetIdentity = target
      record.phase = 'target_installed'
    }
    if (record.phase === 'target_installed') {
      if (this.options.rollForwardTargetInstalled === false) return
      await verifyInstalled()
      await this.options.repository.commitTerminal(record)
      record.phase = 'db_committed'
    }
    if (record.phase === 'db_committed') {
      await this.options.repository.advance(record.journalId, 'cleaned')
      record.phase = 'cleaned'
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
    if (
      record.publicationMode === 'move' &&
      source &&
      record.publicationIntent?.method !== 'hard_link'
    ) {
      await this.quarantine(
        record,
        'moved source path unexpectedly exists after commit'
      )
    }
    if (
      (record.publicationMode !== 'move' ||
        record.publicationIntent?.method === 'hard_link') &&
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
    if (
      source &&
      target &&
      record.publicationIntent?.method === 'hard_link' &&
      this.options.exactIdentity(source, record.plan.sourceIdentity) &&
      this.options.exactIdentity(target, record.publicationIntent.identity)
    ) {
      await this.removeTracked(
        record,
        record.plan.targetPath,
        record.publicationIntent.identity
      )
      await this.options.fs.makeDurable(record.plan.sourcePath)
      await this.options.repository.advance(record.journalId, 'cleaned')
      return
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
      await this.options.fs.makeDurable(record.plan.sourcePath)
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
    const original = await this.options.fs.identity(intent.artifactPath)
    const quarantined = await this.options.fs.identity(intent.quarantinePath)
    if (
      (original && quarantined) ||
      (original && !this.options.exactIdentity(original, intent.identity)) ||
      (quarantined && !this.options.exactIdentity(quarantined, intent.identity))
    ) {
      await this.quarantine(
        record,
        'persisted removal intent identity mismatch'
      )
    }
    const survivor = await selectRemovalSurvivor(
      record,
      intent,
      this.options.fs,
      this.options.exactIdentity
    )
    if (typeof survivor === 'string') return this.quarantine(record, survivor)
    await this.options.fs.removeKnown(
      intent.artifactPath,
      intent.identity,
      intent.quarantinePath,
      intent.isolation,
      survivor
    )
    record.removalIntent = undefined
    await this.options.repository.checkpoint(record.journalId, {
      removalIntent: undefined,
    })
  }

  private async removeTracked(
    record: FinalizeJournalRecord,
    artifactPath: string,
    identity: FinalizeJournalRecord['plan']['sourceIdentity']
  ): Promise<void> {
    const removalIntent = await prepareRemovalIntent(
      this.options.fs,
      record.journalId,
      artifactPath,
      identity
    )
    await this.options.repository.checkpoint(record.journalId, {
      removalIntent,
    })
    record.removalIntent = removalIntent
    const survivor = await selectRemovalSurvivor(
      record,
      removalIntent,
      this.options.fs,
      this.options.exactIdentity
    )
    if (typeof survivor === 'string') return this.quarantine(record, survivor)
    await this.options.fs.removeKnown(
      artifactPath,
      identity,
      removalIntent.quarantinePath,
      removalIntent.isolation,
      survivor
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

/** Only the old blanket compensation quarantine is eligible for automatic retry. */
export function isRetryableMoveQuarantine(
  record: FinalizeJournalRecord
): boolean {
  return (
    record.quarantineReason?.startsWith('compensation failed after ') ===
      true &&
    record.publicationMode === 'move' &&
    (record.phase === 'prepared' || record.phase === 'target_installed') &&
    !record.plan.replacement &&
    !record.privateTargetPath &&
    !record.privateTargetIdentity &&
    !record.rollbackPath &&
    !record.removalIntent &&
    !record.publicationIntent &&
    !finalizePathsEquivalent(record.plan.sourcePath, record.plan.targetPath)
  )
}
