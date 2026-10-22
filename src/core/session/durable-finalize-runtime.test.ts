import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type ArtifactIdentity,
  type RenameFileArtifactIdentity,
  readArtifactIdentity,
} from '@core/plugin/finalize/artifact-identity'
import { ArtifactMutationLeaseCoordinator } from '@core/plugin/finalize/artifact-mutation-lease'
import type { FinalizeArtifactOperations } from '@core/plugin/finalize/finalize-committer'
import { migrate } from '@core/session/migrations'
import { TaskKind, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableFinalizeRuntime } from './durable-finalize-runtime'

const renameIdentity: RenameFileArtifactIdentity = {
  kind: 'rename-file',
  size: 1024 * 1024 * 1024,
  platformFileId: '1:1',
  mtimeNs: '100',
  ctimeNs: '200',
  birthtimeNs: '50',
}

describe('DurableFinalizeRuntime', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    )
  })

  it('quiesces writers before the first source identity is captured', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-lease-order-'))
    roots.push(root)
    const sourcePath = path.join(root, 'source.part')
    const targetPath = path.join(root, 'target.bin')
    await writeFile(sourcePath, 'before-quiesce')
    const expectedSha = createHash('sha256')
      .update('after-quiesce')
      .digest('hex')
    const events: string[] = []
    let selectedIdentity: ArtifactIdentity | undefined
    const db = new Database(':memory:')
    migrate(db)

    const fs = {
      identity: async (artifactPath: string) =>
        artifactPath === sourcePath ? readArtifactIdentity(artifactPath) : null,
      sameFilesystem: async () => false,
      materializePrivate: async (
        _source: string,
        identity: ArtifactIdentity
      ) => {
        events.push('materialize')
        selectedIdentity = identity
        throw new Error('stop after identity proof')
      },
      makeDurable: async () => undefined,
      moveNoReplace: async () => undefined,
      removeKnown: async () => undefined,
    } satisfies FinalizeArtifactOperations
    const runtime = new DurableFinalizeRuntime({
      db,
      session: {
        persistFinalizedArtifact: async (_task, _occurrence, _input, commit) =>
          commit(() => undefined),
      },
      fs,
      leases: new ArtifactMutationLeaseCoordinator([
        {
          quiesce: async () => {
            events.push('quiesce')
            await writeFile(sourcePath, 'after-quiesce')
            return () => {
              events.push('release')
            }
          },
        },
      ]),
    })

    await expect(
      runtime.commit({
        task: makeDownloadTask({
          id: 'task-lease-order',
          name: 'target.bin',
          type: TaskType.Http,
          kind: TaskKind.Direct,
          saveDir: root,
          filename: 'target.bin',
          finalName: 'target.bin',
          diskPath: sourcePath,
          finalPath: targetPath,
          source: 'user',
          sourceMeta: null,
          instances: [],
          createdAt: 1,
          updatedAt: 1,
        }),
        occurrence: null,
        sourcePath,
        targetPath,
        metadataOps: [],
        contributors: [],
        postDeliveries: [],
      })
    ).rejects.toThrow('stop after identity proof')

    expect(selectedIdentity).toMatchObject({
      kind: 'file',
      sha256: expectedSha,
    })
    expect(events).toEqual(['quiesce', 'materialize', 'release'])
    db.close()
  })

  it('rejects revocation while preparing identities before any output mutation', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'motrix-revoked-finalize-')
    )
    roots.push(root)
    const sourcePath = path.join(root, 'source.part')
    const targetPath = path.join(root, 'target.bin')
    await writeFile(sourcePath, 'original')
    const db = new Database(':memory:')
    migrate(db)
    let revoked = false
    const fs = {
      identity: async (artifactPath: string) => {
        const identity = await readArtifactIdentity(artifactPath)
        revoked = true
        return identity
      },
      sameFilesystem: vi.fn(),
      materializePrivate: vi.fn(),
      makeDurable: vi.fn(),
      moveNoReplace: vi.fn(),
      removeKnown: vi.fn(),
    } satisfies FinalizeArtifactOperations
    const commitDatabase = vi.fn()
    const runtime = new DurableFinalizeRuntime({
      db,
      fs,
      session: {
        persistFinalizedArtifact: async (_task, _occurrence, _input, commit) =>
          commit(commitDatabase),
      },
    })
    try {
      await expect(
        runtime.commit({
          task: makeDownloadTask({ id: 'revoked', saveDir: root }),
          occurrence: null,
          sourcePath,
          targetPath,
          metadataOps: [],
          contributors: ['example.test'],
          postDeliveries: [],
          beforeCommit: () => {
            if (revoked) throw new Error('security revoked')
          },
        })
      ).rejects.toThrow('security revoked')
      expect(fs.materializePrivate).not.toHaveBeenCalled()
      expect(fs.moveNoReplace).not.toHaveBeenCalled()
      expect(commitDatabase).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('selects metadata after quiescing writers and persists the installed rename stamp', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-rename-only-'))
    roots.push(root)
    const targetPath = path.join(root, 'archive.zip')
    const sourcePath = `${targetPath}.motrix`
    const installedIdentity = { ...renameIdentity, ctimeNs: '300' }
    const artifacts = new Map<string, ArtifactIdentity>([
      [sourcePath, renameIdentity],
    ])
    const events: string[] = []
    const fs = {
      renameIdentity: vi.fn(async () => {
        events.push('capture')
        return renameIdentity
      }),
      identity: vi.fn(
        async (artifactPath: string, expected?: ArtifactIdentity) => {
          expect(expected?.kind).toBe('rename-file')
          return artifacts.get(artifactPath) ?? null
        }
      ),
      sameFilesystem: async () => true,
      materializePrivate: vi.fn(),
      moveNoReplace: vi.fn(
        async (
          _source: string,
          _expected: ArtifactIdentity,
          target: string
        ) => {
          artifacts.delete(sourcePath)
          artifacts.set(target, installedIdentity)
          return installedIdentity
        }
      ),
      makeDurable: vi.fn(async () => undefined),
      removeKnown: vi.fn(),
    } satisfies FinalizeArtifactOperations
    const db = new Database(':memory:')
    migrate(db)
    const runtime = new DurableFinalizeRuntime({
      db,
      fs,
      leases: new ArtifactMutationLeaseCoordinator([
        {
          quiesce: async () => {
            events.push('quiesce')
            return () => {
              events.push('release')
            }
          },
        },
      ]),
      session: {
        persistFinalizedArtifact: async (_task, _occurrence, _input, commit) =>
          commit((mutation) => {
            db.prepare(
              "UPDATE plugin_finalize_journals SET phase='db_committed', plan_json=json_set(plan_json, '$.phase', 'db_committed') WHERE plan_id=?"
            ).run(mutation.journalId)
          }),
      },
    })
    try {
      const result = await runtime.commit({
        task: makeDownloadTask({ id: 'rename-only', saveDir: root }),
        occurrence: null,
        sourcePath,
        targetPath,
        metadataOps: [],
        contributors: [],
        postDeliveries: [],
      })
      expect(result.targetIdentity).toEqual(installedIdentity)
      expect(events).toEqual(['quiesce', 'capture', 'release'])
      expect(fs.renameIdentity).toHaveBeenCalledExactlyOnceWith(sourcePath)
      expect(fs.materializePrivate).not.toHaveBeenCalled()
      expect(fs.removeKnown).not.toHaveBeenCalled()
      expect(
        db
          .prepare(
            'SELECT phase, target_identity_json FROM plugin_finalize_journals'
          )
          .get()
      ).toEqual({
        phase: 'cleaned',
        target_identity_json: JSON.stringify(installedIdentity),
      })
    } finally {
      db.close()
    }
  })

  it.each([
    'unsupported',
    'nonordinary-name',
    'plugin',
    'metadata',
    'replacement',
  ] as const)(
    'retains content identities for %s finalization',
    async (scenario) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-rename-scope-'))
      roots.push(root)
      const targetPath = path.join(root, 'archive.zip')
      const sourcePath =
        scenario === 'nonordinary-name'
          ? `${targetPath}.part`
          : `${targetPath}.motrix`
      const fullIdentity: ArtifactIdentity = {
        kind: 'file',
        size: 4,
        platformFileId: '1:1',
        sha256: 'a'.repeat(64),
      }
      const fs = {
        renameIdentity: vi.fn(async () =>
          scenario === 'unsupported' ? null : renameIdentity
        ),
        identity: vi.fn(async () => fullIdentity),
        sameFilesystem: vi.fn(),
        materializePrivate: vi.fn(),
        moveNoReplace: vi.fn(),
        makeDurable: vi.fn(),
        removeKnown: vi.fn(),
      } satisfies FinalizeArtifactOperations
      const db = new Database(':memory:')
      migrate(db)
      const runtime = new DurableFinalizeRuntime({
        db,
        fs,
        session: {
          persistFinalizedArtifact: async () => {
            throw new Error('captured content identity')
          },
        },
      })
      try {
        await expect(
          runtime.commit({
            task: makeDownloadTask({ id: `scope-${scenario}`, saveDir: root }),
            occurrence: null,
            sourcePath,
            targetPath,
            metadataOps:
              scenario === 'metadata'
                ? [
                    {
                      pluginId: 'example.test',
                      op: 'set',
                      key: 'note',
                      value: 'value',
                    },
                  ]
                : [],
            contributors: scenario === 'plugin' ? ['example.test'] : [],
            replacement:
              scenario === 'replacement'
                ? {
                    pluginId: 'example.test',
                    stagedPath: path.join(root, 'replacement'),
                  }
                : undefined,
            postDeliveries: [],
          })
        ).rejects.toThrow('captured content identity')
        expect(fs.renameIdentity).toHaveBeenCalledTimes(
          scenario === 'unsupported' ? 1 : 0
        )
        expect(fs.identity).toHaveBeenCalledWith(sourcePath)
        expect(fs.moveNoReplace).not.toHaveBeenCalled()
      } finally {
        db.close()
      }
    }
  )
})

