import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  REQUIRED_CONTAINER_PLATFORMS,
  resolveContainerPublicationState,
} from './container-publication-state.mjs'
import { CONTAINER_REPOSITORIES } from './container-release-metadata.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
])
const LEGACY_BUILD_TYPE = 'https://mobyproject.org/buildkit@v1'
const BUILD_TYPE =
  'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md'

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function string(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function digest(value, label) {
  const result = string(value, label)
  if (!DIGEST_PATTERN.test(result)) {
    throw new Error(`${label} must be a sha256 digest`)
  }
  return result
}

function verifyRawIndexDigest(bytes, expectedDigest, repository) {
  if (bytes === undefined) return
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`${repository} raw index must be bytes`)
  }
  const candidates = [bytes]
  if (bytes.at(-1) === 0x0a) candidates.push(bytes.subarray(0, -1))
  if (
    !candidates.some(
      (candidate) =>
        `sha256:${createHash('sha256').update(candidate).digest('hex')}` ===
        expectedDigest
    )
  ) {
    throw new Error(`${repository} raw index digest conflicts`)
  }
}

function verifyIndex(index, repository) {
  const document = record(index, `${repository} index`)
  if (document.schemaVersion !== 2) {
    throw new Error(`${repository} index must use schemaVersion 2`)
  }
  if (!INDEX_MEDIA_TYPES.has(document.mediaType)) {
    throw new Error(`${repository} is not a multi-architecture image index`)
  }
  const descriptors = array(document.manifests, `${repository} manifests`)
  const platformDigests = new Map()
  const attestationDigests = new Map()
  for (const descriptorValue of descriptors) {
    const descriptor = record(descriptorValue, `${repository} descriptor`)
    const platform = record(
      descriptor.platform,
      `${repository} descriptor platform`
    )
    const key = `${platform.os}/${platform.architecture}`
    if (
      descriptor.annotations?.['vnd.docker.reference.type'] ===
      'attestation-manifest'
    ) {
      if (key !== 'unknown/unknown') {
        throw new Error(`${repository} attestation has unexpected ${key}`)
      }
      const subject = digest(
        descriptor.annotations?.['vnd.docker.reference.digest'],
        `${repository} attestation subject digest`
      )
      if (attestationDigests.has(subject)) {
        throw new Error(
          `${repository} has duplicate attestation manifests for ${subject}`
        )
      }
      attestationDigests.set(
        subject,
        digest(descriptor.digest, `${repository} attestation digest`)
      )
      continue
    }
    if (!REQUIRED_CONTAINER_PLATFORMS.includes(key)) {
      throw new Error(`${repository} has unexpected image platform ${key}`)
    }
    if (platformDigests.has(key)) {
      throw new Error(`${repository} has duplicate ${key} image manifests`)
    }
    platformDigests.set(
      key,
      digest(descriptor.digest, `${repository} ${key} manifest digest`)
    )
  }

  for (const platform of REQUIRED_CONTAINER_PLATFORMS) {
    const subjectDigest = platformDigests.get(platform)
    if (!subjectDigest) {
      throw new Error(`${repository} index is missing ${platform}`)
    }
    if (!attestationDigests.has(subjectDigest)) {
      throw new Error(
        `${repository} ${platform} must have exactly one attestation manifest`
      )
    }
  }
  if (attestationDigests.size !== REQUIRED_CONTAINER_PLATFORMS.length) {
    throw new Error(`${repository} has an unattached attestation manifest`)
  }
  return {
    images: Object.fromEntries(platformDigests),
    attestations: Object.fromEntries(
      REQUIRED_CONTAINER_PLATFORMS.map((platform) => {
        const subjectDigest = platformDigests.get(platform)
        return [platform, attestationDigests.get(subjectDigest)]
      })
    ),
  }
}

function verifySbom(sbom, repository) {
  const document = record(sbom, `${repository} SBOM result`)
  for (const platform of REQUIRED_CONTAINER_PLATFORMS) {
    const platformResult = record(
      document[platform],
      `${repository} ${platform} SBOM result`
    )
    const spdx = record(platformResult.SPDX, `${repository} ${platform} SPDX`)
    if (spdx.SPDXID !== 'SPDXRef-DOCUMENT') {
      throw new Error(`${repository} ${platform} has no SPDX document root`)
    }
    if (!/^SPDX-2\.[0-9]+$/.test(spdx.spdxVersion)) {
      throw new Error(`${repository} ${platform} has no SPDX 2.x version`)
    }
    string(
      spdx.documentNamespace,
      `${repository} ${platform} SPDX document namespace`
    )
    if (
      array(spdx.packages, `${repository} ${platform} SPDX packages`).length < 1
    ) {
      throw new Error(`${repository} ${platform} SPDX package list is empty`)
    }
  }
}

