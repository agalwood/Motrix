import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CONTAINER_REPOSITORIES,
  resolveContainerLabels,
  resolveContainerReleaseMetadata,
} from './container-release-metadata.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const REVISION_PATTERN = /^[0-9a-f]{40}$/
const BUILDER_RUN_PATTERN =
  /^https:\/\/github\.com\/agalwood\/Motrix\/actions\/runs\/[1-9][0-9]*$/
const MEDIA_TYPE =
  'application/vnd.motrix.container-platform-build-metadata.v1+json'

export const CONTAINER_PLATFORM_MATRIX = Object.freeze({
  'linux/amd64': Object.freeze({
    artifact: 'container-build-linux-amd64',
    metadataFile: 'linux-amd64.json',
    runner: 'ubuntu-22.04',
    runnerArch: 'X64',
  }),
  'linux/arm64': Object.freeze({
    artifact: 'container-build-linux-arm64',
    metadataFile: 'linux-arm64.json',
    runner: 'ubuntu-22.04-arm',
    runnerArch: 'ARM64',
  }),
})

const REQUIRED_PLATFORMS = Object.freeze(Object.keys(CONTAINER_PLATFORM_MATRIX))
const REQUIRED_REPOSITORIES = Object.freeze(
  Object.values(CONTAINER_REPOSITORIES)
)

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(requireRecord(value, label)).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, i) => key !== wanted[i])
  ) {
    throw new Error(`${label} fields must be exactly ${wanted.join(',')}`)
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requireDigest(value, label) {
  const result = requireString(value, label)
  if (!DIGEST_PATTERN.test(result)) {
    throw new Error(`${label} must be a sha256 digest`)
  }
  return result
}

function requirePositiveInteger(value, label) {
  const text =
    typeof value === 'number' ? String(value) : requireString(value, label)
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${label} must be a positive integer`)
  }
  const result = Number(text)
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} must be a safe integer`)
  }
  return result
}

function validateIdentity({ builderAttempt, builderRunId, revision, version }) {
  resolveContainerReleaseMetadata(requireString(version, 'container version'))
  if (!REVISION_PATTERN.test(requireString(revision, 'container revision'))) {
    throw new Error('container revision must be a full lowercase SHA')
  }
  if (
    !BUILDER_RUN_PATTERN.test(requireString(builderRunId, 'builder run id'))
  ) {
    throw new Error(
      'builder run id must be the exact Motrix GitHub Actions run URL'
    )
  }
  return {
    builderAttempt: requirePositiveInteger(builderAttempt, 'builder attempt'),
    builderRunId,
    revision,
    version,
  }
}

function platformParts(platform) {
  const [os, architecture] = platform.split('/')
  return { architecture, os }
}

function resolveInspectedImage(images, repository, platform) {
  const flatFields = ['architecture', 'config', 'os']
  const isFlatImage = flatFields.some((field) => Object.hasOwn(images, field))
  const platformKeys = Object.keys(images).filter((key) => key.includes('/'))
  if (isFlatImage) {
    if (platformKeys.length > 0) {
      throw new Error(`${repository} inspection image shape is ambiguous`)
    }
    return images
  }

  const expectedKeys = Object.keys(images).filter(
    (key) => key !== 'unknown/unknown'
  )
  if (expectedKeys.length !== 1 || expectedKeys[0] !== platform) {
    throw new Error(`${repository} inspection must contain exactly ${platform}`)
  }
  return requireRecord(
    images[platform],
    `${repository} ${platform} inspected image`
  )
}

