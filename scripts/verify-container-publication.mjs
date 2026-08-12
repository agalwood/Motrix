import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  REQUIRED_CONTAINER_PLATFORMS,
  resolveContainerPublicationState,
} from './container-publication-state.mjs'

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
  for (const descriptorValue of descriptors) {
    const descriptor = record(descriptorValue, `${repository} descriptor`)
    const platform = record(
      descriptor.platform,
      `${repository} descriptor platform`
    )
    const key = `${platform.os}/${platform.architecture}`
    if (!REQUIRED_CONTAINER_PLATFORMS.includes(key)) continue
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
    const attestations = descriptors.filter((descriptorValue) => {
      const descriptor = record(descriptorValue, `${repository} descriptor`)
      const annotations = descriptor.annotations
      return (
        annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' &&
        annotations?.['vnd.docker.reference.digest'] === subjectDigest
      )
    })
    if (attestations.length !== 1) {
      throw new Error(
        `${repository} ${platform} must have exactly one attestation manifest`
      )
    }
    digest(
      attestations[0].digest,
      `${repository} ${platform} attestation digest`
    )
  }
  return Object.fromEntries(platformDigests)
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

function verifyProvenance(provenance, repository, revision, builderIdPrefix) {
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
    if (builderIdPrefix && !builderId.startsWith(builderIdPrefix)) {
      throw new Error(`${repository} ${platform} builder identity conflicts`)
    }
  }
}

function verifyArtifact(artifact, repository, revision, builderIdPrefix) {
  const platformDigests = verifyIndex(artifact.index, repository)
  verifySbom(artifact.sbom, repository)
  verifyProvenance(artifact.provenance, repository, revision, builderIdPrefix)
  return platformDigests
}

export function verifyContainerPublication({
  builderIdPrefix,
  dockerHub,
  ghcr,
  revision,
  version,
}) {
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
  return {
    digest: publication.digest,
    platforms: REQUIRED_CONTAINER_PLATFORMS,
    dockerHub: verifyArtifact(
      dockerHub,
      'Docker Hub',
      revision,
      builderIdPrefix
    ),
    ghcr: verifyArtifact(ghcr, 'GHCR', revision, builderIdPrefix),
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
    '--builder-id-prefix',
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
    const path = options[`${prefix}-${field}`]
    if (!path) throw new Error(`--${prefix}-${field} is required`)
    artifact[field] = JSON.parse(readFileSync(path, 'utf8'))
  }
  return artifact
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.version) throw new Error('--version is required')
  if (!options.revision) throw new Error('--revision is required')
  const result = verifyContainerPublication({
    builderIdPrefix: options['builder-id-prefix'],
    dockerHub: readArtifact(options, 'docker-hub'),
    ghcr: readArtifact(options, 'ghcr'),
    revision: options.revision,
    version: options.version,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
