import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import {
  CONTAINER_PLATFORM_MATRIX,
  createContainerPlatformMetadata,
  inspectContainerPlatformPublication,
  verifyContainerPlatformMetadataSet,
} from '../../scripts/container-platform-metadata.mjs'
// @ts-expect-error -- JavaScript release script intentionally has no declarations
import { CONTAINER_LABELS } from '../../scripts/container-release-metadata.mjs'

const VERSION = '2.3.4-beta.5'
const REVISION = 'a'.repeat(40)
const BUILDER_RUN_ID =
  'https://github.com/agalwood/Motrix/actions/runs/31932206203'
const DIGESTS = {
  'linux/amd64': `sha256:${'b'.repeat(64)}`,
  'linux/arm64': `sha256:${'c'.repeat(64)}`,
} as const
const IMAGE_DIGESTS = {
  'linux/amd64': `sha256:${'d'.repeat(64)}`,
  'linux/arm64': `sha256:${'e'.repeat(64)}`,
} as const
const ATTESTATION_DIGESTS = {
  'linux/amd64': `sha256:${'f'.repeat(64)}`,
  'linux/arm64': `sha256:${'0'.repeat(64)}`,
} as const

function metadata(
  platform: keyof typeof CONTAINER_PLATFORM_MATRIX,
  overrides: Record<string, unknown> = {}
) {
  const matrix = CONTAINER_PLATFORM_MATRIX[platform]
  return createContainerPlatformMetadata({
    attestationDigest: ATTESTATION_DIGESTS[platform],
    builderAttempt: 2,
    builderRunId: BUILDER_RUN_ID,
    digest: DIGESTS[platform],
    imageDigest: IMAGE_DIGESTS[platform],
    platform,
    revision: REVISION,
    runnerArch: matrix.runnerArch,
    runnerEnvironment: 'github-hosted',
    runnerOs: 'Linux',
    version: VERSION,
    ...overrides,
  })
}

async function fixture(
  entries: Array<{
    file?: string
    platform: keyof typeof CONTAINER_PLATFORM_MATRIX
    value?: unknown
  }> = [{ platform: 'linux/amd64' }, { platform: 'linux/arm64' }]
) {
  const root = await mkdtemp(path.join(tmpdir(), 'motrix-container-metadata-'))
  for (const entry of entries) {
    const matrix = CONTAINER_PLATFORM_MATRIX[entry.platform]
    const directory = path.join(root, matrix.artifact)
    await mkdir(directory)
    await writeFile(
      path.join(directory, entry.file ?? matrix.metadataFile),
      `${JSON.stringify(entry.value ?? metadata(entry.platform))}\n`
    )
  }
  return root
}

function verify(directory: string, maximumBuilderAttempt = 3) {
  return verifyContainerPlatformMetadataSet({
    builderRunId: BUILDER_RUN_ID,
    directory,
    maximumBuilderAttempt,
    revision: REVISION,
    version: VERSION,
  })
}

function platformPublication(
  platform: 'linux/amd64' | 'linux/arm64',
  imageShape: 'flat' | 'platform-map' = 'flat'
) {
  const architecture = platform.split('/')[1]
  const imageDigest = IMAGE_DIGESTS[platform]
  const attestationDigest = ATTESTATION_DIGESTS[platform]
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: imageDigest,
          size: 1024,
          platform: { architecture, os: 'linux' },
        },
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: attestationDigest,
          size: 512,
          annotations: {
            'vnd.docker.reference.digest': imageDigest,
            'vnd.docker.reference.type': 'attestation-manifest',
          },
          platform: { architecture: 'unknown', os: 'unknown' },
        },
      ],
    })
  )
  const digest = `sha256:${createHash('sha256').update(index).digest('hex')}`
  const image = {
    architecture,
    os: 'linux',
    config: {
      User: 'node',
      Labels: {
        ...CONTAINER_LABELS,
        'org.opencontainers.image.revision': REVISION,
        'org.opencontainers.image.version': VERSION,
      },
    },
  }
  const inspect = {
    manifest: { digest },
    image:
      imageShape === 'flat'
        ? image
        : {
            [platform]: {
              config: image.config,
              platform: { architecture, os: 'linux' },
            },
          },
  }
  return { attestationDigest, digest, imageDigest, index, inspect }
}