function requireInspectedPlatform(image, repository, platform) {
  const expected = platformParts(platform)
  const observed = []
  if (Object.hasOwn(image, 'architecture') || Object.hasOwn(image, 'os')) {
    observed.push({
      architecture: requireString(
        image.architecture,
        `${repository} inspected image architecture`
      ),
      os: requireString(image.os, `${repository} inspected image OS`),
    })
  }
  if (image.platform !== undefined) {
    const nested = requireRecord(
      image.platform,
      `${repository} inspected image platform`
    )
    observed.push({
      architecture: requireString(
        nested.architecture,
        `${repository} inspected platform architecture`
      ),
      os: requireString(nested.os, `${repository} inspected platform OS`),
    })
  }
  if (observed.length === 0) {
    throw new Error(`${repository} inspected image platform is missing`)
  }
  if (
    observed.some(
      (value) =>
        value.architecture !== expected.architecture || value.os !== expected.os
    )
  ) {
    throw new Error(`${repository} inspected platform conflicts`)
  }
}

function inspectPlatformIndex(bytes, repository, platform, sourceDigest) {
  const candidates = [bytes]
  if (bytes.at(-1) === 0x0a) candidates.push(bytes.subarray(0, -1))
  const manifestBytes = candidates.find(
    (candidate) =>
      `sha256:${createHash('sha256').update(candidate).digest('hex')}` ===
      sourceDigest
  )
  if (!manifestBytes) {
    throw new Error(`${repository} raw index digest conflicts`)
  }
  const index = requireRecord(
    JSON.parse(manifestBytes.toString('utf8')),
    `${repository} platform index`
  )
  if (
    index.schemaVersion !== 2 ||
    ![
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.index.v1+json',
    ].includes(index.mediaType)
  ) {
    throw new Error(`${repository} platform build must be an OCI image index`)
  }
  if (!Array.isArray(index.manifests) || index.manifests.length !== 2) {
    throw new Error(
      `${repository} platform index must contain one image and one attestation`
    )
  }
  let image
  let attestation
  for (const value of index.manifests) {
    const descriptor = requireRecord(value, `${repository} descriptor`)
    const descriptorPlatform = requireRecord(
      descriptor.platform,
      `${repository} descriptor platform`
    )
    const key = `${descriptorPlatform.os}/${descriptorPlatform.architecture}`
    if (
      descriptor.annotations?.['vnd.docker.reference.type'] ===
      'attestation-manifest'
    ) {
      if (attestation) {
        throw new Error(`${repository} has duplicate attestation manifests`)
      }
      attestation = descriptor
    } else if (key === platform) {
      if (image)
        throw new Error(`${repository} has duplicate ${platform} images`)
      image = descriptor
    } else {
      throw new Error(`${repository} platform index contains unexpected ${key}`)
    }
  }
  if (!image || !attestation) {
    throw new Error(`${repository} platform index is incomplete`)
  }
  const imageDigest = requireDigest(
    image.digest,
    `${repository} ${platform} image digest`
  )
  const attestationDigest = requireDigest(
    attestation.digest,
    `${repository} ${platform} attestation digest`
  )
  if (
    attestation.annotations?.['vnd.docker.reference.digest'] !== imageDigest
  ) {
    throw new Error(`${repository} attestation subject conflicts`)
  }
  return { attestationDigest, imageDigest }
}

function inspectPlatformConfig(
  snapshot,
  repository,
  platform,
  sourceDigest,
  labels
) {
  const document = requireRecord(snapshot, `${repository} inspection`)
  if (document.manifest?.digest !== sourceDigest) {
    throw new Error(`${repository} inspected digest conflicts`)
  }
  const images = requireRecord(document.image, `${repository} inspected images`)
  const image = resolveInspectedImage(images, repository, platform)
  requireInspectedPlatform(image, repository, platform)
  const config = requireRecord(image.config, `${repository} ${platform} config`)
  if (config.User !== 'node') {
    throw new Error(`${repository} ${platform} default user is not node`)
  }
  const actualLabels = requireRecord(
    config.Labels,
    `${repository} ${platform} labels`
  )
  for (const [key, expected] of Object.entries(labels)) {
    if (actualLabels[key] !== expected) {
      throw new Error(`${repository} ${platform} label ${key} conflicts`)
    }
  }
}

