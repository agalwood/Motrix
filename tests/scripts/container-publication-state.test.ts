import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import { resolveContainerPublicationState } from '../../scripts/container-publication-state.mjs'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import {
  CONTAINER_LABELS,
  CONTAINER_REPOSITORIES,
} from '../../scripts/container-release-metadata.mjs'

const VERSION = '2.3.4'
const REVISION = 'a'.repeat(40)
const DIGEST = `sha256:${'b'.repeat(64)}`

function snapshot(options?: {
  digest?: string
  revision?: string
  user?: string
  platforms?: string[]
}) {
  const platforms = options?.platforms ?? ['linux/amd64', 'linux/arm64']
  return {
    manifest: { digest: options?.digest ?? DIGEST },
    image: Object.fromEntries(
      platforms.map((platform) => [
        platform,
        {
          config: {
            User: options?.user ?? 'node',
            Labels: {
              ...CONTAINER_LABELS,
              'org.opencontainers.image.revision':
                options?.revision ?? REVISION,
              'org.opencontainers.image.version': VERSION,
            },
          },
        },
      ])
    ),
  }
}

describe('container publication state', () => {
  it('builds only when neither immutable tag exists', () => {
    expect(
      resolveContainerPublicationState({
        dockerHubSnapshot: null,
        ghcrSnapshot: null,
        revision: REVISION,
        version: VERSION,
      })
    ).toEqual({ action: 'build', digest: '', copySource: '', copyTarget: '' })
  })

  it('resumes an identical complete publication', () => {
    expect(
      resolveContainerPublicationState({
        dockerHubSnapshot: snapshot(),
        ghcrSnapshot: snapshot(),
        revision: REVISION,
        version: VERSION,
      })
    ).toEqual({
      action: 'resume',
      digest: DIGEST,
      copySource: '',
      copyTarget: '',
    })
  })

  it.each([
    [
      'Docker Hub to GHCR',
      snapshot(),
      null,
      `${CONTAINER_REPOSITORIES.dockerHub}@${DIGEST}`,
      `${CONTAINER_REPOSITORIES.ghcr}:${VERSION}`,
    ],
    [
      'GHCR to Docker Hub',
      null,
      snapshot(),
      `${CONTAINER_REPOSITORIES.ghcr}@${DIGEST}`,
      `${CONTAINER_REPOSITORIES.dockerHub}:${VERSION}`,
    ],
  ])(
    'repairs a partial %s publication without rebuilding',
    (_, dockerHubSnapshot, ghcrSnapshot, copySource, copyTarget) => {
      expect(
        resolveContainerPublicationState({
          dockerHubSnapshot,
          ghcrSnapshot,
          revision: REVISION,
          version: VERSION,
        })
      ).toEqual({ action: 'copy', digest: DIGEST, copySource, copyTarget })
    }
  )

  it('refuses to replace disagreeing immutable tags', () => {
    expect(() =>
      resolveContainerPublicationState({
        dockerHubSnapshot: snapshot(),
        ghcrSnapshot: snapshot({ digest: `sha256:${'c'.repeat(64)}` }),
        revision: REVISION,
        version: VERSION,
      })
    ).toThrow(/Immutable container tags disagree/)
  })

  it.each([
    ['wrong revision', snapshot({ revision: 'c'.repeat(40) }), /conflicts/],
    ['root user', snapshot({ user: 'root' }), /default user is not node/],
    [
      'missing architecture',
      snapshot({ platforms: ['linux/amd64'] }),
      /missing linux\/arm64/,
    ],
  ])('refuses %s on an existing immutable tag', (_, dockerHub, error) => {
    expect(() =>
      resolveContainerPublicationState({
        dockerHubSnapshot: dockerHub,
        ghcrSnapshot: null,
        revision: REVISION,
        version: VERSION,
      })
    ).toThrow(error)
  })

  it('rejects malformed release revisions before publication', () => {
    expect(() =>
      resolveContainerPublicationState({
        dockerHubSnapshot: snapshot(),
        ghcrSnapshot: null,
        revision: 'abc123',
        version: VERSION,
      })
    ).toThrow(/full lowercase SHA/)
  })
})
