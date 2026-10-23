import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import {
  type ArtifactIdentity,
  type FileArtifactIdentity,
  type RenameFileArtifactIdentity,
  renameFileArtifactIdentitySchema,
  renameFileIdentityMatches,
} from './artifact-identity'
import type {
  ArtifactMutationLease,
  ArtifactMutationLeaseCoordinator,
} from './artifact-mutation-lease'
import {
  FinalizeFsError,
  type FinalizeReservationOwnership,
} from './filesystem-adapter'
import { FinalizeRecovery } from './finalize-recovery'
import { selectRemovalSurvivor } from './finalize-removal-safety'
import {
  assertValidHookPlan,
  type HookPlan,
  isOrdinarySuffixRemoval,
} from './hook-plan'

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
  /** Missing on journals created before the move fast path; treat as copy. */
  publicationMode?: 'copy' | 'move'
  privateTargetPath?: string
  privateTargetIdentity?: ArtifactIdentity
  targetIdentity?: ArtifactIdentity
  rollbackPath?: string
  /** Exact stamp after a verified rollback; ctime changes on every rename. */
  restoredSourceIdentity?: RenameFileArtifactIdentity
  publicationIntent?: FinalizePublicationIntent
  removalIntent?: FinalizeRemovalIntent
  quarantineReason?: string
}

export interface FinalizeLinkIntent {
  /** Written only after the native exclusive link call returns success. */
  confirmed?: true
  version: 1
  method: 'hard_link'
  sourcePath: string
  identity: ArtifactIdentity
}

interface FinalizeReservedRenameBase {
  method: 'reserved_rename'
  confirmed?: never
  sourcePath: string
  identity: FileArtifactIdentity
  reservationIdentity?: FileArtifactIdentity
}

export type FinalizeReservedRenameIntent = FinalizeReservedRenameBase &
  (
    | { version: 2; ownership?: never }
    | { version: 3; ownership: FinalizeReservationOwnership }
  )

export type FinalizePublicationIntent =
  | FinalizeLinkIntent
  | FinalizeReservedRenameIntent

export interface FinalizeIsolation {
  directory: string
  platformFileId: string
}

export interface FinalizeRemovalSurvivor {
  path: string
  identity: ArtifactIdentity
}

export interface FinalizeRemovalIntent {
  isolation?: FinalizeIsolation
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
        | 'publicationMode'
        | 'privateTargetPath'
        | 'privateTargetIdentity'
        | 'targetIdentity'
        | 'rollbackPath'
        | 'restoredSourceIdentity'
        | 'removalIntent'
        | 'publicationIntent'
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
        | 'restoredSourceIdentity'
        | 'quarantineReason'
      >
    >
  ): Promise<void>
  commitTerminal(record: FinalizeJournalRecord): Promise<void>
  quarantine(journalId: string, reason: string): Promise<void>
  listRecoverable(taskId?: string): Promise<FinalizeJournalRecord[]>
  resumeQuarantined?(record: FinalizeJournalRecord): Promise<void>
}