export function inspectContainerPlatformPublication({
  digest: sourceDigest,
  dockerHubIndex,
  dockerHubInspect,
  ghcrIndex,
  ghcrInspect,
  platform,
  revision,
  version,
}) {
  if (!CONTAINER_PLATFORM_MATRIX[platform]) {
    throw new Error(`unsupported container platform: ${platform}`)
  }
  requireDigest(sourceDigest, 'platform source digest')
  const labels = resolveContainerLabels({ revision, version })
  const artifacts = [
    [CONTAINER_REPOSITORIES.dockerHub, dockerHubIndex, dockerHubInspect],
    [CONTAINER_REPOSITORIES.ghcr, ghcrIndex, ghcrInspect],
  ].map(([repository, index, inspect]) => {
    const manifests = inspectPlatformIndex(
      index,
      repository,
      platform,
      sourceDigest
    )
    inspectPlatformConfig(inspect, repository, platform, sourceDigest, labels)
    return { repository, ...manifests }
  })
  if (
    artifacts[0].imageDigest !== artifacts[1].imageDigest ||
    artifacts[0].attestationDigest !== artifacts[1].attestationDigest
  ) {
    throw new Error('platform manifests disagree across registries')
  }
  return {
    imageDigest: artifacts[0].imageDigest,
    attestationDigest: artifacts[0].attestationDigest,
  }
}

export function createContainerPlatformMetadata({
  attestationDigest,
  builderAttempt,
  builderRunId,
  digest,
  imageDigest,
  platform,
  revision,
  runnerArch,
  runnerEnvironment,
  runnerOs,
  version,
}) {
  const expected = CONTAINER_PLATFORM_MATRIX[platform]
  if (!expected) {
    throw new Error(`unsupported container platform: ${platform}`)
  }
  const identity = validateIdentity({
    builderAttempt,
    builderRunId,
    revision,
    version,
  })
  const sourceDigest = requireDigest(digest, 'platform source digest')
  if (runnerEnvironment !== 'github-hosted') {
    throw new Error('container builds require a GitHub-hosted runner')
  }
  if (runnerOs !== 'Linux') {
    throw new Error('container builds require a Linux runner')
  }
  if (runnerArch !== expected.runnerArch) {
    throw new Error(
      `${platform} requires native runner architecture ${expected.runnerArch}, got ${runnerArch}`
    )
  }

  return {
    schemaVersion: 1,
    mediaType: MEDIA_TYPE,
    platform,
    digest: sourceDigest,
    manifests: {
      image: requireDigest(imageDigest, 'image manifest digest'),
      attestation: requireDigest(
        attestationDigest,
        'attestation manifest digest'
      ),
    },
    version: identity.version,
    revision: identity.revision,
    builder: {
      runId: identity.builderRunId,
      attempt: identity.builderAttempt,
      runner: expected.runner,
      runnerArch,
      runnerEnvironment,
      runnerOs,
    },
    repositories: Object.fromEntries(
      REQUIRED_REPOSITORIES.map((repository) => [repository, sourceDigest])
    ),
    verification: {
      anonymousPull: [...REQUIRED_REPOSITORIES],
      smoke: 'full',
    },
  }
}

