import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { verifyZsyncFile } from './appimage-artifact.mjs'
import { parseStrictSemVer } from './release-metadata.mjs'

const MANIFEST_PLATFORMS = [
  { suffix: '', legacyExtension: '.exe', requiredExtensions: ['.exe'] },
  { suffix: '-mac', legacyExtension: '.zip', requiredExtensions: ['.zip'] },
  {
    suffix: '-linux',
    legacyExtension: '.deb',
    requiredExtensions: ['.deb', '.rpm', '.AppImage'],
  },
  {
    suffix: '-linux-arm64',
    legacyExtension: '.deb',
    requiredExtensions: ['.deb', '.rpm', '.AppImage'],
  },
]

export async function verifyUpdateArtifacts({
  directory,
  version,
  channel = releaseChannelFromVersion(version),
  requireAll = false,
}) {
  if (!version) throw new Error('Expected release version')
  assertReleaseVersionChannel(version, channel)
  const manifestNames = expectedManifestNames(channel)
  const expectedSet = new Set(manifestNames)
  const unexpected = (await readdir(directory)).filter(
    (name) => isUpdateManifest(name) && !expectedSet.has(name)
  )
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected update manifests for ${channel}: ${unexpected.join(', ')}`
    )
  }
  const manifests = []

  for (const name of manifestNames) {
    const file = path.join(directory, name)
    try {
      await access(file)
    } catch {
      continue
    }
    const document = load(await readFile(file, 'utf8'))
    const manifest = parseManifest(name, document)
    if (manifest.version !== version) {
      throw new Error(
        `${name}: version ${manifest.version} does not match ${version}`
      )
    }
    manifests.push(manifest)
  }

  if (manifests.length === 0) {
    throw new Error(`No update manifests found in ${directory}`)
  }
  if (requireAll && manifests.length !== manifestNames.length) {
    const found = new Set(manifests.map((manifest) => manifest.name))
    const missing = manifestNames.filter((name) => !found.has(name))
    throw new Error(`Missing required update manifests: ${missing.join(', ')}`)
  }

  const verified = new Map()
  for (const manifest of manifests) {
    const platform = manifestPlatform(manifest.name)
    if (!manifest.legacyFile.url.endsWith(platform.legacyExtension)) {
      throw new Error(
        `${manifest.name}: legacy path must reference a ${platform.legacyExtension} asset`
      )
    }
    for (const extension of platform.requiredExtensions) {
      if (!manifest.files.some((file) => file.url.endsWith(extension))) {
        throw new Error(
          `${manifest.name}: a ${extension} asset is required for auto-update`
        )
      }
    }

    for (const file of manifest.files) {
      const previous = verified.get(file.url)
      if (previous) {
        if (previous.sha512 !== file.sha512 || previous.size !== file.size) {
          throw new Error(`${file.url}: metadata differs between manifests`)
        }
        continue
      }
      await verifyAsset(directory, file)
      verified.set(file.url, file)
    }
  }

  const zsyncAssets = []
  for (const name of verified.keys()) {
    if (!name.endsWith('.AppImage')) continue
    const zsync = `${name}.zsync`
    await verifyZsyncFile({
      appImagePath: path.join(directory, name),
      zsyncPath: path.join(directory, zsync),
    })
    zsyncAssets.push(zsync)
  }

  return {
    manifests: manifests.map((manifest) => manifest.name),
    assets: [...verified.keys(), ...zsyncAssets],
  }
}

function expectedManifestNames(channel) {
  const prefixes = channel === 'stable' ? ['latest', 'beta'] : ['beta']
  return prefixes.flatMap((prefix) =>
    MANIFEST_PLATFORMS.map(({ suffix }) => `${prefix}${suffix}.yml`)
  )
}

function manifestPlatform(name) {
  const prefix = name.startsWith('beta') ? 'beta' : 'latest'
  const platform = MANIFEST_PLATFORMS.find(
    ({ suffix }) => name === `${prefix}${suffix}.yml`
  )
  if (!platform) throw new Error(`${name}: unsupported update platform`)
  return platform
}

function isUpdateManifest(name) {
  return /^(?:latest|beta|alpha|rc)(?:-[a-z0-9-]+)?\.yml$/.test(name)
}

function releaseChannelFromVersion(version) {
  if (typeof version !== 'string') return 'stable'
  return parseStrictSemVer(version, 'release version').channel
}

function assertReleaseVersionChannel(version, channel) {
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error(`Unsupported release channel: ${channel}`)
  }
  const detected = releaseChannelFromVersion(version)
  if (detected !== channel) {
    throw new Error(
      `Release version ${version} belongs to ${detected}, not ${channel}`
    )
  }
}

function parseManifest(name, value) {
  if (!isRecord(value)) throw new Error(`${name}: expected a YAML object`)
  if (typeof value.version !== 'string' || value.version.length === 0) {
    throw new Error(`${name}: version is required`)
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(`${name}: files must be a non-empty array`)
  }

  const files = value.files.map((file, index) => parseFile(name, index, file))
  if (typeof value.path !== 'string' || !isSafeFlatName(value.path)) {
    throw new Error(`${name}: path is not a safe name`)
  }
  if (typeof value.sha512 !== 'string' || !isSha512(value.sha512)) {
    throw new Error(`${name}: sha512 is invalid`)
  }
  const legacyFile = files.find((file) => file.url === value.path)
  if (!legacyFile || legacyFile.sha512 !== value.sha512) {
    throw new Error(`${name}: legacy path/sha512 does not match files[]`)
  }

  return {
    name,
    version: value.version,
    files,
    legacyFile,
  }
}

function parseFile(manifestName, index, value) {
  if (!isRecord(value)) {
    throw new Error(`${manifestName}: files[${index}] must be an object`)
  }
  const url = value.url
  const sha512 = value.sha512
  const size = value.size
  if (typeof url !== 'string' || !isSafeFlatName(url)) {
    throw new Error(`${manifestName}: files[${index}].url is not a safe name`)
  }
  if (typeof sha512 !== 'string' || !isSha512(sha512)) {
    throw new Error(`${manifestName}: files[${index}].sha512 is invalid`)
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`${manifestName}: files[${index}].size is invalid`)
  }
  return { url, sha512, size }
}

async function verifyAsset(directory, file) {
  const assetPath = path.join(directory, file.url)
  const info = await stat(assetPath).catch(() => null)
  if (!info?.isFile())
    throw new Error(`${file.url}: referenced asset is missing`)
  if (info.size !== file.size) {
    throw new Error(
      `${file.url}: size ${info.size} does not match manifest ${file.size}`
    )
  }
  const actual = await sha512File(assetPath)
  if (actual !== file.sha512) {
    throw new Error(`${file.url}: sha512 does not match manifest`)
  }
}

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const input = createReadStream(file)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('base64')))
  })
}

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

function isSafeFlatName(value) {
  return (
    value === path.basename(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\\') &&
    !value.includes('\0')
  )
}

function isSha512(value) {
  try {
    return Buffer.from(value, 'base64').length === 64
  } catch {
    return false
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = path.resolve(readArg('--dir') ?? 'release')
  const version =
    readArg('--version') ?? process.env.GITHUB_REF_NAME?.replace(/^v/, '')
  const requireAll = process.argv.includes('--require-all')
  const result = await verifyUpdateArtifacts({
    directory,
    version,
    channel: readArg('--channel') ?? releaseChannelFromVersion(version),
    requireAll,
  })
  console.log(
    `Verified ${result.manifests.length} update manifest(s) and ${result.assets.length} asset(s)`
  )
}
