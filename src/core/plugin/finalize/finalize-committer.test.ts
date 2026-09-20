import { describe, expect, it, vi } from 'vitest'
import {
  type ArtifactIdentity,
  artifactContentEquals,
  artifactIdentityEquals,
} from './artifact-identity'
import { ArtifactMutationLeaseCoordinator } from './artifact-mutation-lease'
import { FinalizeFsError } from './filesystem-adapter'
import {
  type FinalizeArtifactOperations,
  FinalizeCommitter,
  type FinalizeJournalPhase,
  type FinalizeJournalRecord,
  type FinalizeJournalRepository,
} from './finalize-committer'
import type { HookPlan } from './hook-plan'

const sourceIdentity: ArtifactIdentity = {
  kind: 'file',
  size: 6,
  sha256: 'a'.repeat(64),
  platformFileId: '1:1',
}
const replacementIdentity: ArtifactIdentity = {
  kind: 'file',
  size: 11,
  sha256: 'b'.repeat(64),
  platformFileId: '1:2',
}

function makePlan(replacement = false): HookPlan {
  return {
    planId: 'plan-1',
    taskId: 'task-1',
    saveDir: '/save',
    sourcePath: '/save/source.motrix',
    targetPath: '/save/final.bin',
    sourceIdentity,
    replacement: replacement
      ? {
          pluginId: 'plugin.transcoder',
          stagedPath: '/plugins/plugin.transcoder/staging/task-1/final.bin',
          identity: replacementIdentity,
        }
      : undefined,
    metadataOps: [],
    contributors: replacement ? ['plugin.transcoder'] : [],
  }
}

class FakeFilesystem implements FinalizeArtifactOperations {
  readonly artifacts = new Map<string, ArtifactIdentity>()
  readonly actions: string[] = []
  readonly identityReads = new Map<string, number>()

  constructor(private readonly sameDevice = true) {}

  async identity(artifactPath: string): Promise<ArtifactIdentity | null> {
    this.identityReads.set(
      artifactPath,
      (this.identityReads.get(artifactPath) ?? 0) + 1
    )
    return this.artifacts.get(artifactPath) ?? null
  }
  async sameFilesystem(): Promise<boolean> {
    return this.sameDevice
  }
  async materializePrivate(
    sourcePath: string,
    expected: ArtifactIdentity,
    privateTargetPath: string
  ): Promise<ArtifactIdentity> {
    this.actions.push(`copy:${sourcePath}->${privateTargetPath}`)
    if (this.artifacts.has(privateTargetPath)) throw new Error('target exists')
    const copy = {
      ...expected,
      platformFileId: `copy:${expected.platformFileId}`,
    }
    this.artifacts.set(privateTargetPath, copy)
    return copy
  }
  async moveNoReplace(
    sourcePath: string,
    _expected: ArtifactIdentity,
    targetPath: string
  ): Promise<void> {
    this.actions.push(`move:${sourcePath}->${targetPath}`)
    if (this.artifacts.has(targetPath)) throw new Error('target exists')
    const value = this.artifacts.get(sourcePath)
    if (!value) throw new Error('source missing')
    this.artifacts.delete(sourcePath)
    this.artifacts.set(targetPath, value)
  }
  async makeDurable(artifactPath: string): Promise<void> {
    this.actions.push(`durable:${artifactPath}`)
  }
  async removeKnown(
    artifactPath: string,
    _expected: ArtifactIdentity
  ): Promise<void> {
    this.actions.push(`remove:${artifactPath}`)
    this.artifacts.delete(artifactPath)
  }
}

function makeRepository(commitError?: Error): {
  repository: FinalizeJournalRepository
  phases: FinalizeJournalPhase[]
  quarantines: string[]
} {
  const phases: FinalizeJournalPhase[] = []
  const quarantines: string[] = []
  return {
    phases,
    quarantines,
    repository: {
      prepare: async () => void phases.push('prepared'),
      checkpoint: async () => undefined,
      advance: async (_id, phase) => void phases.push(phase),
      commitTerminal: async () => {
        if (commitError) throw commitError
        phases.push('db_committed')
      },
      quarantine: async (_id, reason) => void quarantines.push(reason),
      listRecoverable: async (): Promise<FinalizeJournalRecord[]> => [],
    },
  }
}

