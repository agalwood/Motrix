import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — build tooling is intentionally plain ESM.
import {
  readRevisionFile,
  verifySnapStoreChannel,
  verifyStoreChannelPayload,
  writeRevisionFile,
} from '../../scripts/verify-snap-store-channel.mjs'

function entry(
  architecture: 'amd64' | 'arm64',
  version = '2.0.0',
  risk = 'edge'
) {
  return {
    channel: {
      architecture,
      name: risk,
      risk,
      track: 'latest',
    },
    revision: architecture === 'amd64' ? 20 : 21,
    version,
  }
}

describe('verify-snap-store-channel', () => {
  it('requires the expected version for both release architectures', () => {
    expect(
      verifyStoreChannelPayload(
        { 'channel-map': [entry('amd64'), entry('arm64')] },
        { channel: 'latest/edge', version: '2.0.0' }
      )
    ).toEqual({
      architectures: ['amd64', 'arm64'],
      channel: 'latest/edge',
      revisions: {
        amd64: '20',
        arm64: '21',
      },
      version: '2.0.0',
    })
  })

  it('rejects a channel missing one architecture', () => {
    expect(() =>
      verifyStoreChannelPayload(
        { 'channel-map': [entry('amd64')] },
        { channel: 'latest/edge', version: '2.0.0' }
      )
    ).toThrow(/arm64: missing/)
  })

  it('rejects a split-version channel', () => {
    expect(() =>
      verifyStoreChannelPayload(
        {
          'channel-map': [entry('amd64'), entry('arm64', '1.8.19')],
        },
        { channel: 'latest/edge', version: '2.0.0' }
      )
    ).toThrow(/arm64: expected 2.0.0, received 1.8.19/)
  })

  it('rejects architectures outside the supported release set', () => {
    expect(() =>
      verifyStoreChannelPayload(
        {
          'channel-map': [
            entry('amd64'),
            entry('arm64'),
            {
              ...entry('amd64'),
              channel: {
                ...entry('amd64').channel,
                architecture: 'armhf',
              },
            },
          ],
        },
        { channel: 'latest/edge', version: '2.0.0' }
      )
    ).toThrow(/unexpected architectures: armhf/)
  })

  it('ignores entries from a different risk or track', () => {
    const candidate = entry('arm64')
    candidate.channel.risk = 'candidate'
    candidate.channel.name = 'candidate'

    expect(() =>
      verifyStoreChannelPayload(
        {
          'channel-map': [
            entry('amd64'),
            candidate,
            {
              ...entry('arm64'),
              channel: {
                ...entry('arm64').channel,
                track: 'preview',
              },
            },
          ],
        },
        { channel: 'latest/edge', version: '2.0.0' }
      )
    ).toThrow(/arm64: missing/)
  })

  it('compares exact revisions even when versions are unchanged', () => {
    expect(() =>
      verifyStoreChannelPayload(
        { 'channel-map': [entry('amd64'), entry('arm64')] },
        {
          channel: 'latest/edge',
          version: '2.0.0',
          expectedRevisions: {
            amd64: '20',
            arm64: '999',
          },
        }
      )
    ).toThrow(/arm64: expected revision 999, received 21/)
  })

  it('shares strict SemVer validation with release metadata', () => {
    expect(() =>
      verifyStoreChannelPayload(
        { 'channel-map': [entry('amd64'), entry('arm64')] },
        { channel: 'latest/edge', version: '2.0.0-01' }
      )
    ).toThrow(/strict SemVer/)
  })

  it('rejects a response for a different snap identity', () => {
    expect(() =>
      verifyStoreChannelPayload(
        {
          name: 'lookalike',
          snap: { name: 'lookalike' },
          'channel-map': [entry('amd64'), entry('arm64')],
        },
        {
          snapName: 'motrix',
          channel: 'latest/edge',
          version: '2.0.0',
        }
      )
    ).toThrow(/identity does not match motrix/)
  })

  it('writes and reads revision sets without partial file updates', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'motrix-snap-revisions-')
    )
    const filePath = path.join(directory, 'revisions.json')
    try {
      await writeRevisionFile(filePath, { amd64: '20', arm64: '21' }, [
        'amd64',
        'arm64',
      ])
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
        amd64: '20',
        arm64: '21',
      })
      await expect(
        readRevisionFile(filePath, ['amd64', 'arm64'])
      ).resolves.toEqual({
        amd64: '20',
        arm64: '21',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries until the public channel contains both architectures', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'motrix',
          snap: { name: 'motrix' },
          'channel-map': [entry('amd64')],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'motrix',
          snap: { name: 'motrix' },
          'channel-map': [entry('amd64'), entry('arm64')],
        }),
      })

    await expect(
      verifySnapStoreChannel({
        snapName: 'motrix',
        channel: 'latest/edge',
        version: '2.0.0',
        attempts: 2,
        delayMs: 0,
        fetchImpl,
      })
    ).resolves.toMatchObject({
      architectures: ['amd64', 'arm64'],
      attempts: 2,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.snapcraft.io/v2/snaps/info/motrix',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Snap-Device-Series': '16',
        }),
      })
    )
  })
})