function validateContainerPlatformMetadata(
  value,
  { builderRunId, maximumBuilderAttempt, revision, version }
) {
  const metadata = requireRecord(value, 'platform metadata')
  requireExactKeys(
    metadata,
    [
      'builder',
      'digest',
      'manifests',
      'mediaType',
      'platform',
      'repositories',
      'revision',
      'schemaVersion',
      'verification',
      'version',
    ],
    'platform metadata'
  )
  if (metadata.schemaVersion !== 1 || metadata.mediaType !== MEDIA_TYPE) {
    throw new Error('platform metadata schema conflicts')
  }
  const platform = requireString(metadata.platform, 'platform')
  const expected = CONTAINER_PLATFORM_MATRIX[platform]
  if (!expected) throw new Error(`unexpected container platform: ${platform}`)
  const sourceDigest = requireDigest(metadata.digest, `${platform} digest`)
  const manifests = requireRecord(metadata.manifests, `${platform} manifests`)
  requireExactKeys(manifests, ['attestation', 'image'], `${platform} manifests`)
  requireDigest(manifests.image, `${platform} image manifest digest`)
  requireDigest(
    manifests.attestation,
    `${platform} attestation manifest digest`
  )
  if (metadata.version !== version || metadata.revision !== revision) {
    throw new Error(`${platform} version or revision conflicts`)
  }

  const builder = requireRecord(metadata.builder, `${platform} builder`)
  requireExactKeys(
    builder,
    [
      'attempt',
      'runId',
      'runner',
      'runnerArch',
      'runnerEnvironment',
      'runnerOs',
    ],
    `${platform} builder`
  )
  if (
    builder.runId !== builderRunId ||
    builder.runner !== expected.runner ||
    builder.runnerArch !== expected.runnerArch ||
    builder.runnerEnvironment !== 'github-hosted' ||
    builder.runnerOs !== 'Linux'
  ) {
    throw new Error(`${platform} builder identity conflicts`)
  }
  const attempt = requirePositiveInteger(
    builder.attempt,
    `${platform} builder attempt`
  )
  if (attempt > maximumBuilderAttempt) {
    throw new Error(`${platform} builder attempt is from the future`)
  }

  const repositories = requireRecord(
    metadata.repositories,
    `${platform} repositories`
  )
  requireExactKeys(
    repositories,
    REQUIRED_REPOSITORIES,
    `${platform} repositories`
  )
  for (const repository of REQUIRED_REPOSITORIES) {
    if (repositories[repository] !== sourceDigest) {
      throw new Error(`${platform} ${repository} digest conflicts`)
    }
  }

  const verification = requireRecord(
    metadata.verification,
    `${platform} verification`
  )
  requireExactKeys(
    verification,
    ['anonymousPull', 'smoke'],
    `${platform} verification`
  )
  if (verification.smoke !== 'full') {
    throw new Error(`${platform} did not complete the full runtime smoke`)
  }
  if (
    !Array.isArray(verification.anonymousPull) ||
    verification.anonymousPull.length !== REQUIRED_REPOSITORIES.length ||
    verification.anonymousPull.some(
      (repository, index) => repository !== REQUIRED_REPOSITORIES[index]
    )
  ) {
    throw new Error(`${platform} anonymous registry pulls are incomplete`)
  }
  return metadata
}

async function listMetadataFiles(root) {
  const resolvedRoot = await realpath(root)
  const rootStat = await lstat(resolvedRoot)
  if (!rootStat.isDirectory())
    throw new Error('metadata directory is not a directory')
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(
          `metadata directory contains a symbolic link: ${entry.name}`
        )
      }
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) files.push(target)
      else
        throw new Error(
          `metadata directory contains a non-regular entry: ${entry.name}`
        )
    }
  }
  await visit(resolvedRoot)
  return files.sort()
}

