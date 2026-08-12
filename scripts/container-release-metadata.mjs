import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseStrictSemVer } from './release-metadata.mjs'

export const CONTAINER_REPOSITORIES = Object.freeze({
  dockerHub: 'docker.io/motrixapp/motrix-server',
  ghcr: 'ghcr.io/agalwood/motrix-server',
})

export const CONTAINER_LABELS = Object.freeze({
  'org.opencontainers.image.description':
    'Motrix Server web download manager for persistent NAS deployments',
  'org.opencontainers.image.documentation':
    'https://github.com/agalwood/Motrix/blob/main/docs/docker-server.md',
  'org.opencontainers.image.licenses': 'MIT',
  'org.opencontainers.image.source': 'https://github.com/agalwood/Motrix',
  'org.opencontainers.image.title': 'Motrix Server',
  'org.opencontainers.image.url': 'https://motrix.app',
})

const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/

export function resolveContainerReleaseMetadata(version) {
  const semver = parseStrictSemVer(version, 'container release version')
  if (version.includes('+')) {
    throw new Error(
      `container release version must not contain build metadata: ${version}`
    )
  }
  if (semver.prerelease && semver.channel !== 'beta') {
    throw new Error(
      `Container prerelease channel must be beta: ${semver.version}`
    )
  }

  const [major, minor] = version.split('-', 1)[0].split('.')
  const floatingTags = semver.prerelease
    ? []
    : [`${major}.${minor}`, major, 'stable', 'latest']

  return {
    version,
    prerelease: semver.prerelease,
    immutableTag: version,
    floatingTags,
  }
}

export function resolveContainerLabels({ revision, version }) {
  if (!GIT_REVISION_PATTERN.test(revision)) {
    throw new Error(
      `container revision must be a full lowercase SHA: ${revision}`
    )
  }
  const release = resolveContainerReleaseMetadata(version)
  return {
    ...CONTAINER_LABELS,
    'org.opencontainers.image.revision': revision,
    'org.opencontainers.image.version': release.version,
  }
}

export function containerImageTags(tags) {
  return Object.values(CONTAINER_REPOSITORIES).flatMap((repository) =>
    tags.map((tag) => `${repository}:${tag}`)
  )
}

function parseArgs(argv) {
  const options = { githubOutput: process.env.GITHUB_OUTPUT }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!['--version', '--revision', '--github-output'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`)
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    if (argument === '--github-output') options.githubOutput = value
    else options[argument.slice(2)] = value
    index += 1
  }
  return options
}

function appendOutput(target, key, value) {
  const text = String(value)
  if (text.includes('\n')) {
    const delimiter = 'MOTRIX_CONTAINER_OUTPUT'
    if (text.includes(delimiter)) {
      throw new Error(`${key} contains the GitHub output delimiter`)
    }
    appendFileSync(
      target,
      `${key}<<${delimiter}\n${text}\n${delimiter}\n`,
      'utf8'
    )
    return
  }
  appendFileSync(target, `${key}=${text}\n`, 'utf8')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.version) throw new Error('--version is required')
  if (!options.revision) throw new Error('--revision is required')
  if (!options.githubOutput) {
    throw new Error('Expected --github-output or GITHUB_OUTPUT')
  }

  const metadata = resolveContainerReleaseMetadata(options.version)
  const labels = resolveContainerLabels({
    revision: options.revision,
    version: metadata.version,
  })
  appendOutput(options.githubOutput, 'container_version', metadata.version)
  appendOutput(
    options.githubOutput,
    'container_dockerhub_repository',
    CONTAINER_REPOSITORIES.dockerHub
  )
  appendOutput(
    options.githubOutput,
    'container_ghcr_repository',
    CONTAINER_REPOSITORIES.ghcr
  )
  appendOutput(
    options.githubOutput,
    'container_prerelease',
    metadata.prerelease
  )
  appendOutput(
    options.githubOutput,
    'container_immutable_tags',
    containerImageTags([metadata.immutableTag]).join('\n')
  )
  appendOutput(
    options.githubOutput,
    'container_floating_tags',
    containerImageTags(metadata.floatingTags).join('\n')
  )
  appendOutput(
    options.githubOutput,
    'container_labels',
    Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
