import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import {
  CONTAINER_LABELS,
  CONTAINER_REPOSITORIES,
  containerImageTags,
  resolveContainerLabels,
  resolveContainerReleaseMetadata,
} from '../../scripts/container-release-metadata.mjs'

describe('container release metadata', () => {
  it('promotes a stable SemVer release through the documented aliases', () => {
    expect(resolveContainerReleaseMetadata('2.3.4')).toEqual({
      version: '2.3.4',
      prerelease: false,
      immutableTag: '2.3.4',
      floatingTags: ['2.3', '2', 'stable', 'latest'],
    })
  })

  it('keeps prereleases off every stable floating alias', () => {
    expect(resolveContainerReleaseMetadata('2.3.4-beta.2')).toEqual({
      version: '2.3.4-beta.2',
      prerelease: true,
      immutableTag: '2.3.4-beta.2',
      floatingTags: [],
    })
  })

  it.each(['2.3.4+build.1', '2.3.4-rc.1', '2.3.4-nightly.1'])(
    'rejects image version %s outside the release contract',
    (version) => {
      expect(() => resolveContainerReleaseMetadata(version)).toThrow()
    }
  )

  it('expands the same immutable tag for Docker Hub and GHCR', () => {
    expect(containerImageTags(['2.3.4'])).toEqual([
      `${CONTAINER_REPOSITORIES.dockerHub}:2.3.4`,
      `${CONTAINER_REPOSITORIES.ghcr}:2.3.4`,
    ])
  })

  it('publishes Docker Hub images from the Motrix project namespace', () => {
    expect(CONTAINER_REPOSITORIES.dockerHub).toBe(
      'docker.io/motrixapp/motrix-server'
    )
    expect(CONTAINER_REPOSITORIES.ghcr).toBe('ghcr.io/agalwood/motrix-server')
  })

  it('emits complete OCI source identity labels', () => {
    const revision = 'a'.repeat(40)
    expect(resolveContainerLabels({ revision, version: '2.3.4' })).toEqual({
      ...CONTAINER_LABELS,
      'org.opencontainers.image.revision': revision,
      'org.opencontainers.image.version': '2.3.4',
    })
  })

  it.each(['abc123', 'A'.repeat(40), 'a'.repeat(39), `${'a'.repeat(40)}\n`])(
    'rejects unsafe revision %j',
    (revision) => {
      expect(() =>
        resolveContainerLabels({ revision, version: '2.3.4' })
      ).toThrow(/full lowercase SHA/)
    }
  )
})