export async function verifyContainerPlatformMetadataSet({
  builderRunId,
  directory,
  maximumBuilderAttempt,
  revision,
  version,
}) {
  const identity = validateIdentity({
    builderAttempt: maximumBuilderAttempt,
    builderRunId,
    revision,
    version,
  })
  const files = await listMetadataFiles(directory)
  if (files.length !== REQUIRED_PLATFORMS.length) {
    throw new Error(
      `container platform metadata must contain exactly ${REQUIRED_PLATFORMS.length} files`
    )
  }
  const platforms = new Map()
  for (const file of files) {
    if (path.extname(file) !== '.json') {
      throw new Error(
        `unexpected container metadata file: ${path.basename(file)}`
      )
    }
    const metadata = validateContainerPlatformMetadata(
      JSON.parse(await readFile(file, 'utf8')),
      {
        builderRunId: identity.builderRunId,
        maximumBuilderAttempt: identity.builderAttempt,
        revision: identity.revision,
        version: identity.version,
      }
    )
    const expectedFile =
      CONTAINER_PLATFORM_MATRIX[metadata.platform].metadataFile
    if (path.basename(file) !== expectedFile) {
      throw new Error(
        `${metadata.platform} metadata file must be ${expectedFile}`
      )
    }
    if (platforms.has(metadata.platform)) {
      throw new Error(`duplicate container metadata for ${metadata.platform}`)
    }
    platforms.set(metadata.platform, metadata)
  }
  for (const platform of REQUIRED_PLATFORMS) {
    if (!platforms.has(platform)) {
      throw new Error(`missing container metadata for ${platform}`)
    }
  }
  const digests = REQUIRED_PLATFORMS.map(
    (platform) => platforms.get(platform).digest
  )
  if (new Set(digests).size !== digests.length) {
    throw new Error('container platforms must not share an image digest')
  }
  return {
    schemaVersion: 1,
    version: identity.version,
    revision: identity.revision,
    builderRunId: identity.builderRunId,
    maximumBuilderAttempt: identity.builderAttempt,
    platforms: Object.fromEntries(
      REQUIRED_PLATFORMS.map((platform) => [
        platform,
        {
          digest: platforms.get(platform).digest,
          manifests: platforms.get(platform).manifests,
        },
      ])
    ),
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!['create', 'verify-set'].includes(command)) {
    throw new Error('Expected create or verify-set command')
  }
  const options = { command, githubOutput: process.env.GITHUB_OUTPUT }
  const allowed = new Set([
    '--builder-attempt',
    '--builder-run-id',
    '--digest',
    '--docker-hub-index',
    '--docker-hub-inspect',
    '--github-output',
    '--ghcr-index',
    '--ghcr-inspect',
    '--metadata-dir',
    '--output',
    '--platform',
    '--revision',
    '--runner-arch',
    '--runner-environment',
    '--runner-os',
    '--version',
  ])
  for (let index = 0; index < rest.length; index += 2) {
    const argument = rest[index]
    const value = rest[index + 1]
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`)
    if (!value || value.startsWith('--'))
      throw new Error(`${argument} requires a value`)
    const key = argument
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    options[key] = value
  }
  return options
}

function requireOptions(options, keys) {
  for (const key of keys) {
    if (!options[key])
      throw new Error(
        `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`
      )
  }
}

function appendOutput(target, key, value) {
  appendFileSync(target, `${key}=${value}\n`, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'create') {
    requireOptions(options, [
      'builderAttempt',
      'builderRunId',
      'digest',
      'dockerHubIndex',
      'dockerHubInspect',
      'ghcrIndex',
      'ghcrInspect',
      'output',
      'platform',
      'revision',
      'runnerArch',
      'runnerEnvironment',
      'runnerOs',
      'version',
    ])
    const publication = inspectContainerPlatformPublication({
      digest: options.digest,
      dockerHubIndex: await readFile(options.dockerHubIndex),
      dockerHubInspect: JSON.parse(
        await readFile(options.dockerHubInspect, 'utf8')
      ),
      ghcrIndex: await readFile(options.ghcrIndex),
      ghcrInspect: JSON.parse(await readFile(options.ghcrInspect, 'utf8')),
      platform: options.platform,
      revision: options.revision,
      version: options.version,
    })
    const metadata = createContainerPlatformMetadata({
      ...options,
      ...publication,
    })
    await writeFile(options.output, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return
  }

  requireOptions(options, [
    'builderAttempt',
    'builderRunId',
    'metadataDir',
    'output',
    'revision',
    'version',
  ])
  const metadata = await verifyContainerPlatformMetadataSet({
    builderRunId: options.builderRunId,
    directory: options.metadataDir,
    maximumBuilderAttempt: options.builderAttempt,
    revision: options.revision,
    version: options.version,
  })
  await writeFile(options.output, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  if (options.githubOutput) {
    appendOutput(
      options.githubOutput,
      'amd64_digest',
      metadata.platforms['linux/amd64'].digest
    )
    appendOutput(
      options.githubOutput,
      'arm64_digest',
      metadata.platforms['linux/arm64'].digest
    )
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
