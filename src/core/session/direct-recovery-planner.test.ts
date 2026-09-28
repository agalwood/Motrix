import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createEngineCheckpointProbe,
  type DirectRecoveryFileStat,
  DirectRecoveryPlanner,
} from './direct-recovery-planner'

function makeFileSystem(
  entries: Readonly<Record<string, DirectRecoveryFileStat | undefined>>,
  rejectedPaths: readonly string[] = []
) {
  return {
    async stat(filePath: string) {
      if (rejectedPaths.includes(filePath)) throw new Error('probe failed')
      return entries[filePath] ?? null
    },
  }
}

const file = (size: number): DirectRecoveryFileStat => ({
  size,
  isFile: true,
})

const directory: DirectRecoveryFileStat = { size: 0, isFile: false }

describe('DirectRecoveryPlanner', () => {
  it('derives a POSIX output directory and keeps the incomplete filename', async () => {
    const diskPath = '/downloads/linux.iso.motrix'
    const planner = new DirectRecoveryPlanner(
      makeFileSystem({
        [diskPath]: file(8192),
        [`${diskPath}.aria2`]: file(128),
      }),
      path.posix
    )

    await expect(
      planner.plan({
        primary: { diskPath },
        finalPath: '/downloads/linux.iso',
      })
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      reason: 'checkpoint-present',
      diskPath,
      saveDir: '/downloads',
      filename: 'linux.iso.motrix',
      checkpointPath: '/downloads/linux.iso.motrix.aria2',
      bytesBefore: 8192,
      diskPathSource: 'primary',
    })
  })

  it('derives a Windows output directory with win32 path semantics', async () => {
    const diskPath = 'C:\\Downloads\\linux.iso.motrix'
    const planner = new DirectRecoveryPlanner(
      makeFileSystem({
        [diskPath]: file(4096),
        [`${diskPath}.aria2`]: file(64),
      }),
      path.win32
    )

    await expect(
      planner.plan({ primary: { diskPath } })
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      diskPath,
      saveDir: 'C:\\Downloads',
      filename: 'linux.iso.motrix',
      bytesBefore: 4096,
    })
  })

  it('conservatively derives the incomplete path from finalPath', async () => {
    const diskPath = '/downloads/archive.zip.motrix'
    const planner = new DirectRecoveryPlanner(
      makeFileSystem({ [diskPath]: file(0) }),
      path.posix
    )

    await expect(
      planner.plan({ finalPath: '/downloads/archive.zip' })
    ).resolves.toMatchObject({
      kind: 'fresh',
      reason: 'temp-file-empty',
      diskPath,
      saveDir: '/downloads',
      filename: 'archive.zip.motrix',
      diskPathSource: 'final-path',
    })
  })

  it('marks a missing temporary file as fresh', async () => {
    const planner = new DirectRecoveryPlanner(makeFileSystem({}), path.posix)

    await expect(
      planner.plan({ primary: { diskPath: '/downloads/file.motrix' } })
    ).resolves.toMatchObject({
      kind: 'fresh',
      reason: 'temp-file-missing',
      bytesBefore: 0,
    })
  })

  it('marks an empty temporary file as fresh even if a stale checkpoint exists', async () => {
    const diskPath = '/downloads/file.motrix'
    const planner = new DirectRecoveryPlanner(
      makeFileSystem({
        [diskPath]: file(0),
        [`${diskPath}.aria2`]: file(128),
      }),
      path.posix
    )

    await expect(
      planner.plan({ primary: { diskPath } })
    ).resolves.toMatchObject({
      kind: 'fresh',
      reason: 'temp-file-empty',
      bytesBefore: 0,
    })
  })

  it('blocks a non-empty partial file without an aria2 checkpoint', async () => {
    const diskPath = '/downloads/file.motrix'
    const planner = new DirectRecoveryPlanner(
      makeFileSystem({ [diskPath]: file(1024) }),
      path.posix
    )

    await expect(
      planner.plan({ primary: { diskPath } })
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'checkpoint-missing',
      bytesBefore: 1024,
    })
  })

  it('detects a completed final file when the temporary file is gone', async () => {
    const finalPath = '/downloads/file.bin'
    const planner = new DirectRecoveryPlanner(
      makeFileSystem({ [finalPath]: file(2048) }),
      path.posix
    )

    await expect(planner.plan({ finalPath })).resolves.toMatchObject({
      kind: 'finalization-candidate',
      reason: 'final-file-present',
      diskPath: '/downloads/file.bin.motrix',
      bytesBefore: 2048,
    })
  })

  it('blocks rather than overwriting when final and temporary files coexist', async () => {
    const diskPath = '/downloads/file.bin.motrix'
    const finalPath = '/downloads/file.bin'
    const planner = new DirectRecoveryPlanner(
      makeFileSystem({
        [diskPath]: file(1024),
        [finalPath]: file(2048),
      }),
      path.posix
    )

    await expect(
      planner.plan({ primary: { diskPath }, finalPath })
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'final-path-conflict',
      bytesBefore: 1024,
    })
  })

  it.each([
    {
      name: 'missing metadata',
      input: {},
      reason: 'path-missing',
    },
    {
      name: 'relative path',
      input: { primary: { diskPath: 'downloads/file.motrix' } },
      reason: 'path-not-absolute',
    },
    {
      name: 'NUL in path',
      input: { primary: { diskPath: '/downloads/file\0.motrix' } },
      reason: 'path-contains-nul',
    },
    {
      name: 'root path with empty basename',
      input: { primary: { diskPath: '/' } },
      reason: 'filename-empty',
    },
  ])('rejects $name', async ({ input, reason }) => {
    const planner = new DirectRecoveryPlanner(makeFileSystem({}), path.posix)

    await expect(planner.plan(input)).resolves.toMatchObject({
      kind: 'invalid',
      reason,
      diskPath: null,
      saveDir: null,
      filename: null,
      bytesBefore: 0,
    })
  })

  it('rejects a relative finalPath even when diskPath is absolute', async () => {
    const planner = new DirectRecoveryPlanner(makeFileSystem({}), path.posix)

    await expect(
      planner.plan({
        primary: { diskPath: '/downloads/file.motrix' },
        finalPath: 'downloads/file',
      })
    ).resolves.toMatchObject({
      kind: 'invalid',
      reason: 'final-path-not-absolute',
    })
  })

  it.each([
    {
      entries: { '/downloads/file.motrix': directory },
      reason: 'temp-path-not-file',
    },
    {
      entries: {
        '/downloads/file.motrix': file(10),
        '/downloads/file.motrix.aria2': directory,
      },
      reason: 'checkpoint-path-not-file',
    },
  ])('rejects non-file recovery artifacts', async ({ entries, reason }) => {
    const planner = new DirectRecoveryPlanner(
      makeFileSystem(entries),
      path.posix
    )

    await expect(
      planner.plan({ primary: { diskPath: '/downloads/file.motrix' } })
    ).resolves.toMatchObject({
      kind: 'invalid',
      reason,
    })
  })

  it('turns unexpected probe errors into an invalid plan', async () => {
    const diskPath = '/downloads/file.motrix'
    const planner = new DirectRecoveryPlanner(
      makeFileSystem({}, [diskPath]),
      path.posix
    )

    await expect(
      planner.plan({ primary: { diskPath } })
    ).resolves.toMatchObject({
      kind: 'invalid',
      reason: 'file-probe-failed',
    })
  })
})

