import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import {
  parseStrictSemVer,
  resolveReleaseMetadata,
} from '../../scripts/release-metadata.mjs'

describe('release metadata', () => {
  it.each([
    ['0.0.0', false, 'stable'],
    ['2.0.0', false, 'stable'],
    ['2.0.0-beta.1', true, 'beta'],
    ['2.0.0-beta.1+build.7', true, 'beta'],
    ['2.0.0-beta.1+build-linux', true, 'beta'],
    ['2.0.0+build.007', false, 'stable'],
    ['2.0.0+build-linux', false, 'stable'],
  ] as const)('parses strict SemVer %s', (version, prerelease, channel) => {
    expect(parseStrictSemVer(version)).toEqual({
      version,
      prerelease,
      channel,
    })
  })

  it.each([
    '',
    '1',
    '1.0',
    '01.0.0',
    '1.01.0',
    '1.0.01',
    '1.0.0-',
    '1.0.0-01',
    '1.0.0-alpha..1',
    '1.0.0+',
    '1.0.0 build',
    '1.0.0\nprerelease=false',
  ])('rejects non-strict version %j', (version) => {
    expect(() => parseStrictSemVer(version)).toThrow(/strict SemVer|non-empty/)
  })

  it('accepts a protected tag matching package.json exactly', () => {
    expect(
      resolveReleaseMetadata({
        eventName: 'push',
        refName: 'v2.0.0-beta.1',
        refProtected: 'true',
        packageVersion: '2.0.0-beta.1',
      })
    ).toEqual({
      version: '2.0.0-beta.1',
      prerelease: true,
      channel: 'beta',
    })
  })

  it('keeps hyphenated build metadata on the stable channel', () => {
    expect(
      resolveReleaseMetadata({
        eventName: 'push',
        refName: 'v2.0.0+build-linux',
        refProtected: 'true',
        packageVersion: '2.0.0+build-linux',
      })
    ).toEqual({
      version: '2.0.0+build-linux',
      prerelease: false,
      channel: 'stable',
    })
  })

  it('uses package.json metadata for manual validation builds', () => {
    expect(
      resolveReleaseMetadata({
        eventName: 'workflow_dispatch',
        refName: 'main',
        refProtected: 'false',
        packageVersion: '2.0.0',
      })
    ).toEqual({ version: '2.0.0', prerelease: false, channel: 'stable' })
  })

  it.each(['2.0.0-arm64.1', '2.0.0+arm64'])(
    'rejects macOS updater-ambiguous version %s',
    (packageVersion) => {
      expect(() =>
        resolveReleaseMetadata({
          eventName: 'workflow_dispatch',
          refName: 'main',
          refProtected: 'false',
          packageVersion,
        })
      ).toThrow(/lowercase "arm64".*macOS artifact URL.*ambiguous/)
    }
  )

  it.each(['2.0.0-alpha.1', '2.0.0-rc.1', '2.0.0-ARM64.1'])(
    'rejects unsupported prerelease channel %s',
    (packageVersion) => {
      expect(() =>
        resolveReleaseMetadata({
          eventName: 'workflow_dispatch',
          refName: 'main',
          refProtected: 'false',
          packageVersion,
        })
      ).toThrow(/prerelease channel must be beta/)
    }
  )

  it.each([
    {
      label: 'unprotected tag',
      values: {
        eventName: 'push',
        refName: 'v2.0.0',
        refProtected: 'false',
        packageVersion: '2.0.0',
      },
      error: /not protected/,
    },
    {
      label: 'version mismatch',
      values: {
        eventName: 'push',
        refName: 'v2.0.1',
        refProtected: 'true',
        packageVersion: '2.0.0',
      },
      error: /does not match/,
    },
    {
      label: 'missing v prefix',
      values: {
        eventName: 'push',
        refName: '2.0.0',
        refProtected: 'true',
        packageVersion: '2.0.0',
      },
      error: /start with v/,
    },
    {
      label: 'malformed tag',
      values: {
        eventName: 'push',
        refName: 'v2.0.0\ninjected=true',
        refProtected: 'true',
        packageVersion: '2.0.0',
      },
      error: /strict SemVer/,
    },
    {
      label: 'unsupported event',
      values: {
        eventName: 'pull_request',
        refName: 'main',
        refProtected: 'true',
        packageVersion: '2.0.0',
      },
      error: /Unsupported release event/,
    },
  ])('rejects $label', ({ values, error }) => {
    expect(() => resolveReleaseMetadata(values)).toThrow(error)
  })
})
