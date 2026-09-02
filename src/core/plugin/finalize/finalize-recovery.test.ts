import { describe, expect, it, vi } from 'vitest'
import {
  type ArtifactIdentity,
  artifactContentEquals,
  artifactIdentityEquals,
} from './artifact-identity'
import { ArtifactMutationLeaseCoordinator } from './artifact-mutation-lease'
import type {
  FinalizeArtifactOperations,
  FinalizeJournalRecord,
  FinalizeJournalRepository,
} from './finalize-committer'
import { finalizePathsEquivalent } from './finalize-committer'
import { FinalizeRecovery } from './finalize-recovery'

const sourceIdentity: ArtifactIdentity = {
  kind: 'file',
  size: 4,
  sha256: 'a'.repeat(64),
  platformFileId: '1:1',
}
const targetIdentity: ArtifactIdentity = {
  ...sourceIdentity,
  platformFileId: '1:2',
}

function record(phase: FinalizeJournalRecord['phase']): FinalizeJournalRecord {
  return {
    journalId: 'journal-1',
    phase,
    plan: {
      planId: 'journal-1',
      taskId: 'task-1',
      saveDir: '/save',
      sourcePath: '/save/source',
      targetPath: '/save/target',
      sourceIdentity,
      metadataOps: [],
      contributors: [],
    },
    targetIdentity,
  }
}

function fixture(
  initial: Record<string, ArtifactIdentity>,
  options: {
    recoverable?: FinalizeJournalRecord[]
    rollForwardTargetInstalled?: boolean
  } = {}
) {
  const artifacts = new Map(Object.entries(initial))
  const phases: string[] = []
  const quarantines: string[] = []
  const repository: FinalizeJournalRepository = {
    prepare: vi.fn(),
    checkpoint: vi.fn(),
    advance: async (_id, phase) => void phases.push(phase),
    commitTerminal: async () => void phases.push('db_committed'),
    quarantine: async (_id, reason) => void quarantines.push(reason),
    listRecoverable: async () => options.recoverable ?? [],
  }
  const fs: FinalizeArtifactOperations = {
    identity: async (artifactPath) => artifacts.get(artifactPath) ?? null,
    sameFilesystem: async () => true,
    materializePrivate: async () => {
      throw new Error('not used')
    },
    moveNoReplace: async (source, _expected, target) => {
      if (artifacts.has(target)) throw new Error('target exists')
      const value = artifacts.get(source)
      if (!value) throw new Error('source missing')
      artifacts.delete(source)
      artifacts.set(target, value)
    },
    makeDurable: async () => {},
    removeKnown: async (artifactPath, expected, quarantinePath) => {
      const original = artifacts.get(artifactPath)
      const quarantined = artifacts.get(quarantinePath)
      if (original && quarantined) throw new Error('both removal names exist')
      const selected = original ?? quarantined
      if (selected && !artifactIdentityEquals(selected, expected)) {
        throw new Error('removal identity mismatch')
      }
      if (original) artifacts.delete(artifactPath)
      if (quarantined) artifacts.delete(quarantinePath)
    },
  }
  const recovery = new FinalizeRecovery({
    repository,
    fs,
    leases: new ArtifactMutationLeaseCoordinator([]),
    exactIdentity: artifactIdentityEquals,
    sameContent: artifactContentEquals,
    rollForwardTargetInstalled: options.rollForwardTargetInstalled,
  })
  return { artifacts, phases, quarantines, recovery }
}