describe('DirectRecoveryPlanner checkpoint probe', () => {
  const diskPath = '/downloads/linux.iso.motrix'
  const fileSystem = makeFileSystem({ [diskPath]: file(8192) })

  it('asks the injected probe instead of looking for a .aria2 file', async () => {
    // With sqlite3 persistence aria2 never writes <file>.aria2; the
    // checkpoint lives in aria2.db. Probing the disk alone made every
    // interrupted download look unresumable (issue #2187).
    const probed: string[] = []
    const planner = new DirectRecoveryPlanner(fileSystem, path.posix, () => {
      return async (target) => {
        probed.push(target)
        return 'present'
      }
    })
    await expect(
      planner.plan({ primary: { diskPath }, finalPath: '/downloads/linux.iso' })
    ).resolves.toMatchObject({
      kind: 'checkpoint',
      reason: 'checkpoint-present',
    })
    expect(probed).toEqual([diskPath])
  })

  it('still blocks a partial file whose checkpoint the probe cannot find', async () => {
    const planner = new DirectRecoveryPlanner(
      fileSystem,
      path.posix,
      () => async () => 'absent'
    )
    await expect(
      planner.plan({ primary: { diskPath }, finalPath: '/downloads/linux.iso' })
    ).resolves.toMatchObject({ kind: 'blocked', reason: 'checkpoint-missing' })
  })

  it('reports a checkpoint that is not a regular file as invalid', async () => {
    const planner = new DirectRecoveryPlanner(
      fileSystem,
      path.posix,
      () => async () => 'not-file'
    )
    await expect(
      planner.plan({ primary: { diskPath }, finalPath: '/downloads/linux.iso' })
    ).resolves.toMatchObject({
      kind: 'invalid',
      reason: 'checkpoint-path-not-file',
    })
  })

  it('treats a failing probe as a failed probe, not as a missing checkpoint', async () => {
    const planner = new DirectRecoveryPlanner(fileSystem, path.posix, () => {
      return async () => {
        throw new Error('database is locked')
      }
    })
    await expect(
      planner.plan({ primary: { diskPath }, finalPath: '/downloads/linux.iso' })
    ).resolves.toMatchObject({ kind: 'invalid', reason: 'file-probe-failed' })
  })
})

describe('createEngineCheckpointProbe', () => {
  const diskPath = '/downloads/linux.iso.motrix'

  it('asks the engine, which knows which checkpoint store it reads', async () => {
    const engine = {
      getCheckpointStatus: vi.fn(async () => 'present' as const),
    }
    const probe = createEngineCheckpointProbe(engine, makeFileSystem({}))
    await expect(probe(diskPath)).resolves.toBe('present')
    expect(engine.getCheckpointStatus).toHaveBeenCalledWith(diskPath)
  })

  it('does not second-guess an engine that says absent', async () => {
    // A stray .aria2 file is not what a sqlite3-persisting engine would read.
    const engine = { getCheckpointStatus: async () => 'absent' as const }
    const probe = createEngineCheckpointProbe(
      engine,
      makeFileSystem({ [`${diskPath}.aria2`]: file(16) })
    )
    await expect(probe(diskPath)).resolves.toBe('absent')
  })

  it('falls back to the control file when the engine cannot answer', async () => {
    const fileSystem = makeFileSystem({ [`${diskPath}.aria2`]: file(16) })
    await expect(
      createEngineCheckpointProbe(
        { getCheckpointStatus: async () => null },
        fileSystem
      )(diskPath)
    ).resolves.toBe('present')
    await expect(
      createEngineCheckpointProbe({}, fileSystem)(diskPath)
    ).resolves.toBe('present')
  })
})