function positiveInteger(value, label) {
  const text = typeof value === 'number' ? String(value) : string(value, label)
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${label} must be a positive integer`)
  }
  const result = Number(text)
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} must be a safe integer`)
  }
  return result
}

function verifyBuilderIdentity(
  builderId,
  repository,
  platform,
  builderRunId,
  maximumBuilderAttempt
) {
  const expectedPrefix = `${builderRunId}/attempts/`
  if (!builderId.startsWith(expectedPrefix)) {
    throw new Error(`${repository} ${platform} builder identity conflicts`)
  }
  const attemptText = builderId.slice(expectedPrefix.length)
  if (!/^[1-9][0-9]*$/.test(attemptText)) {
    throw new Error(`${repository} ${platform} builder identity conflicts`)
  }
  const attempt = Number(attemptText)
  if (!Number.isSafeInteger(attempt) || attempt > maximumBuilderAttempt) {
    throw new Error(`${repository} ${platform} builder identity conflicts`)
  }
}

function verifyProvenance(
  provenance,
  repository,
  revision,
  builderRunId,
  maximumBuilderAttempt
) {
  const document = record(provenance, `${repository} provenance result`)
  for (const platform of REQUIRED_CONTAINER_PLATFORMS) {
    const platformResult = record(
      document[platform],
      `${repository} ${platform} provenance result`
    )
    const slsa = record(
      platformResult.SLSA,
      `${repository} ${platform} SLSA provenance`
    )
    let builderId
    if (slsa.buildDefinition) {
      const definition = record(
        slsa.buildDefinition,
        `${repository} ${platform} build definition`
      )
      if (definition.buildType !== BUILD_TYPE) {
        throw new Error(
          `${repository} ${platform} has an unexpected build type`
        )
      }
      record(
        definition.externalParameters,
        `${repository} ${platform} external parameters`
      )
      record(
        definition.internalParameters,
        `${repository} ${platform} internal parameters`
      )
      if (
        array(
          definition.resolvedDependencies,
          `${repository} ${platform} resolved dependencies`
        ).length < 1
      ) {
        throw new Error(
          `${repository} ${platform} provenance has no resolved dependencies`
        )
      }
      const runDetails = record(
        slsa.runDetails,
        `${repository} ${platform} run details`
      )
      const rawBuilderId = record(
        runDetails.builder,
        `${repository} ${platform} builder`
      ).id
      if (typeof rawBuilderId !== 'string') {
        throw new Error(`${repository} ${platform} builder id must be a string`)
      }
      builderId = rawBuilderId
      const metadata = record(
        runDetails.metadata,
        `${repository} ${platform} metadata`
      )
      const completeness = record(
        metadata.buildkit_completeness,
        `${repository} ${platform} BuildKit completeness`
      )
      if (completeness.request !== true) {
        throw new Error(`${repository} ${platform} build request is incomplete`)
      }
      const vcs = record(
        record(
          metadata.buildkit_metadata,
          `${repository} ${platform} BuildKit metadata`
        ).vcs,
        `${repository} ${platform} VCS metadata`
      )
      if (vcs.revision !== revision) {
        throw new Error(
          `${repository} ${platform} provenance revision conflicts`
        )
      }
      if (
        !string(vcs.source, `${repository} ${platform} VCS source`).includes(
          'agalwood/Motrix'
        )
      ) {
        throw new Error(`${repository} ${platform} provenance source conflicts`)
      }
    } else {
      if (slsa.buildType !== LEGACY_BUILD_TYPE) {
        throw new Error(
          `${repository} ${platform} has an unexpected build type`
        )
      }
      builderId = string(
        record(slsa.builder, `${repository} ${platform} builder`).id,
        `${repository} ${platform} builder id`
      )
      record(slsa.invocation, `${repository} ${platform} invocation`)
      record(slsa.buildConfig, `${repository} ${platform} build config`)
      if (
        array(slsa.materials, `${repository} ${platform} materials`).length < 1
      ) {
        throw new Error(`${repository} ${platform} provenance has no materials`)
      }
      const completeness = record(
        record(slsa.metadata, `${repository} ${platform} metadata`)
          .completeness,
        `${repository} ${platform} completeness`
      )
      for (const field of ['parameters', 'environment', 'materials']) {
        if (completeness[field] !== true) {
          throw new Error(
            `${repository} ${platform} provenance is incomplete at ${field}`
          )
        }
      }
    }
    verifyBuilderIdentity(
      builderId,
      repository,
      platform,
      builderRunId,
      maximumBuilderAttempt
    )
  }
}