function makeCommitter(
  fs: FakeFilesystem,
  repository: FinalizeJournalRepository
): FinalizeCommitter {
  return new FinalizeCommitter({
    fs,
    repository,
    leases: new ArtifactMutationLeaseCoordinator([]),
    privatePathFor: () => '/save/.motrix-private-plan-1',
    rollbackPathFor: () => '/save/.motrix-rollback-plan-1',
    exactIdentity: artifactIdentityEquals,
    sameContent: artifactContentEquals,
  })
}

describe('FinalizeCommitter', () => {
  it('does not compensate a different journal when prepare rejects the retry', async () => {
    const fs = new FakeFilesystem()
    const plan = makePlan()
    fs.artifacts.set(plan.sourcePath, sourceIdentity)
    fs.artifacts.set(plan.targetPath, sourceIdentity)
    const { repository } = makeRepository()
    repository.prepare = vi
      .fn()
      .mockRejectedValue(new Error('old journal still pending'))
    await expect(makeCommitter(fs, repository).commit(plan)).rejects.toThrow(
      'old journal still pending'
    )
    expect(fs.actions).toEqual([])
    expect(fs.artifacts.get(plan.targetPath)).toBe(sourceIdentity)
    expect(fs.artifacts.get(plan.sourcePath)).toBe(sourceIdentity)
  })

  it('moves an ordinary same-filesystem source without copying it', async () => {
    const fs = new FakeFilesystem()
    const plan = makePlan()
    fs.artifacts.set(plan.sourcePath, sourceIdentity)
    const { repository, phases } = makeRepository()

    await makeCommitter(fs, repository).commit(plan)

    expect(fs.artifacts.has(plan.sourcePath)).toBe(false)
    expect(fs.artifacts.get(plan.targetPath)).toBe(sourceIdentity)
    expect(fs.actions).toContain(`move:${plan.sourcePath}->${plan.targetPath}`)
    expect(fs.actions.some((action) => action.startsWith('copy:'))).toBe(false)
    expect(fs.identityReads.get(plan.sourcePath)).toBe(1)
    expect(fs.identityReads.get(plan.targetPath)).toBe(1)
    expect(phases).toEqual([
      'prepared',
      'target_installed',
      'db_committed',
      'cleaned',
    ])
  })

  it('falls back to verified copy publication across filesystems', async () => {
    const fs = new FakeFilesystem(false)
    const plan = makePlan()
    fs.artifacts.set(plan.sourcePath, sourceIdentity)
    const { repository, phases } = makeRepository()

    await makeCommitter(fs, repository).commit(plan)

    expect(fs.actions).toContain(
      `copy:${plan.sourcePath}->/save/.motrix-private-plan-1`
    )
    expect(fs.artifacts.has(plan.sourcePath)).toBe(false)
    expect(fs.artifacts.get(plan.targetPath)).toMatchObject({
      sha256: sourceIdentity.sha256,
    })
    expect(phases).toEqual([
      'prepared',
      'target_staged',
      'target_installed',
      'db_committed',
      'cleaned',
    ])
  })

  it('installs a replacement and never renames the original over it', async () => {
    const fs = new FakeFilesystem()
    const plan = makePlan(true)
    fs.artifacts.set(plan.sourcePath, sourceIdentity)
    fs.artifacts.set(plan.replacement?.stagedPath ?? '', replacementIdentity)
    const { repository, phases } = makeRepository()
    await makeCommitter(fs, repository).commit(plan)
    expect(fs.artifacts.get(plan.targetPath)).toMatchObject({
      sha256: replacementIdentity.sha256,
    })
    expect(fs.artifacts.has(plan.sourcePath)).toBe(false)
    expect(fs.artifacts.has(plan.replacement?.stagedPath ?? '')).toBe(false)
    expect(fs.actions).not.toContain(
      `move:${plan.sourcePath}->${plan.targetPath}`
    )
    expect(phases).toEqual([
      'prepared',
      'target_staged',
      'target_installed',
      'db_committed',
      'cleaned',
    ])
  })

  it('does not overwrite a target that appears before install', async () => {
    const fs = new FakeFilesystem()
    const plan = makePlan()
    fs.artifacts.set(plan.sourcePath, sourceIdentity)
    const unrelated: ArtifactIdentity = {
      ...sourceIdentity,
      sha256: 'f'.repeat(64),
      platformFileId: '1:99',
    }
    fs.artifacts.set(plan.targetPath, unrelated)
    const { repository } = makeRepository()
    await expect(makeCommitter(fs, repository).commit(plan)).rejects.toThrow(
      'quarantined'
    )
    expect(fs.artifacts.get(plan.targetPath)).toBe(unrelated)
    expect(fs.artifacts.get(plan.sourcePath)).toBe(sourceIdentity)
  })

  it('compensates an installed target when the atomic database commit fails', async () => {
    const fs = new FakeFilesystem()
    const plan = makePlan()
    fs.artifacts.set(plan.sourcePath, sourceIdentity)
    const { repository } = makeRepository(new Error('db unavailable'))
    await expect(makeCommitter(fs, repository).commit(plan)).rejects.toThrow(
      'db unavailable'
    )
    expect(fs.artifacts.has(plan.targetPath)).toBe(false)
    expect(fs.artifacts.get(plan.sourcePath)).toBe(sourceIdentity)
    expect(fs.actions).toContain(`move:${plan.targetPath}->${plan.sourcePath}`)
    expect(fs.actions.some((action) => action.startsWith('copy:'))).toBe(false)
  })

  it('quarantines an identity mismatch without deleting unknown bytes', async () => {
    const fs = new FakeFilesystem()
    const plan = makePlan()
    fs.artifacts.set(plan.sourcePath, {
      ...sourceIdentity,
      sha256: 'c'.repeat(64),
    })
    const { repository, quarantines } = makeRepository()
    await expect(makeCommitter(fs, repository).commit(plan)).rejects.toThrow(
      'quarantined'
    )
    expect(quarantines).toHaveLength(1)
    expect(fs.actions.some((action) => action.startsWith('remove:'))).toBe(
      false
    )
  })

  it('does not release the lease until cleanup finishes', async () => {
    const resume = vi.fn()
    const fs = new FakeFilesystem()
    const plan = makePlan()
    fs.artifacts.set(plan.sourcePath, sourceIdentity)
    const { repository } = makeRepository()
    const leases = new ArtifactMutationLeaseCoordinator([
      { quiesce: async () => resume },
    ])
    const committer = new FinalizeCommitter({
      fs,
      repository,
      leases,
      privatePathFor: () => '/save/.private',
      rollbackPathFor: () => '/save/.rollback',
      exactIdentity: artifactIdentityEquals,
      sameContent: artifactContentEquals,
    })
    await committer.commit(plan)
    expect(resume).toHaveBeenCalledOnce()
    expect(leases.isHeld(plan.taskId)).toBe(false)
  })
})

