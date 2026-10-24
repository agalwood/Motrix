import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — build tooling is intentionally plain ESM.
import { releaseSnapBuildSet } from '../../scripts/release-snap-build-set.mjs'

function payload(
  entries: Array<['amd64' | 'arm64', string, string]>,
  channel = 'latest/candidate'
) {
  const [track, risk] = channel.split('/')
  return {
    name: 'motrix',
    snap: { name: 'motrix' },
    'channel-map': entries.map(([architecture, revision, version]) => ({
      channel: {
        architecture,
        name: risk,
        risk,
        track,
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
  it('passes the CLI override through all mutation commands while verifying the canonical channel', () => {
    const document = payload([
      ['amd64', '20', '2.0.0'],
      ['arm64', '21', '2.0.0'],
    ])
    const preload = `
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => (${JSON.stringify(document)}),
      })
      childProcess.execFile = (file, args, options, callback) => {
        console.log(JSON.stringify(args))
        callback(null, '', '')
      }
      syncBuiltinESMExports()
    `
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(preload)}`,
        path.resolve('scripts/release-snap-build-set.mjs'),
        '--snap',
        'motrix',
        '--channel',
        'latest/candidate',
        '--snapcraft-channel',
        'latest/candidate',
        '--version',
        '2.0.0',
        '--amd64-revision',
        '20',
        '--arm64-revision',
        '21',
        '--snapcraft',
        process.execPath,
        '--attempts',
        '1',
        '--delay-ms',
        '0',
      ],
      { encoding: 'utf8', timeout: 10_000 }
    )

    expect(output.trim().split('\n')).toEqual([
      JSON.stringify(['close', 'motrix', 'latest/candidate']),
      JSON.stringify(['release', 'motrix', '20', 'latest/candidate']),
      JSON.stringify(['release', 'motrix', '21', 'latest/candidate']),
      'Released motrix 2.0.0 to latest/candidate: {"amd64":"20","arm64":"21"}',
    ])
  })

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

  it.each([
    '',
    null,
    1,
    'stable',
    'latest/stable',
    '2/candidate',
    'latest/candidate/branch',
    'candidate/branch',
    'candidate,stable',
    'latest/candidate,latest/stable',
    ' candidate',
    'candidate ',
    'candidate\n',
    'latest/candidate\n',
    'candidate stable',
    'candidate;echo injected',
    '$(echo candidate)',
    '--help',
  ])(
    'rejects inequivalent request spelling %j before reading the Store',
    async (snapcraftChannel) => {
      const fetchImpl = vi.fn()
      const runSnapcraft = vi.fn()

      await expect(
        releaseSnapBuildSet({
          snapName: 'motrix',
          channel: 'latest/candidate',
          snapcraftChannel,
          version: '2.0.0',
          revisions: { amd64: '20', arm64: '21' },
          attempts: 1,
          delayMs: 0,
          fetchImpl,
          runSnapcraft,
        })
      ).rejects.toThrow(/Snapcraft channel must be an equivalent spelling/)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(runSnapcraft).not.toHaveBeenCalled()
    }
  )

  it.each(['candidate', 'latest/candidate', '3/candidate'])(
    'rejects %s for a non-default track before reading the Store',
    async (snapcraftChannel) => {
      const fetchImpl = vi.fn()
      const runSnapcraft = vi.fn()

      await expect(
        releaseSnapBuildSet({
          snapName: 'motrix',
          channel: '2/candidate',
          snapcraftChannel,
          version: '2.0.0',
          revisions: { amd64: '20', arm64: '21' },
          attempts: 1,
          delayMs: 0,
          fetchImpl,
          runSnapcraft,
        })
      ).rejects.toThrow(/Snapcraft channel must be an equivalent spelling/)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(runSnapcraft).not.toHaveBeenCalled()
    }
  )

  it.each([
    'candidate',
    'latest/candidate/branch',
    'latest/candidate,latest/stable',
    'latest/candidate\n',
  ])(
    'rejects noncanonical public channel %j before reading the Store',
    async (channel) => {
      const fetchImpl = vi.fn()
      const runSnapcraft = vi.fn()

      await expect(
        releaseSnapBuildSet({
          snapName: 'motrix',
          channel,
          snapcraftChannel: channel,
          version: '2.0.0',
          revisions: { amd64: '20', arm64: '21' },
          attempts: 1,
          delayMs: 0,
          fetchImpl,
          runSnapcraft,
        })
      ).rejects.toThrow(/Invalid channel/)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(runSnapcraft).not.toHaveBeenCalled()
    }
  )

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

  it.each([
    ['latest/candidate', undefined, 'candidate'],
    ['latest/edge', undefined, 'edge'],
    ['latest/candidate', 'candidate', 'candidate'],
    ['latest/candidate', 'latest/candidate', 'latest/candidate'],
    ['latest/stable', 'stable', 'stable'],
    ['latest/stable', 'latest/stable', 'latest/stable'],
    ['2/stable', undefined, '2/stable'],
    ['2/stable', '2/stable', '2/stable'],
  ])(
    'releases %s with override %s using request spelling %s',
    async (channel, snapcraftChannel, mutationChannel) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          response(
            payload(
              [
                ['amd64', '10', '1.8.19'],
                ['arm64', '11', '1.8.19'],
              ],
              channel
            )
          )
        )
        .mockResolvedValueOnce(
          response(
            payload(
              [
                ['amd64', '20', '2.0.0'],
                ['arm64', '21', '2.0.0'],
              ],
              channel
            )
          )
        )
      const runSnapcraft = vi.fn().mockResolvedValue(undefined)

      await expect(
        releaseSnapBuildSet({
          snapName: 'motrix',
          channel,
          snapcraftChannel,
          version: '2.0.0',
          revisions: { amd64: '20', arm64: '21' },
          attempts: 1,
          delayMs: 0,
          fetchImpl,
          runSnapcraft,
        })
      ).resolves.toEqual({
        channel,
        previous: { amd64: '10', arm64: '11' },
        released: { amd64: '20', arm64: '21' },
        version: '2.0.0',
      })
      expect(runSnapcraft.mock.calls).toEqual([
        [['close', 'motrix', mutationChannel]],
        [['release', 'motrix', '20', mutationChannel]],
        [['release', 'motrix', '21', mutationChannel]],
      ])
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['candidate', 'latest/candidate'])(
    'uses %s to close partial state and restore the previous target on failure',
    async (snapcraftChannel) => {
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
          snapcraftChannel,
          version: '2.0.0',
          revisions: { amd64: '20', arm64: '21' },
          attempts: 1,
          delayMs: 0,
          fetchImpl,
          runSnapcraft,
        })
      ).rejects.toThrow(/previous revisions were restored/)
      expect(runSnapcraft.mock.calls).toEqual([
        [['close', 'motrix', snapcraftChannel]],
        [['release', 'motrix', '20', snapcraftChannel]],
        [['release', 'motrix', '21', snapcraftChannel]],
        [['close', 'motrix', snapcraftChannel]],
        [['release', 'motrix', '10', snapcraftChannel]],
        [['release', 'motrix', '11', snapcraftChannel]],
      ])
    }
  )

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

  it.each(['candidate', 'latest/candidate'])(
    'keeps request spelling %s when partial rollback requires containment',
    async (snapcraftChannel) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        response(
          payload([
            ['amd64', '10', '1.8.19'],
            ['arm64', '11', '1.8.19'],
          ])
        )
      )
      const runSnapcraft = vi.fn(async (args: string[]) => {
        if (args[0] === 'release' && ['21', '11'].includes(args[2])) {
          throw new Error('Store rejected arm64 release')
        }
      })

      await expect(
        releaseSnapBuildSet({
          snapName: 'motrix',
          channel: 'latest/candidate',
          snapcraftChannel,
          version: '2.0.0',
          revisions: { amd64: '20', arm64: '21' },
          attempts: 1,
          delayMs: 0,
          fetchImpl,
          runSnapcraft,
        })
      ).rejects.toThrow(/rollback failed and the target channel was closed/)
      expect(runSnapcraft.mock.calls).toEqual([
        [['close', 'motrix', snapcraftChannel]],
        [['release', 'motrix', '20', snapcraftChannel]],
        [['release', 'motrix', '21', snapcraftChannel]],
        [['close', 'motrix', snapcraftChannel]],
        [['release', 'motrix', '10', snapcraftChannel]],
        [['release', 'motrix', '11', snapcraftChannel]],
        [['close', 'motrix', snapcraftChannel]],
      ])
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

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
