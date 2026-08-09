import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseStrictSemVer(version, label = 'version') {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }

  const match = STRICT_SEMVER_PATTERN.exec(version)
  if (!match) {
    throw new Error(`${label} must be strict SemVer: ${version}`)
  }

  return {
    version,
    prerelease: match[4] !== undefined,
    channel: match[4]?.split('.')[0] ?? 'stable',
  }
}

export function resolveReleaseMetadata({
  eventName,
  refName,
  refProtected,
  packageVersion,
}) {
  const packageMetadata = parseStrictSemVer(
    packageVersion,
    'package.json version'
  )
  assertMacUpdaterSafeVersion(packageMetadata.version)
  assertSupportedReleaseChannel(packageMetadata)

  if (eventName === 'workflow_dispatch') {
    return packageMetadata
  }

  if (eventName !== 'push') {
    throw new Error(`Unsupported release event: ${eventName}`)
  }
  if (typeof refName !== 'string' || !refName.startsWith('v')) {
    throw new Error(`Release tag must start with v: ${refName}`)
  }

  const tagVersion = refName.slice(1)
  const tagMetadata = parseStrictSemVer(tagVersion, 'release tag')
  assertSupportedReleaseChannel(tagMetadata)
  if (tagVersion !== packageVersion) {
    throw new Error(
      `Release tag version ${tagVersion} does not match package.json version ${packageVersion}`
    )
  }
  if (refProtected !== true && refProtected !== 'true') {
    throw new Error(`Release tag ${refName} is not protected by a ruleset`)
  }

  return tagMetadata
}

function assertSupportedReleaseChannel(metadata) {
  if (metadata.channel !== 'stable' && metadata.channel !== 'beta') {
    throw new Error(
      `Release prerelease channel must be beta: ${metadata.version}`
    )
  }
}

function assertMacUpdaterSafeVersion(version) {
  if (version.includes('arm64')) {
    throw new Error(
      'package.json version must not contain lowercase "arm64": ' +
        'electron-updater matches that substring anywhere in the full macOS ' +
        'artifact URL, making x64 and arm64 update assets ambiguous'
    )
  }
}

function parseArgs(argv) {
  const options = {
    packageJson: 'package.json',
    githubOutput: process.env.GITHUB_OUTPUT,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--package-json') {
      options.packageJson = requiredValue(argv, ++index, argument)
    } else if (argument === '--github-output') {
      options.githubOutput = requiredValue(argv, ++index, argument)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  return options
}

function requiredValue(argv, index, option) {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.githubOutput) {
    throw new Error('Expected --github-output or GITHUB_OUTPUT')
  }

  const packageJson = JSON.parse(readFileSync(options.packageJson, 'utf8'))
  const metadata = resolveReleaseMetadata({
    eventName: process.env.RELEASE_EVENT_NAME ?? process.env.GITHUB_EVENT_NAME,
    refName: process.env.RELEASE_REF_NAME ?? process.env.GITHUB_REF_NAME,
    refProtected:
      process.env.RELEASE_REF_PROTECTED ?? process.env.GITHUB_REF_PROTECTED,
    packageVersion: packageJson.version,
  })

  appendFileSync(
    options.githubOutput,
    `version=${metadata.version}\nprerelease=${metadata.prerelease}\nchannel=${metadata.channel}\n`,
    'utf8'
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