describe('hard-link publication', () => {
  async function linked(sameDevice = true, commitError?: Error) {
    const fs = new FakeFilesystem(sameDevice)
    const plan = makePlan()
    fs.artifacts.set(plan.sourcePath, sourceIdentity)
    const state = makeRepository(commitError)
    const checkpoints: unknown[] = []
    state.repository.checkpoint = async (_id, patch) => {
      checkpoints.push(structuredClone(patch))
    }
    vi.spyOn(fs, 'moveNoReplace').mockRejectedValue(
      new FinalizeFsError('rename_unsupported', 'NFS rejects NOREPLACE')
    )
    const linkNoReplace = vi.fn(
      async (source: string, expected: ArtifactIdentity, target: string) => {
        expect(checkpoints.at(-1)).toEqual({
          publicationIntent: {
            version: 1,
            method: 'hard_link',
            sourcePath: source,
            identity: expected,
          },
        })
        if (fs.artifacts.has(target)) throw new Error('target exists')
        fs.artifacts.set(target, fs.artifacts.get(source)!)
      }
    )
    const operations = Object.assign(fs, { linkNoReplace })
    return { fs, plan, state, operations, linkNoReplace }
  }

  it.each([true, false])(
    'publishes without overwriting and cleans both staging and source (same device: %s)',
    async (sameDevice) => {
      const { fs, plan, state, operations, linkNoReplace } =
        await linked(sameDevice)
      state.repository.commitTerminal = async () => {
        expect(fs.artifacts.has(plan.sourcePath)).toBe(true)
        expect(fs.artifacts.has(plan.targetPath)).toBe(true)
      }
      await makeCommitter(operations, state.repository).commit(plan)
      expect(linkNoReplace).toHaveBeenCalledOnce()
      expect([...fs.artifacts.keys()]).toEqual([plan.targetPath])
      expect(state.quarantines).toEqual([])
    }
  )

  it('rolls back a link whose response was lost', async () => {
    const { fs, plan, state, operations, linkNoReplace } = await linked()
    const link = linkNoReplace.getMockImplementation()!
    linkNoReplace.mockImplementation(async (...args) => {
      await link(...args)
      throw new Error('lost response')
    })
    await expect(
      makeCommitter(operations, state.repository).commit(plan)
    ).rejects.toThrow('lost response')
    expect([...fs.artifacts.keys()]).toEqual([plan.sourcePath])
    expect(state.quarantines).toEqual([])
    expect(state.phases.at(-1)).toBe('cleaned')
  })

  it('preserves the source when the DB commit fails', async () => {
    const { fs, plan, state, operations } = await linked(
      true,
      new Error('DB unavailable')
    )
    await expect(
      makeCommitter(operations, state.repository).commit(plan)
    ).rejects.toThrow('DB unavailable')
    expect([...fs.artifacts.keys()]).toEqual([plan.sourcePath])
    expect(state.quarantines).toEqual([])
  })

  it('preserves the source if the target is replaced during DB commit', async () => {
    const { fs, plan, state, operations } = await linked()
    state.repository.commitTerminal = async () => {
      fs.artifacts.set(plan.targetPath, replacementIdentity)
    }
    await expect(
      makeCommitter(operations, state.repository).commit(plan)
    ).resolves.toMatchObject({ cleanupPending: true })
    expect(fs.artifacts.get(plan.sourcePath)).toBe(sourceIdentity)
    expect(fs.artifacts.get(plan.targetPath)).toBe(replacementIdentity)
    expect(state.quarantines).toHaveLength(1)
  })

  it('keeps the completed target when cleanup fails', async () => {
    const { fs, plan, state, operations } = await linked()
    vi.spyOn(fs, 'removeKnown').mockRejectedValue(new Error('offline'))
    await expect(
      makeCommitter(operations, state.repository).commit(plan)
    ).resolves.toMatchObject({ cleanupPending: true })
    expect(fs.artifacts.has(plan.targetPath)).toBe(true)
    expect(state.phases.at(-1)).toBe('db_committed')
  })

  it.each([
    'permission_denied',
    'io_error',
    'invalid_path',
    'target_exists',
  ] as const)('does not fall back for %s', async (code) => {
    const { fs, plan, state, operations, linkNoReplace } = await linked()
    vi.mocked(fs.moveNoReplace).mockRejectedValue(
      new FinalizeFsError(code, code)
    )
    await expect(
      makeCommitter(operations, state.repository).commit(plan)
    ).rejects.toThrow(code)
    expect(linkNoReplace).not.toHaveBeenCalled()
    expect(fs.artifacts.has(plan.sourcePath)).toBe(true)
  })
})
