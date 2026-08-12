import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  CONTAINER_REPOSITORIES,
  resolveContainerLabels,
  resolveContainerReleaseMetadata,
} from './container-release-metadata.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
export const REQUIRED_CONTAINER_PLATFORMS = Object.freeze([
  'linux/amd64',
  'linux/arm64',
])

function inspectedImage(snapshot, repository, revision, version) {
  if (snapshot === null || snapshot === undefined) return undefined
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`${repository} inspection must be an object or null`)
  }

  const digest = snapshot.manifest?.digest
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    throw new Error(`${repository} immutable tag has no valid index digest`)
  }
  for (const platform of REQUIRED_CONTAINER_PLATFORMS) {
    const image = snapshot.image?.[platform]
    if (!image || typeof image !== 'object') {
      throw new Error(`${repository} immutable tag is missing ${platform}`)
    }
    const labels = image.config?.Labels
    if (!labels || typeof labels !== 'object') {
      throw new Error(`${repository} ${platform} has no OCI labels`)
    }
    const expectedLabels = resolveContainerLabels({ revision, version })
    for (const [key, expected] of Object.entries(expectedLabels)) {
      if (labels[key] !== expected) {
        throw new Error(
          `${repository} immutable tag conflicts at ${platform} label ${key}`
        )
      }
    }
    if (image.config?.User !== 'node') {
      throw new Error(`${repository} ${platform} default user is not node`)
    }
  }
  return { digest, repository }
}

export function resolveContainerPublicationState({
  dockerHubSnapshot,
  ghcrSnapshot,
  revision,
  version,
}) {
  resolveContainerReleaseMetadata(version)
  const dockerHub = inspectedImage(
    dockerHubSnapshot,
    CONTAINER_REPOSITORIES.dockerHub,
    revision,
    version
  )
  const ghcr = inspectedImage(
    ghcrSnapshot,
    CONTAINER_REPOSITORIES.ghcr,
    revision,
    version
  )

  if (!dockerHub && !ghcr) {
    return { action: 'build', digest: '', copySource: '', copyTarget: '' }
  }
  if (dockerHub && ghcr) {
    if (dockerHub.digest !== ghcr.digest) {
      throw new Error(
        `Immutable container tags disagree: ${dockerHub.digest} != ${ghcr.digest}`
      )
    }
    return {
      action: 'resume',
      digest: dockerHub.digest,
      copySource: '',
      copyTarget: '',
    }
  }

  const existing = dockerHub ?? ghcr
  const missingRepository = dockerHub
    ? CONTAINER_REPOSITORIES.ghcr
    : CONTAINER_REPOSITORIES.dockerHub
  return {
    action: 'copy',
    digest: existing.digest,
    copySource: `${existing.repository}@${existing.digest}`,
    copyTarget: `${missingRepository}:${version}`,
  }
}

function parseArgs(argv) {
  const options = { githubOutput: process.env.GITHUB_OUTPUT }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (
      ![
        '--docker-hub-snapshot',
        '--ghcr-snapshot',
        '--version',
        '--revision',
        '--github-output',
      ].includes(argument)
    ) {
      throw new Error(`Unknown argument: ${argument}`)
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    if (argument === '--docker-hub-snapshot') options.dockerHubSnapshot = value
    else if (argument === '--ghcr-snapshot') options.ghcrSnapshot = value
    else if (argument === '--github-output') options.githubOutput = value
    else options[argument.slice(2)] = value
    index += 1
  }
  return options
}

function readSnapshot(target) {
  return JSON.parse(readFileSync(target, 'utf8'))
}

function appendOutput(target, key, value) {
  appendFileSync(target, `${key}=${value}\n`, 'utf8')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  for (const key of [
    'dockerHubSnapshot',
    'ghcrSnapshot',
    'version',
    'revision',
  ]) {
    if (!options[key]) throw new Error(`${key} is required`)
  }
  const state = resolveContainerPublicationState({
    dockerHubSnapshot: readSnapshot(options.dockerHubSnapshot),
    ghcrSnapshot: readSnapshot(options.ghcrSnapshot),
    revision: options.revision,
    version: options.version,
  })
  if (!options.githubOutput) {
    process.stdout.write(`${JSON.stringify(state)}\n`)
    return
  }
  appendOutput(options.githubOutput, 'publication_action', state.action)
  appendOutput(options.githubOutput, 'publication_digest', state.digest)
  appendOutput(options.githubOutput, 'copy_source', state.copySource)
  appendOutput(options.githubOutput, 'copy_target', state.copyTarget)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
