import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — build tooling is intentionally plain ESM.
import { releaseSnapBuildSet } from '../../scripts/release-snap-build-set.mjs'

function payload(entries: Array<['amd64' | 'arm64', string, string]>) {
  return {
    name: 'motrix',
    snap: { name: 'motrix' },
    'channel-map': entries.map(([architecture, revision, version]) => ({
      channel: {
        architecture,
        name: 'candidate',
        risk: 'candidate',
        track: 'latest',
      },
      revision,
      version,
    })),
  }
}

function response(document: ReturnType<typeof payload>) {
  return {
    ok: true,
    status: 200,
    json: async () => document,
  }
}

describe('release-snap-build-set', () => {
  it('rejects invalid release metadata before reading or mutating the Store', async () => {
    const fetchImpl = vi.fn()
    const runSnapcraft = vi.fn()

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0-01',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/strict SemVer/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(runSnapcraft).not.toHaveBeenCalled()
  })

  it('does not mutate the Store when the initial snapshot cannot be read', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Store unavailable'))
    const runSnapcraft = vi.fn()

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/Could not read/)
    expect(runSnapcraft).not.toHaveBeenCalled()
  })

  it('closes the target before releasing the approved exact revisions', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '20', '2.0.0'],
            ['arm64', '21', '2.0.0'],
          ])
        )
      )
    const runSnapcraft = vi.fn().mockResolvedValue(undefined)

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).resolves.toEqual({
      channel: 'latest/candidate',
      previous: { amd64: '10', arm64: '11' },
      released: { amd64: '20', arm64: '21' },
      version: '2.0.0',
    })
    expect(runSnapcraft.mock.calls).toEqual([
      [['close', 'motrix', 'candidate']],
      [['release', 'motrix', '20', 'candidate']],
      [['release', 'motrix', '21', 'candidate']],
    ])
  })

  it('closes partial state and restores the previous target on failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
    const runSnapcraft = vi.fn(async (args: string[]) => {
      if (args[0] === 'release' && args[2] === '21') {
        throw new Error('Store rejected arm64 release')
      }
    })

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/previous revisions were restored/)
    expect(runSnapcraft.mock.calls).toEqual([
      [['close', 'motrix', 'candidate']],
      [['release', 'motrix', '20', 'candidate']],
      [['release', 'motrix', '21', 'candidate']],
      [['close', 'motrix', 'candidate']],
      [['release', 'motrix', '10', 'candidate']],
      [['release', 'motrix', '11', 'candidate']],
    ])
  })

  it('restores after the initial close commits but its response is lost', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
    let closeCalls = 0
    const runSnapcraft = vi.fn(async (args: string[]) => {
      if (args[0] === 'close') {
        closeCalls += 1
        if (closeCalls === 1) {
          throw new Error('response lost after Store committed close')
        }
      }
    })

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/previous revisions were restored/)
    expect(runSnapcraft.mock.calls).toEqual([
      [['close', 'motrix', 'candidate']],
      [['close', 'motrix', 'candidate']],
      [['release', 'motrix', '10', 'candidate']],
      [['release', 'motrix', '11', 'candidate']],
    ])
  })

  it('restores a target that previously had only one architecture', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(payload([['amd64', '10', '1.8.19']])))
      .mockResolvedValueOnce(response(payload([['amd64', '10', '1.8.19']])))
    const runSnapcraft = vi.fn(async (args: string[]) => {
      if (args[0] === 'release' && args[2] === '21') {
        throw new Error('Store rejected arm64 release')
      }
    })

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/previous revisions were restored/)
    expect(runSnapcraft.mock.calls.at(-1)).toEqual([
      ['release', 'motrix', '10', 'candidate'],
    ])
  })

  it('restores an entirely empty target without releasing an old revision', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(payload([])))
      .mockResolvedValueOnce(response(payload([])))
    const runSnapcraft = vi.fn(async (args: string[]) => {
      if (args[0] === 'release' && args[2] === '21') {
        throw new Error('Store rejected arm64 release')
      }
    })

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/previous revisions were restored/)
    expect(runSnapcraft.mock.calls).toEqual([
      [['close', 'motrix', 'candidate']],
      [['release', 'motrix', '20', 'candidate']],
      [['release', 'motrix', '21', 'candidate']],
      [['close', 'motrix', 'candidate']],
    ])
  })

  it('rolls back when both releases succeed but exact verification fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '20', '2.0.0'],
            ['arm64', '999', '2.0.0'],
          ])
        )
      )
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
    const runSnapcraft = vi.fn().mockResolvedValue(undefined)

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/previous revisions were restored/)
    expect(runSnapcraft.mock.calls).toEqual([
      [['close', 'motrix', 'candidate']],
      [['release', 'motrix', '20', 'candidate']],
      [['release', 'motrix', '21', 'candidate']],
      [['close', 'motrix', 'candidate']],
      [['release', 'motrix', '10', 'candidate']],
      [['release', 'motrix', '11', 'candidate']],
    ])
  })

  it('retries a transient public Store read while verifying rollback', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
      .mockRejectedValueOnce(new Error('temporary Store outage'))
      .mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
    const runSnapcraft = vi.fn(async (args: string[]) => {
      if (args[0] === 'release' && args[2] === '21') {
        throw new Error('Store rejected arm64 release')
      }
    })

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 2,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/previous revisions were restored/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('reports both the release and rollback failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      response(
        payload([
          ['amd64', '10', '1.8.19'],
          ['arm64', '11', '1.8.19'],
        ])
      )
    )
    let closeCalls = 0
    const runSnapcraft = vi.fn(async (args: string[]) => {
      if (args[0] === 'close') {
        closeCalls += 1
        if (closeCalls === 2) throw new Error('rollback close failed')
      }
      if (args[0] === 'release' && args[2] === '21') {
        throw new Error('Store rejected arm64 release')
      }
    })

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/rollback failed and the target channel was closed/)
    expect(runSnapcraft.mock.calls.at(-1)).toEqual([
      ['close', 'motrix', 'candidate'],
    ])
  })

  it('reports when the final containment close also fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      response(
        payload([
          ['amd64', '10', '1.8.19'],
          ['arm64', '11', '1.8.19'],
        ])
      )
    )
    let closeCalls = 0
    const runSnapcraft = vi.fn(async (args: string[]) => {
      if (args[0] === 'close') {
        closeCalls += 1
        if (closeCalls > 1) throw new Error('Store close failed')
      }
      if (args[0] === 'release' && args[2] === '21') {
        throw new Error('Store rejected arm64 release')
      }
    })

    await expect(
      releaseSnapBuildSet({
        snapName: 'motrix',
        channel: 'latest/candidate',
        version: '2.0.0',
        revisions: { amd64: '20', arm64: '21' },
        attempts: 1,
        delayMs: 0,
        fetchImpl,
        runSnapcraft,
      })
    ).rejects.toThrow(/rollback and containment close both failed/)
    expect(closeCalls).toBe(3)
  })
})