describe('container platform metadata', () => {
  it('maps every platform to its required native GitHub runner', () => {
    expect(CONTAINER_PLATFORM_MATRIX).toEqual({
      'linux/amd64': {
        artifact: 'container-build-linux-amd64',
        metadataFile: 'linux-amd64.json',
        runner: 'ubuntu-22.04',
        runnerArch: 'X64',
      },
      'linux/arm64': {
        artifact: 'container-build-linux-arm64',
        metadataFile: 'linux-arm64.json',
        runner: 'ubuntu-22.04-arm',
        runnerArch: 'ARM64',
      },
    })
  })

  it('records one cross-registry digest after native anonymous smoke', () => {
    expect(metadata('linux/arm64')).toMatchObject({
      schemaVersion: 1,
      platform: 'linux/arm64',
      digest: DIGESTS['linux/arm64'],
      manifests: {
        image: IMAGE_DIGESTS['linux/arm64'],
        attestation: ATTESTATION_DIGESTS['linux/arm64'],
      },
      version: VERSION,
      revision: REVISION,
      builder: {
        runId: BUILDER_RUN_ID,
        attempt: 2,
        runner: 'ubuntu-22.04-arm',
        runnerArch: 'ARM64',
        runnerEnvironment: 'github-hosted',
        runnerOs: 'Linux',
      },
      repositories: {
        'docker.io/motrixapp/motrix-server': DIGESTS['linux/arm64'],
        'ghcr.io/agalwood/motrix-server': DIGESTS['linux/arm64'],
      },
      verification: {
        anonymousPull: [
          'docker.io/motrixapp/motrix-server',
          'ghcr.io/agalwood/motrix-server',
        ],
        smoke: 'full',
      },
    })
  })

  it('verifies raw digest, platform, labels, and manifests in both registries', () => {
    const artifact = platformPublication('linux/arm64')
    const cliIndex = Buffer.concat([artifact.index, Buffer.from('\n')])
    expect(
      inspectContainerPlatformPublication({
        digest: artifact.digest,
        dockerHubIndex: cliIndex,
        dockerHubInspect: artifact.inspect,
        ghcrIndex: cliIndex,
        ghcrInspect: artifact.inspect,
        platform: 'linux/arm64',
        revision: REVISION,
        version: VERSION,
      })
    ).toEqual({
      imageDigest: artifact.imageDigest,
      attestationDigest: artifact.attestationDigest,
    })
  })

  it('accepts the documented platform-keyed Image shape from a multi-platform inspection', () => {
    const artifact = platformPublication('linux/amd64', 'platform-map')
    expect(
      inspectContainerPlatformPublication({
        digest: artifact.digest,
        dockerHubIndex: artifact.index,
        dockerHubInspect: artifact.inspect,
        ghcrIndex: artifact.index,
        ghcrInspect: artifact.inspect,
        platform: 'linux/amd64',
        revision: REVISION,
        version: VERSION,
      })
    ).toEqual({
      imageDigest: artifact.imageDigest,
      attestationDigest: artifact.attestationDigest,
    })
  })

  it('rejects a platform inspection with a conflicting source revision', () => {
    const artifact = platformPublication('linux/amd64')
    const conflicting = structuredClone(artifact.inspect)
    conflicting.image.config.Labels['org.opencontainers.image.revision'] =
      '1'.repeat(40)
    expect(() =>
      inspectContainerPlatformPublication({
        digest: artifact.digest,
        dockerHubIndex: artifact.index,
        dockerHubInspect: artifact.inspect,
        ghcrIndex: artifact.index,
        ghcrInspect: conflicting,
        platform: 'linux/amd64',
        revision: REVISION,
        version: VERSION,
      })
    ).toThrow(/label .* conflicts/)
  })

  it.each([
    [
      'wrong flat architecture',
      (inspect: { image: Record<string, unknown> }) => {
        inspect.image.architecture = 'arm64'
      },
      /platform conflicts/,
    ],
    [
      'missing flat platform',
      (inspect: { image: Record<string, unknown> }) => {
        delete inspect.image.architecture
        delete inspect.image.os
      },
      /platform is missing/,
    ],
    [
      'ambiguous flat and mapped shape',
      (inspect: { image: Record<string, unknown> }) => {
        inspect.image['linux/amd64'] = structuredClone(inspect.image)
      },
      /shape is ambiguous/,
    ],
  ])('rejects a %s inspection', (_, mutate, error) => {
    const artifact = platformPublication('linux/amd64')
    const conflicting = structuredClone(artifact.inspect)
    mutate(conflicting)
    expect(() =>
      inspectContainerPlatformPublication({
        digest: artifact.digest,
        dockerHubIndex: artifact.index,
        dockerHubInspect: conflicting,
        ghcrIndex: artifact.index,
        ghcrInspect: artifact.inspect,
        platform: 'linux/amd64',
        revision: REVISION,
        version: VERSION,
      })
    ).toThrow(error)
  })

  it.each([
    ['emulated arm64', 'linux/arm64', { runnerArch: 'X64' }, /requires native/],
    [
      'self-hosted runner',
      'linux/amd64',
      { runnerEnvironment: 'self-hosted' },
      /GitHub-hosted/,
    ],
    ['non-Linux runner', 'linux/amd64', { runnerOs: 'Windows' }, /Linux/],
  ] as const)('rejects %s metadata', (_, platform, overrides, error) => {
    expect(() => metadata(platform, overrides)).toThrow(error)
  })

  it('accepts exactly one verified record for each required platform', async () => {
    await expect(verify(await fixture())).resolves.toEqual({
      schemaVersion: 1,
      version: VERSION,
      revision: REVISION,
      builderRunId: BUILDER_RUN_ID,
      maximumBuilderAttempt: 3,
      platforms: {
        'linux/amd64': {
          digest: DIGESTS['linux/amd64'],
          manifests: {
            image: IMAGE_DIGESTS['linux/amd64'],
            attestation: ATTESTATION_DIGESTS['linux/amd64'],
          },
        },
        'linux/arm64': {
          digest: DIGESTS['linux/arm64'],
          manifests: {
            image: IMAGE_DIGESTS['linux/arm64'],
            attestation: ATTESTATION_DIGESTS['linux/arm64'],
          },
        },
      },
    })
  })

  it.each([
    [
      'missing architecture',
      [{ platform: 'linux/amd64' }] as Parameters<typeof fixture>[0],
      /exactly 2 files/,
    ],
    [
      'duplicate architecture',
      [
        { platform: 'linux/amd64' },
        {
          file: 'linux-arm64.json',
          platform: 'linux/arm64',
          value: metadata('linux/amd64'),
        },
      ] as Parameters<typeof fixture>[0],
      /metadata file must be|duplicate/,
    ],
    [
      'wrong architecture filename',
      [
        { platform: 'linux/amd64' },
        { file: 'wrong.json', platform: 'linux/arm64' },
      ] as Parameters<typeof fixture>[0],
      /metadata file must be/,
    ],
    [
      'wrong revision',
      [
        { platform: 'linux/amd64' },
        {
          platform: 'linux/arm64',
          value: metadata('linux/arm64', { revision: 'd'.repeat(40) }),
        },
      ] as Parameters<typeof fixture>[0],
      /version or revision conflicts/,
    ],
  ])('fails closed for a %s', async (_, entries, error) => {
    await expect(verify(await fixture(entries))).rejects.toThrow(error)
  })

  it('rejects a future build attempt', async () => {
    await expect(verify(await fixture(), 1)).rejects.toThrow(/future/)
  })

  it('rejects identical digests for different architectures', async () => {
    const root = await fixture([
      { platform: 'linux/amd64' },
      {
        platform: 'linux/arm64',
        value: metadata('linux/arm64', { digest: DIGESTS['linux/amd64'] }),
      },
    ])
    await expect(verify(root)).rejects.toThrow(/must not share/)
  })

  it('rejects symbolic-link metadata inputs', async () => {
    const root = await fixture([{ platform: 'linux/amd64' }])
    await symlink(
      path.join(
        root,
        CONTAINER_PLATFORM_MATRIX['linux/amd64'].artifact,
        CONTAINER_PLATFORM_MATRIX['linux/amd64'].metadataFile
      ),
      path.join(root, 'linux-arm64.json')
    )
    await expect(verify(root)).rejects.toThrow(/symbolic link/)
  })
})