describe('FinalizeRecovery', () => {
  it('finishes the atomic DB transaction from a verified installed target', async () => {
    const state = fixture({
      '/save/source': sourceIdentity,
      '/save/target': targetIdentity,
    })
    await state.recovery.recover(record('target_installed'))
    expect(state.phases).toEqual(['db_committed', 'cleaned'])
    expect(state.artifacts.has('/save/source')).toBe(false)
    expect(state.artifacts.get('/save/target')).toBe(targetIdentity)
  })

  it('quarantines a committed target mismatch without deleting bytes', async () => {
    const unknown = { ...targetIdentity, sha256: 'f'.repeat(64) }
    const state = fixture({ '/save/target': unknown })
    await expect(
      state.recovery.recover(record('db_committed'))
    ).rejects.toThrow('quarantined')
    expect(state.quarantines).toEqual(['committed target identity mismatch'])
    expect(state.artifacts.get('/save/target')).toBe(unknown)
  })

  it('never removes a committed target when source and target are the same path', async () => {
    const committed = record('db_committed')
    committed.plan.sourcePath = '/save/target'
    committed.plan.targetPath = '/save/target'
    committed.targetIdentity = sourceIdentity
    const state = fixture({ '/save/target': sourceIdentity })

    await state.recovery.recover(committed)

    expect(state.artifacts.get('/save/target')).toBe(sourceIdentity)
    expect(state.phases).toEqual(['cleaned'])
  })

  it('restores a preserved same-path source from target_staged', async () => {
    const staged = record('target_staged')
    staged.plan.sourcePath = '/save/target'
    staged.plan.targetPath = '/save/target'
    staged.plan.replacement = {
      pluginId: 'plugin.transcoder',
      stagedPath: '/plugins/staged',
      identity: targetIdentity,
    }
    staged.rollbackPath = '/save/.rollback'
    staged.privateTargetPath = '/save/.private'
    staged.privateTargetIdentity = targetIdentity
    staged.targetIdentity = undefined
    const state = fixture({
      '/save/.rollback': sourceIdentity,
      '/save/.private': targetIdentity,
    })

    await state.recovery.recover(staged)

    expect(state.artifacts.get('/save/target')).toBe(sourceIdentity)
    expect(state.artifacts.has('/save/.rollback')).toBe(false)
    expect(state.artifacts.has('/save/.private')).toBe(false)
    expect(state.phases).toEqual(['cleaned'])
  })

  it('compares Windows paths case-insensitively for recovery cleanup', () => {
    expect(
      finalizePathsEquivalent(
        'C:\\Downloads\\Artifact.bin',
        'c:\\downloads\\artifact.bin',
        'win32'
      )
    ).toBe(true)
  })

  it('restores a source moved before the prepared journal phase advanced', async () => {
    const prepared = record('prepared')
    prepared.rollbackPath = '/save/.rollback'
    prepared.targetIdentity = undefined
    const state = fixture({ '/save/.rollback': sourceIdentity })

    await state.recovery.recover(prepared)

    expect(state.artifacts.get('/save/source')).toBe(sourceIdentity)
    expect(state.artifacts.has('/save/.rollback')).toBe(false)
    expect(state.phases).toEqual(['cleaned'])
  })

  it('rolls back a target moved before target_installed was journaled', async () => {
    const staged = record('target_staged')
    staged.privateTargetPath = '/save/.private'
    staged.privateTargetIdentity = targetIdentity
    staged.targetIdentity = undefined
    const state = fixture({
      '/save/source': sourceIdentity,
      '/save/target': targetIdentity,
    })

    await state.recovery.recover(staged)

    expect(state.artifacts.get('/save/source')).toBe(sourceIdentity)
    expect(state.artifacts.has('/save/target')).toBe(false)
    expect(state.phases).toEqual(['cleaned'])
  })

  it('removes replacement staging during committed cleanup', async () => {
    const committed = record('db_committed')
    committed.plan.replacement = {
      pluginId: 'plugin.transcoder',
      stagedPath: '/plugins/staged',
      identity: targetIdentity,
    }
    const state = fixture({
      '/save/target': targetIdentity,
      '/plugins/staged': targetIdentity,
    })

    await state.recovery.recover(committed)

    expect(state.artifacts.has('/plugins/staged')).toBe(false)
    expect(state.artifacts.get('/save/target')).toBe(targetIdentity)
    expect(state.phases).toEqual(['cleaned'])
  })

  it('preserves a same-path original when uncommitted recovery rolls back', async () => {
    const installed = record('target_installed')
    installed.plan.sourcePath = '/save/target'
    installed.plan.targetPath = '/save/target'
    installed.targetIdentity = sourceIdentity
    const state = fixture(
      { '/save/target': sourceIdentity },
      { rollForwardTargetInstalled: false }
    )

    await state.recovery.recover(installed)

    expect(state.artifacts.get('/save/target')).toBe(sourceIdentity)
    expect(state.phases).toEqual(['cleaned'])
  })

  it('quarantines a changed same-path original during rollback', async () => {
    const installed = record('target_installed')
    installed.plan.sourcePath = '/save/target'
    installed.plan.targetPath = '/save/target'
    installed.targetIdentity = sourceIdentity
    const unknown = { ...sourceIdentity, sha256: 'f'.repeat(64) }
    const state = fixture(
      { '/save/target': unknown },
      { rollForwardTargetInstalled: false }
    )

    await expect(state.recovery.recover(installed)).rejects.toThrow(
      'quarantined'
    )

    expect(state.artifacts.get('/save/target')).toBe(unknown)
    expect(state.quarantines).toEqual([
      'same-path original changed during recovery',
    ])
  })

  it('isolates a quarantined journal and continues recovering later rows', async () => {
    const corrupted = record('db_committed')
    const later = record('prepared')
    later.journalId = 'journal-2'
    later.plan = {
      ...later.plan,
      planId: 'journal-2',
      taskId: 'task-2',
      sourcePath: '/save/source-2',
      targetPath: '/save/target-2',
    }
    later.targetIdentity = undefined
    const unknown = { ...targetIdentity, sha256: 'f'.repeat(64) }
    const state = fixture(
      {
        '/save/target': unknown,
        '/save/source-2': sourceIdentity,
      },
      { recoverable: [corrupted, later] }
    )

    await state.recovery.recoverAll()

    expect(state.quarantines).toEqual(['committed target identity mismatch'])
    expect(state.phases).toEqual(['cleaned'])
  })

  it('resumes an exact persisted removal quarantine after a crash', async () => {
    const committed = record('db_committed')
    committed.removalIntent = {
      artifactPath: '/save/source',
      quarantinePath: '/save/.motrix-finalize-remove-persisted',
      identity: sourceIdentity,
    }
    const state = fixture({
      '/save/target': targetIdentity,
      '/save/.motrix-finalize-remove-persisted': sourceIdentity,
    })

    await state.recovery.recover(committed)

    expect(state.artifacts.has('/save/.motrix-finalize-remove-persisted')).toBe(
      false
    )
    expect(committed.removalIntent).toBeUndefined()
    expect(state.phases).toEqual(['cleaned'])
  })

  it('preserves and quarantines an unknown persisted removal object', async () => {
    const committed = record('db_committed')
    committed.removalIntent = {
      artifactPath: '/save/source',
      quarantinePath: '/save/.motrix-finalize-remove-persisted',
      identity: sourceIdentity,
    }
    const unknown = { ...sourceIdentity, sha256: 'f'.repeat(64) }
    const state = fixture({
      '/save/target': targetIdentity,
      '/save/.motrix-finalize-remove-persisted': unknown,
    })

    await expect(state.recovery.recover(committed)).rejects.toThrow(
      'quarantined'
    )

    expect(state.artifacts.get('/save/.motrix-finalize-remove-persisted')).toBe(
      unknown
    )
    expect(state.quarantines[0]).toContain('persisted removal intent failed')
  })
})