function verifyArtifact(
  artifact,
  repository,
  revision,
  builderRunId,
  maximumBuilderAttempt
) {
  const expectedDigest = digest(
    artifact.inspect?.manifest?.digest,
    `${repository} inspected index digest`
  )
  verifyRawIndexDigest(artifact.indexBytes, expectedDigest, repository)
  const manifests = verifyIndex(artifact.index, repository)
  verifySbom(artifact.sbom, repository)
  verifyProvenance(
    artifact.provenance,
    repository,
    revision,
    builderRunId,
    maximumBuilderAttempt
  )
  return manifests
}

function verificationIdentity(builderRunId, maximumBuilderAttempt) {
  const expectedBuilderRun = string(builderRunId, 'builder run id')
  if (
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*$/.test(
      expectedBuilderRun
    )
  ) {
    throw new Error('builder run id must be an exact GitHub Actions run URL')
  }
  return {
    builderRunId: expectedBuilderRun,
    maximumBuilderAttempt: positiveInteger(
      maximumBuilderAttempt,
      'maximum builder attempt'
    ),
  }
}

function exactPlatformMap(value, label) {
  const result = record(value, label)
  const keys = Object.keys(result).sort()
  const expected = [...REQUIRED_CONTAINER_PLATFORMS].sort()
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain exactly ${expected.join(',')}`)
  }
  return result
}

function verifyExpectedPlatformMetadata(
  metadata,
  version,
  revision,
  manifests
) {
  const document = record(metadata, 'platform build metadata')
  if (
    document.schemaVersion !== 1 ||
    document.version !== version ||
    document.revision !== revision
  ) {
    throw new Error('platform build metadata identity conflicts')
  }
  const platforms = exactPlatformMap(
    document.platforms,
    'platform build metadata platforms'
  )
  for (const platform of REQUIRED_CONTAINER_PLATFORMS) {
    const expected = record(platforms[platform], `${platform} build metadata`)
    digest(expected.digest, `${platform} source index digest`)
    const expectedManifests = record(
      expected.manifests,
      `${platform} build manifests`
    )
    const expectedKeys = Object.keys(expectedManifests).sort().join(',')
    if (expectedKeys !== 'attestation,image') {
      throw new Error(`${platform} build manifests are incomplete`)
    }
    if (
      digest(expectedManifests.image, `${platform} expected image digest`) !==
      manifests.images[platform]
    ) {
      throw new Error(`${platform} published image digest conflicts`)
    }
    if (
      digest(
        expectedManifests.attestation,
        `${platform} expected attestation digest`
      ) !== manifests.attestations[platform]
    ) {
      throw new Error(`${platform} published attestation digest conflicts`)
    }
  }
}

export function verifyContainerPublication({
  builderRunId,
  dockerHub,
  ghcr,
  maximumBuilderAttempt,
  platformMetadata,
  revision,
  version,
}) {
  const identity = verificationIdentity(builderRunId, maximumBuilderAttempt)
  const publication = resolveContainerPublicationState({
    dockerHubSnapshot: dockerHub.inspect,
    ghcrSnapshot: ghcr.inspect,
    revision,
    version,
  })
  if (publication.action !== 'resume') {
    throw new Error(
      `Container publication is incomplete: ${publication.action}`
    )
  }
  const dockerHubManifests = verifyArtifact(
    dockerHub,
    'Docker Hub',
    revision,
    identity.builderRunId,
    identity.maximumBuilderAttempt
  )
  const ghcrManifests = verifyArtifact(
    ghcr,
    'GHCR',
    revision,
    identity.builderRunId,
    identity.maximumBuilderAttempt
  )
  for (const field of ['images', 'attestations']) {
    for (const platform of REQUIRED_CONTAINER_PLATFORMS) {
      if (
        dockerHubManifests[field][platform] !== ghcrManifests[field][platform]
      ) {
        throw new Error(
          `${platform} ${field} disagree across Docker Hub and GHCR`
        )
      }
    }
  }
  if (platformMetadata !== undefined) {
    verifyExpectedPlatformMetadata(
      platformMetadata,
      version,
      revision,
      dockerHubManifests
    )
  }
  return {
    digest: publication.digest,
    platforms: REQUIRED_CONTAINER_PLATFORMS,
    dockerHub: dockerHubManifests.images,
    ghcr: ghcrManifests.images,
    sbom: 'SPDX-2.x',
    provenance: 'SLSA BuildKit',
  }
}

export function verifyContainerArtifact({
  artifact,
  builderRunId,
  maximumBuilderAttempt,
  platformMetadata,
  repository,
  revision,
  version,
}) {
  if (!Object.values(CONTAINER_REPOSITORIES).includes(repository)) {
    throw new Error(`unexpected container repository: ${repository}`)
  }
  const identity = verificationIdentity(builderRunId, maximumBuilderAttempt)
  const publication = resolveContainerPublicationState({
    dockerHubSnapshot:
      repository === CONTAINER_REPOSITORIES.dockerHub ? artifact.inspect : null,
    ghcrSnapshot:
      repository === CONTAINER_REPOSITORIES.ghcr ? artifact.inspect : null,
    revision,
    version,
  })
  if (publication.action !== 'copy') {
    throw new Error('single-registry container artifact is incomplete')
  }
  const manifests = verifyArtifact(
    artifact,
    repository,
    revision,
    identity.builderRunId,
    identity.maximumBuilderAttempt
  )
  if (platformMetadata !== undefined) {
    verifyExpectedPlatformMetadata(
      platformMetadata,
      version,
      revision,
      manifests
    )
  }
  return {
    digest: publication.digest,
    platforms: REQUIRED_CONTAINER_PLATFORMS,
    repository,
    manifests,
    sbom: 'SPDX-2.x',
    provenance: 'SLSA BuildKit',
  }
}

function parseArgs(argv) {
  const options = {}
  const allowed = new Set([
    '--docker-hub-inspect',
    '--docker-hub-index',
    '--docker-hub-sbom',
    '--docker-hub-provenance',
    '--ghcr-inspect',
    '--ghcr-index',
    '--ghcr-sbom',
    '--ghcr-provenance',
    '--builder-run-id',
    '--maximum-builder-attempt',
    '--platform-metadata',
    '--repository',
    '--inspect',
    '--index',
    '--sbom',
    '--provenance',
    '--version',
    '--revision',
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`)
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    options[argument.slice(2)] = value
  }
  return options
}

