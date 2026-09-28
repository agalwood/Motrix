import type { ArtifactIdentity } from './artifact-identity'
import type {
  FinalizeArtifactOperations,
  FinalizeJournalRecord,
  FinalizeRemovalIntent,
  FinalizeRemovalSurvivor,
} from './finalize-committer'
import { finalizePathsEquivalent } from './finalize-committer'

/** A recorded intention cannot establish ownership of a public hard link. */
export function linkPublicationConfirmed(
  record: FinalizeJournalRecord
): boolean {
  return (
    record.publicationIntent?.confirmed === true ||
    record.phase === 'target_installed' ||
    record.phase === 'db_committed'
  )
}

/** Re-evaluate the surviving copy at every destructive entry, including replay. */
export async function selectRemovalSurvivor(
  record: FinalizeJournalRecord,
  intent: Pick<FinalizeRemovalIntent, 'artifactPath' | 'quarantinePath'>,
  fs: FinalizeArtifactOperations,
  exactIdentity: (left: ArtifactIdentity, right: ArtifactIdentity) => boolean
): Promise<FinalizeRemovalSurvivor | string> {
  const removes = (candidate: string) =>
    finalizePathsEquivalent(candidate, intent.artifactPath) ||
    finalizePathsEquivalent(candidate, intent.quarantinePath)
  if (
    record.publicationIntent &&
    removes(record.plan.targetPath) &&
    !linkPublicationConfirmed(record)
  )
    return 'hard-link publication ownership is unconfirmed'

  const committed = record.phase === 'db_committed'
  if (committed && removes(record.plan.targetPath)) {
    return 'removal would delete the committed target'
  }
  const candidates = committed
    ? [
        {
          path: record.plan.targetPath,
          identity:
            record.targetIdentity ??
            record.privateTargetIdentity ??
            record.plan.replacement?.identity ??
            record.plan.sourceIdentity,
        },
      ]
    : [
        { path: record.plan.sourcePath, identity: record.plan.sourceIdentity },
        ...(record.rollbackPath
          ? [
              {
                path: record.rollbackPath,
                identity: record.plan.sourceIdentity,
              },
            ]
          : []),
      ]
  for (const candidate of candidates) {
    if (removes(candidate.path)) continue
    const before = await fs.identity(candidate.path)
    if (!before || !exactIdentity(before, candidate.identity)) continue
    await fs.makeDurable(candidate.path)
    const after = await fs.identity(candidate.path)
    if (after && exactIdentity(after, candidate.identity)) return candidate
  }
  return committed
    ? 'committed target identity mismatch'
    : 'rollback survivor is missing or changed'
}