export interface FinalizeArtifactOperations {
  reservedRenameSupported?(): Promise<boolean>
  reservedVolumeIdentity?(directoryPath: string): Promise<string | null>
  publishReserved?(
    sourcePath: string,
    expected: FileArtifactIdentity,
    targetPath: string,
    checkpoint: (reservation: FileArtifactIdentity) => Promise<void>,
    reservation?: FileArtifactIdentity,
    ownership?: FinalizeReservationOwnership
  ): Promise<FileArtifactIdentity>
  /** Validate the actual roots and flush source data before journaled mutation. */
  preflight?(sourcePath: string, targetPath: string): Promise<void>
  renameIdentity?(
    artifactPath: string
  ): Promise<RenameFileArtifactIdentity | null>
  identity(
    artifactPath: string,
    expected?: ArtifactIdentity
  ): Promise<ArtifactIdentity | null>
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
    // biome-ignore lint/suspicious/noConfusingVoidType: Existing filesystem adapters return Promise<void>.
  ): Promise<ArtifactIdentity | void>
  linkNoReplace?(
    sourcePath: string,
    expected: ArtifactIdentity,
    targetPath: string
  ): Promise<void>
  prepareRemoval?(
    artifactPath: string,
    identity: ArtifactIdentity,
    quarantinePath: string
  ): Promise<FinalizeRemovalIntent>
  makeDurable(artifactPath: string): Promise<void>
  removeKnown(
    artifactPath: string,
    expected: ArtifactIdentity,
    quarantinePath: string,
    isolation?: FinalizeIsolation,
    survivor?: FinalizeRemovalSurvivor
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
      publicationMode: 'copy',
    }
    let prepared = false
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
      record.publicationMode = await this.selectPublicationMode(plan)
      await this.options.fs.preflight?.(
        plan.replacement?.stagedPath ?? plan.sourcePath,
        plan.targetPath
      )
      await this.options.repository.prepare(record)
      prepared = true
      return await this.commitPrepared(record, lease)
    } catch (error) {
      if (error instanceof FinalizeQuarantinedError) throw error
      if (prepared) await this.compensate(record, lease, error)
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
    const movesSource = record.publicationMode === 'move'
    let publishedIdentity: ArtifactIdentity | undefined

    if (samePath && !plan.replacement) {
      await this.requireExactIdentity(
        plan.sourcePath,
        plan.sourceIdentity,
        record
      )
      await this.options.fs.makeDurable(plan.sourcePath)
    } else if (movesSource) {
      // moveNoReplace validates the expected source identity while holding the
      // artifact and both roots. Avoid hashing large artifacts once more here.
      try {
        publishedIdentity = await this.publish(
          record,
          plan.sourcePath,
          plan.sourceIdentity,
          plan.targetPath
        )
      } catch (error) {
        // st_dev is only a hint: bind mounts and OverlayFS can return EXDEV
        // even when both paths report the same device. Reconcile the names
        // before durably switching to the existing private-copy protocol.
        if (
          plan.sourceIdentity.kind === 'rename-file' ||
          !(error instanceof FinalizeFsError) ||
          error.code !== 'cross_device' ||
          error.details?.mutation === 'applied' ||
          record.publicationIntent
        )
          throw error
        await this.requireExactIdentity(
          plan.sourcePath,
          plan.sourceIdentity,
          record
        )
        if (await this.options.fs.identity(plan.targetPath)) throw error
        await this.options.repository.checkpoint(record.journalId, {
          publicationMode: 'copy',
        })
        record.publicationMode = 'copy'
        return this.commitPrepared(record, _lease)
      }
      if (plan.sourceIdentity.kind === 'rename-file') {
        if (publishedIdentity?.kind !== 'rename-file')
          throw new Error('native rename omitted the installed file stamp')
        // Persist the observed post-rename ctime before any further operation.
        // A crash before this checkpoint preserves the target but cannot authorize rollback.
        await this.options.repository.checkpoint(record.journalId, {
          targetIdentity: publishedIdentity,
        })
        record.targetIdentity = publishedIdentity
      }
      await this.options.fs.makeDurable(plan.targetPath)
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
      await this.publish(
        record,
        record.privateTargetPath,
        privateIdentity,
        plan.targetPath
      )
      await this.options.fs.makeDurable(plan.targetPath)
    }

    // Compatibility publication returns the actual installed identity: FSKit
    // exFAT may change an empty file's ID while the source descriptor stays open.
    const targetIdentity = movesSource
      ? (publishedIdentity ?? plan.sourceIdentity)
      : await this.requireExactIdentity(
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
      if (
        !samePath &&
        (!movesSource || record.publicationIntent?.method === 'hard_link')
      ) {
        await this.requireExactIdentity(
          plan.sourcePath,
          plan.sourceIdentity,
          record
        )
        await this.removeTracked(record, plan.sourcePath, plan.sourceIdentity)
      }
      if (
        record.publicationIntent?.method === 'hard_link' &&
        record.privateTargetPath
      ) {
        await this.removeTracked(
          record,
          record.privateTargetPath,
          record.publicationIntent.identity
        )
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

  private async publish(
    record: FinalizeJournalRecord,
    sourcePath: string,
    identity: ArtifactIdentity,
    targetPath: string
  ): Promise<ArtifactIdentity | undefined> {
    try {
      return (
        (await this.options.fs.moveNoReplace(
          sourcePath,
          identity,
          targetPath
        )) ?? undefined
      )
    } catch (error) {
      if (
        !(error instanceof FinalizeFsError) ||
        error.code !== 'rename_unsupported' ||
        identity.kind !== 'file'
      )
        throw error
      await this.requireExactIdentity(sourcePath, identity, record)
      if (await this.options.fs.identity(targetPath)) throw error
      if (
        record.publicationMode === 'move' &&
        isOrdinarySuffixRemoval(record.plan) &&
        error.details?.operation === 'rename_opened_no_replace' &&
        (error.details.osError === 45 || error.details.osError === 102) &&
        this.options.fs.publishReserved &&
        this.options.fs.reservedVolumeIdentity &&
        (await this.options.fs.reservedRenameSupported?.())
      ) {
        const volumeId = await this.options.fs.reservedVolumeIdentity(
          path.dirname(sourcePath)
        )
        if (!volumeId) throw error
        const publicationIntent: FinalizeReservedRenameIntent = {
          version: 3,
          ownership: { token: randomBytes(32).toString('hex'), volumeId },
          method: 'reserved_rename',
          sourcePath,
          identity,
        }
        await this.options.repository.checkpoint(record.journalId, {
          publicationIntent,
        })
        record.publicationIntent = publicationIntent
        return publishReserved(record, this.options.fs, this.options.repository)
      }
      if (!this.options.fs.linkNoReplace) throw error
      const publicationIntent: FinalizePublicationIntent = {
        version: 1,
        method: 'hard_link',
        sourcePath,
        identity,
      }
      // Persist before the native call: a lost response can leave both names.
      await this.options.repository.checkpoint(record.journalId, {
        publicationIntent,
      })
      record.publicationIntent = publicationIntent
      await this.options.fs.linkNoReplace(sourcePath, identity, targetPath)
      const confirmed = { ...publicationIntent, confirmed: true as const }
      await this.options.repository.checkpoint(record.journalId, {
        publicationIntent: confirmed,
      })
      record.publicationIntent = confirmed
    }
  }

  private async compensate(
    record: FinalizeJournalRecord,
    lease: ArtifactMutationLease,
    cause: unknown
  ): Promise<void> {
    if (record.phase === 'db_committed' || record.phase === 'cleaned') return
    try {
      // Live rollback and startup recovery must make the same identity checks,
      // and only mark the journal cleaned after the rollback is durable.
      await new FinalizeRecovery({
        ...this.options,
        rollForwardTargetInstalled: false,
      }).recover(record, lease)
    } catch (compensationError) {
      const failures = new AggregateError(
        [cause, compensationError],
        'finalize failed and rollback needs recovery'
      )
      if (compensationError instanceof FinalizeQuarantinedError) {
        throw new FinalizeQuarantinedError(
          record.journalId,
          compensationError.reason,
          {
            cause: failures,
          }
        )
      }
      // I/O and connectivity failures retain the journal's last checkpoint.
      // Recovery rechecks both names; only identity conflicts are quarantined.
      throw failures
    }
  }

  private async selectPublicationMode(
    plan: HookPlan
  ): Promise<'copy' | 'move'> {
    if (
      plan.replacement ||
      finalizePathsEquivalent(plan.sourcePath, plan.targetPath)
    ) {
      return 'copy'
    }
    const sameFilesystem = await this.options.fs.sameFilesystem(
      plan.sourcePath,
      plan.targetPath
    )
    if (!sameFilesystem && plan.sourceIdentity.kind === 'rename-file')
      throw new Error(
        'rename-only identity cannot authorize cross-device copying'
      )
    return sameFilesystem ? 'move' : 'copy'
  }

  private async requireExactIdentity(
    artifactPath: string,
    expected: ArtifactIdentity,
    record: FinalizeJournalRecord
  ): Promise<ArtifactIdentity> {
    const actual = await this.options.fs.identity(artifactPath, expected)
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

/** Persist ownership before replacing a reservation; keep uncertainty recoverable. */
export async function publishReserved(
  record: FinalizeJournalRecord,
  fs: FinalizeArtifactOperations,
  repository: FinalizeJournalRepository
): Promise<FileArtifactIdentity> {
  const intent = record.publicationIntent
  if (intent?.method !== 'reserved_rename' || !fs.publishReserved)
    throw new Error('reserved publication is unsupported')
  const installed = await fs.publishReserved(
    intent.sourcePath,
    intent.identity,
    record.plan.targetPath,
    async (reservationIdentity) => {
      const publicationIntent = { ...intent, reservationIdentity }
      await repository.checkpoint(record.journalId, { publicationIntent })
      record.publicationIntent = publicationIntent
    },
    intent.reservationIdentity,
    intent.ownership
  )
  // Capture a changed file ID before any subsequent host sync can fail.
  await repository.checkpoint(record.journalId, { targetIdentity: installed })
  record.targetIdentity = installed
  return installed
}

export async function prepareRemovalIntent(
  fs: FinalizeArtifactOperations,
  journalId: string,
  artifactPath: string,
  identity: ArtifactIdentity
): Promise<FinalizeRemovalIntent> {
  if (identity.kind === 'rename-file')
    throw new Error('rename-only identity cannot authorize removal')
  const quarantinePath = removalQuarantinePath(journalId, artifactPath)
  return fs.prepareRemoval
    ? fs.prepareRemoval(artifactPath, identity, quarantinePath)
    : { artifactPath, quarantinePath, identity }
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

/** Metadata-only authority never extends to content replacement or removal. */
export function assertRenameFileJournal(record: FinalizeJournalRecord): void {
  const source = record.plan.sourceIdentity
  if (source.kind !== 'rename-file') {
    if (
      record.targetIdentity?.kind === 'rename-file' ||
      record.restoredSourceIdentity ||
      record.privateTargetIdentity?.kind === 'rename-file' ||
      record.removalIntent?.identity.kind === 'rename-file' ||
      record.publicationIntent?.identity.kind === 'rename-file'
    )
      throw new Error('content journal contains rename-only identity')
    return
  }
  renameFileArtifactIdentitySchema.parse(source)
  if (
    !isOrdinarySuffixRemoval(record.plan) ||
    record.publicationMode !== 'move' ||
    record.privateTargetPath !== undefined ||
    record.privateTargetIdentity !== undefined ||
    record.rollbackPath !== undefined ||
    record.publicationIntent !== undefined ||
    record.removalIntent !== undefined ||
    !['prepared', 'target_installed', 'db_committed', 'cleaned'].includes(
      record.phase
    )
  )
    throw new Error('invalid rename-only journal')
  for (const identity of [
    record.targetIdentity,
    record.restoredSourceIdentity,
  ]) {
    if (identity === undefined) continue
    const checked = renameFileArtifactIdentitySchema.parse(identity)
    if (!renameFileIdentityMatches(checked, source))
      throw new Error('rename-only journal changed immutable file metadata')
  }
  if (
    (record.phase === 'target_installed' || record.phase === 'db_committed') &&
    !record.targetIdentity
  )
    throw new Error('rename-only journal is missing its installed stamp')
  if (
    record.restoredSourceIdentity &&
    (!record.targetIdentity || record.phase === 'db_committed')
  )
    throw new Error('rename-only rollback is missing its installed stamp')
}