function readArtifact(options, prefix) {
  const artifact = {}
  for (const field of ['inspect', 'index', 'sbom', 'provenance']) {
    const option = prefix ? `${prefix}-${field}` : field
    const target = options[option]
    if (!target) throw new Error(`--${option} is required`)
    const bytes = readFileSync(target)
    artifact[field] = JSON.parse(bytes.toString('utf8'))
    if (field === 'index') artifact.indexBytes = bytes
  }
  return artifact
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.version) throw new Error('--version is required')
  if (!options.revision) throw new Error('--revision is required')
  if (!options['builder-run-id'])
    throw new Error('--builder-run-id is required')
  if (!options['maximum-builder-attempt']) {
    throw new Error('--maximum-builder-attempt is required')
  }
  const common = {
    builderRunId: options['builder-run-id'],
    maximumBuilderAttempt: options['maximum-builder-attempt'],
    platformMetadata: options['platform-metadata']
      ? JSON.parse(readFileSync(options['platform-metadata'], 'utf8'))
      : undefined,
    revision: options.revision,
    version: options.version,
  }
  const result = options.repository
    ? verifyContainerArtifact({
        ...common,
        artifact: readArtifact(options, ''),
        repository: options.repository,
      })
    : verifyContainerPublication({
        ...common,
        dockerHub: readArtifact(options, 'docker-hub'),
        ghcr: readArtifact(options, 'ghcr'),
      })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
