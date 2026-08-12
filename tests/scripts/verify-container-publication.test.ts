import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import {
  CONTAINER_LABELS,
  CONTAINER_REPOSITORIES,
} from '../../scripts/container-release-metadata.mjs'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import { verifyContainerPublication } from '../../scripts/verify-container-publication.mjs'

const VERSION = '2.3.4'
const REVISION = 'a'.repeat(40)
const INDEX_DIGEST = `sha256:${'b'.repeat(64)}`
const AMD64_DIGEST = `sha256:${'c'.repeat(64)}`
const ARM64_DIGEST = `sha256:${'d'.repeat(64)}`

function inspect() {
  const platform = (architecture: string) => ({
    config: {
      User: 'node',
      Labels: {
        ...CONTAINER_LABELS,
        'org.opencontainers.image.revision': REVISION,
        'org.opencontainers.image.version': VERSION,
      },
    },
    platform: { architecture, os: 'linux' },
  })
  return {
    manifest: { digest: INDEX_DIGEST },
    image: {
      'linux/amd64': platform('amd64'),
      'linux/arm64': platform('arm64'),
    },
  }
}

function index(options?: { omitArmAttestation?: boolean }) {
  const manifest = (architecture: string, digest: string) => ({
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest,
    size: 1024,
    platform: { architecture, os: 'linux' },
  })
  const attestation = (subject: string, digest: string) => ({
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest,
    size: 512,
    annotations: {
      'vnd.docker.reference.digest': subject,
      'vnd.docker.reference.type': 'attestation-manifest',
    },
    platform: { architecture: 'unknown', os: 'unknown' },
  })
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      manifest('amd64', AMD64_DIGEST),
      attestation(AMD64_DIGEST, `sha256:${'e'.repeat(64)}`),
      manifest('arm64', ARM64_DIGEST),
      ...(options?.omitArmAttestation
        ? []
        : [attestation(ARM64_DIGEST, `sha256:${'f'.repeat(64)}`)]),
    ],
  }
}

function sbom(options?: { emptyArmPackages?: boolean }) {
  const result = (platform: string) => ({
    SPDX: {
      SPDXID: 'SPDXRef-DOCUMENT',
      documentNamespace: `https://example.invalid/${platform}`,
      packages: platform === 'arm64' && options?.emptyArmPackages ? [] : [{}],
      spdxVersion: 'SPDX-2.3',
    },
  })
  return {
    'linux/amd64': result('amd64'),
    'linux/arm64': result('arm64'),
  }
}

function provenance(options?: { incompleteArmMaterials?: boolean }) {
  const result = (platform: string) => ({
    SLSA: {
      buildConfig: {},
      buildType: 'https://mobyproject.org/buildkit@v1',
      builder: { id: 'https://github.com/agalwood/Motrix/actions/runs/1' },
      invocation: {},
      materials: [{}],
      metadata: {
        completeness: {
          environment: true,
          materials: platform !== 'arm64' || !options?.incompleteArmMaterials,
          parameters: true,
        },
      },
    },
  })
  return {
    'linux/amd64': result('amd64'),
    'linux/arm64': result('arm64'),
  }
}

function currentProvenance(options?: {
  builderId?: string
  revision?: string
}) {
  const result = () => ({
    SLSA: {
      buildDefinition: {
        buildType:
          'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
        externalParameters: {},
        internalParameters: {},
        resolvedDependencies: [{}],
      },
      runDetails: {
        builder: {
          id:
            options?.builderId ??
            'https://github.com/docker/buildx/actions/runs/123',
        },
        metadata: {
          buildkit_completeness: { request: true },
          buildkit_metadata: {
            vcs: {
              revision: options?.revision ?? REVISION,
              source: 'https://github.com/agalwood/Motrix.git',
            },
          },
        },
      },
    },
  })
  return {
    'linux/amd64': result(),
    'linux/arm64': result(),
  }
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    inspect: inspect(),
    index: index(),
    provenance: provenance(),
    sbom: sbom(),
    ...overrides,
  }
}

function verify(
  overrides: {
    builderIdPrefix?: string
    dockerHub?: ReturnType<typeof artifact>
    ghcr?: ReturnType<typeof artifact>
  } = {}
) {
  return verifyContainerPublication({
    builderIdPrefix: overrides.builderIdPrefix,
    dockerHub: overrides.dockerHub ?? artifact(),
    ghcr: overrides.ghcr ?? artifact(),
    revision: REVISION,
    version: VERSION,
  })
}

describe('container publication verifier', () => {
  it('accepts identical dual-registry indexes with both attestations', () => {
    expect(verify()).toEqual({
      digest: INDEX_DIGEST,
      platforms: ['linux/amd64', 'linux/arm64'],
      dockerHub: {
        'linux/amd64': AMD64_DIGEST,
        'linux/arm64': ARM64_DIGEST,
      },
      ghcr: {
        'linux/amd64': AMD64_DIGEST,
        'linux/arm64': ARM64_DIGEST,
      },
      sbom: 'SPDX-2.x',
      provenance: 'SLSA BuildKit',
    })
  })

  it('accepts current SLSA provenance and verifies the GitHub builder', () => {
    const current = artifact({ provenance: currentProvenance() })
    expect(
      verify({
        builderIdPrefix: 'https://github.com/docker/buildx/actions/runs/',
        dockerHub: current,
        ghcr: current,
      }).provenance
    ).toBe('SLSA BuildKit')
  })

  it.each([
    [
      'builder identity',
      currentProvenance({ builderId: 'https://example.invalid/build/1' }),
      /builder identity conflicts/,
    ],
    [
      'source revision',
      currentProvenance({ revision: '0'.repeat(40) }),
      /provenance revision conflicts/,
    ],
  ])('rejects a conflicting current SLSA %s', (_, document, error) => {
    expect(() =>
      verify({
        builderIdPrefix: 'https://github.com/docker/buildx/actions/runs/',
        dockerHub: artifact({ provenance: document }),
        ghcr: artifact({ provenance: document }),
      })
    ).toThrow(error)
  })

  it.each([
    [
      'missing attestation',
      artifact({ index: index({ omitArmAttestation: true }) }),
      /exactly one attestation/,
    ],
    [
      'empty SBOM',
      artifact({ sbom: sbom({ emptyArmPackages: true }) }),
      /package list is empty/,
    ],
    [
      'incomplete provenance',
      artifact({
        provenance: provenance({ incompleteArmMaterials: true }),
      }),
      /incomplete at materials/,
    ],
  ])('rejects %s', (_, dockerHub, error) => {
    expect(() => verify({ dockerHub })).toThrow(error)
  })

  it('rejects a registry digest divergence before attestation checks', () => {
    const ghcrInspect = inspect()
    ghcrInspect.manifest.digest = `sha256:${'0'.repeat(64)}`
    expect(() => verify({ ghcr: artifact({ inspect: ghcrInspect }) })).toThrow(
      /Immutable container tags disagree/
    )
  })

  it('keeps the expected public registry coordinates in the verified labels', () => {
    expect(CONTAINER_REPOSITORIES).toEqual({
      dockerHub: 'docker.io/agalwood/motrix-server',
      ghcr: 'ghcr.io/agalwood/motrix-server',
    })
  })
})
