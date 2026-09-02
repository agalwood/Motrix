import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type ArtifactIdentity,
  readArtifactIdentity,
} from '@core/plugin/finalize/artifact-identity'
import { ArtifactMutationLeaseCoordinator } from '@core/plugin/finalize/artifact-mutation-lease'
import type { FinalizeArtifactOperations } from '@core/plugin/finalize/finalize-committer'
import { migrate } from '@core/session/migrations'
import { makeDownloadTask, TaskKind, TaskType } from '@shared/types/task'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableFinalizeRuntime } from './durable-finalize-runtime'

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
      sameFilesystem: async () => true,
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
})