it('rejects an invalid target before acquiring leases or reading file identities', async () => {
  const db = new Database(':memory:')
  try {
    const fs = { identity: vi.fn() } as unknown as FinalizeArtifactOperations
    const quiesce = vi.fn(async () => () => {})
    const runtime = new DurableFinalizeRuntime({
      db,
      fs,
      session: { persistFinalizedArtifact: vi.fn() },
      leases: new ArtifactMutationLeaseCoordinator([{ quiesce }]),
    })
    await expect(
      runtime.commit({
        task: makeDownloadTask({ id: 'invalid', saveDir: '/save' }),
        occurrence: null,
        sourcePath: '/save/temp',
        targetPath: '/save',
        metadataOps: [],
        contributors: [],
        postDeliveries: [],
      })
    ).rejects.toThrow('descendant')
    expect(fs.identity).not.toHaveBeenCalled()
    expect(quiesce).not.toHaveBeenCalled()
  } finally {
    db.close()
  }
})

it('sanitizes a cross-platform hostile final name before planning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-sanitize-'))
  try {
    const sourcePath = path.join(root, 'source.part')
    await writeFile(sourcePath, 'payload')
    // Windows reserved stem with trailing space: publishable nowhere as-is.
    const requestedTarget = path.join(root, 'CON.txt ')
    const sanitizedTarget = path.join(root, 'CON_.txt')
    const sourceIdentity = await readArtifactIdentity(sourcePath)
    const moved: string[] = []
    const db = new Database(':memory:')
    migrate(db)
    let rebaseTargetRoot: string | undefined
    const fs = {
      identity: async (artifactPath: string) =>
        artifactPath === sanitizedTarget || artifactPath === sourcePath
          ? sourceIdentity
          : null,
      sameFilesystem: async () => true,
      materializePrivate: async () => sourceIdentity,
      moveNoReplace: async (
        _source: string,
        _expected: ArtifactIdentity,
        targetPath: string
      ) => {
        moved.push(targetPath)
        await writeFile(targetPath, 'payload')
      },
      makeDurable: async () => undefined,
      removeKnown: async () => undefined,
    } satisfies FinalizeArtifactOperations
    const runtime = new DurableFinalizeRuntime({
      db,
      session: {
        persistFinalizedArtifact: async (_task, _occurrence, input, commit) => {
          rebaseTargetRoot = input.fileRebase?.targetRoot
          return commit((mutation) => {
            db.prepare(
              `UPDATE plugin_finalize_journals SET phase='db_committed',
             updated_at=? WHERE plan_id=? AND phase='target_installed'`
            ).run(mutation.updatedAt, mutation.journalId)
          })
        },
      },
      fs,
    })

    const result = await runtime.commit({
      task: makeDownloadTask({
        id: 'task-sanitize',
        name: 'CON.txt ',
        type: TaskType.Http,
        kind: TaskKind.Direct,
        saveDir: root,
        filename: 'CON.txt ',
        finalName: 'CON.txt ',
        diskPath: sourcePath,
        finalPath: requestedTarget,
        source: 'user',
        sourceMeta: null,
        instances: [],
        createdAt: 1,
        updatedAt: 1,
      }),
      occurrence: null,
      sourcePath,
      targetPath: requestedTarget,
      metadataOps: [],
      contributors: [],
      postDeliveries: [],
      fileRebase: { sourceRoot: sourcePath, targetRoot: requestedTarget },
    })

    expect(moved).toEqual([sanitizedTarget])
    expect(result.targetPath).toBe(sanitizedTarget)
    expect(rebaseTargetRoot).toBe(sanitizedTarget)
    db.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
