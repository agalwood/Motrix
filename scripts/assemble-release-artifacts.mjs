import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'

import { flatpakCompanionArchiveName } from '../packages/native-host/package-flatpak-companion.mjs'
import { parseStrictSemVer } from './release-metadata.mjs'

export const RELEASE_TARGETS = [
  {
    name: 'darwin-arm64',
    manifestName: 'latest-mac.yml',
    betaManifestName: 'beta-mac.yml',
    assetNames: (version) => [
      `Motrix-${version}-arm64.dmg`,
      `Motrix-${version}-arm64.zip`,
    ],
    sourceManifestAssetNames: (version) => [
      `Motrix-${version}-arm64.zip`,
      `Motrix-${version}-arm64.dmg`,
    ],
    manifestAssetNames: (version) => [`Motrix-${version}-arm64.zip`],
    legacyAssetName: (version) => `Motrix-${version}-arm64.zip`,
  },
  {
    name: 'darwin-x64',
    manifestName: 'latest-mac.yml',
    betaManifestName: 'beta-mac.yml',
    assetNames: (version) => [
      `Motrix-${version}-x64.dmg`,
      `Motrix-${version}-x64.zip`,
    ],
    sourceManifestAssetNames: (version) => [
      `Motrix-${version}-x64.zip`,
      `Motrix-${version}-x64.dmg`,
    ],
    manifestAssetNames: (version) => [`Motrix-${version}-x64.zip`],
    legacyAssetName: (version) => `Motrix-${version}-x64.zip`,
  },
  {
    name: 'linux-x64',
    manifestName: 'latest-linux.yml',
    betaManifestName: 'beta-linux.yml',
    assetNames: (version) => [
      `Motrix_${version}_amd64.deb`,
      `Motrix-${version}.x86_64.rpm`,
      `Motrix-${version}-x86_64.AppImage`,
      `Motrix-${version}-x86_64.AppImage.zsync`,
      flatpakCompanionArchiveName(version, 'x64'),
    ],
    manifestAssetNames: (version) => [
      `Motrix_${version}_amd64.deb`,
      `Motrix-${version}.x86_64.rpm`,
      `Motrix-${version}-x86_64.AppImage`,
    ],
    legacyAssetName: (version) => `Motrix_${version}_amd64.deb`,
  },
  {
    name: 'linux-arm64',
    manifestName: 'latest-linux-arm64.yml',
    betaManifestName: 'beta-linux-arm64.yml',
    assetNames: (version) => [
      `Motrix_${version}_arm64.deb`,
      `Motrix-${version}.aarch64.rpm`,
      `Motrix-${version}-arm64.AppImage`,
      `Motrix-${version}-arm64.AppImage.zsync`,
      flatpakCompanionArchiveName(version, 'arm64'),
    ],
    manifestAssetNames: (version) => [
      `Motrix_${version}_arm64.deb`,
      `Motrix-${version}.aarch64.rpm`,
      `Motrix-${version}-arm64.AppImage`,
    ],
    legacyAssetName: (version) => `Motrix_${version}_arm64.deb`,
  },
  {
    name: 'win32-x64',
    manifestName: 'latest.yml',
    betaManifestName: 'beta.yml',
    assetNames: (version) => [
      `Motrix-Setup-${version}.exe`,
      `Motrix-${version}-win.zip`,
    ],
    manifestAssetNames: (version) => [`Motrix-Setup-${version}.exe`],
    legacyAssetName: (version) => `Motrix-Setup-${version}.exe`,
  },
]

const RELEASE_ASSET_EXTENSIONS = [
  '.AppImage',
  '.blockmap',
  '.deb',
  '.dmg',
  '.exe',
  '.rpm',
  '.snap',
  '.tar.gz',
  '.zip',
  '.zsync',
]

export async function assembleReleaseArtifacts({
  inputDirectory,
  outputDirectory,
  version,
  channel = releaseChannelFromVersion(version),
}) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('Expected release version')
  }
  assertReleaseVersionChannel(version, channel)

  const inputRoot = path.resolve(inputDirectory)
  const outputRoot = path.resolve(outputDirectory)
  const targetResults = []

  for (const target of RELEASE_TARGETS) {
    const directory = path.join(inputRoot, `release-input-${target.name}`)
    const manifestNames = targetManifestNames(target, channel)
    const files = await collectTargetFiles(
      directory,
      target,
      version,
      manifestNames
    )
    const assets = [...files.values()].filter((file) => file.kind === 'asset')
    assertRequiredAssets(target, assets, version)
    const manifests = new Map()
    for (const manifestName of manifestNames) {
      const manifestFile = files.get(manifestName.toLowerCase())
      if (!manifestFile) {
        throw new Error(
          `${target.name}: required manifest ${manifestName} is missing`
        )
      }

      const manifest = parseManifest(
        manifestName,
        load(await readFile(manifestFile.source, 'utf8'))
      )
      if (manifest.version !== version) {
        throw new Error(
          `${target.name}/${manifestName}: version ${manifest.version} does not match ${version}`
        )
      }
      const verifiedManifest = await verifyManifestAssets(
        target,
        manifest,
        files,
        version,
        manifestName
      )
      manifests.set(manifestName, verifiedManifest)
    }

    targetResults.push({
      ...target,
      directory,
      files,
      manifests,
    })
  }

  assertOutputOutsideInputs(
    outputRoot,
    targetResults.map((target) => target.directory)
  )

  const outputFiles = new Map()
  for (const target of targetResults) {
    for (const file of target.files.values()) {
      if (file.kind !== 'asset') continue
      addOutputFile(outputFiles, file.name, {
        kind: 'copy',
        source: file.source,
        target: target.name,
      })
    }
  }

  const macArm64 = targetResults.find(
    (target) => target.name === 'darwin-arm64'
  )
  const macX64 = targetResults.find((target) => target.name === 'darwin-x64')
  for (const manifestName of targetManifestNames(macX64, channel)) {
    const macManifest = mergeMacManifests(
      macX64.manifests.get(manifestName),
      macArm64.manifests.get(manifestName),
      manifestName
    )
    addOutputFile(outputFiles, manifestName, {
      kind: 'content',
      content: dump(macManifest, {
        lineWidth: -1,
        noRefs: true,
        sortKeys: false,
      }),
      target: 'darwin',
    })
  }

  for (const target of targetResults) {
    if (target.name.startsWith('darwin-')) continue
    for (const manifestName of targetManifestNames(target, channel)) {
      const manifest = target.manifests.get(manifestName)
      addOutputFile(outputFiles, manifestName, {
        kind: 'content',
        content: dump(manifest.document, {
          lineWidth: -1,
          noRefs: true,
          sortKeys: false,
        }),
        target: target.name,
      })
    }
  }

  await ensureEmptyOutputDirectory(outputRoot)
  for (const file of outputFiles.values()) {
    const destination = path.join(outputRoot, file.name)
    if (file.kind === 'copy') {
      await copyFile(file.source, destination, constants.COPYFILE_EXCL)
    } else {
      const handle = await open(destination, 'wx')
      try {
        await handle.writeFile(file.content, 'utf8')
      } finally {
        await handle.close()
      }
    }
  }

  const outputNames = [...outputFiles.values()].map((file) => file.name)
  const manifests = outputNames.filter((name) => isUpdateManifest(name))
  const assets = outputNames.filter((name) => !isUpdateManifest(name))
  return {
    targets: RELEASE_TARGETS.map((target) => target.name),
    manifests,
    assets,
  }
}

function targetManifestNames(target, channel) {
  return channel === 'stable'
    ? [target.manifestName, target.betaManifestName]
    : [target.betaManifestName]
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

async function collectTargetFiles(directory, target, version, manifestNames) {
  const directoryInfo = await stat(directory).catch(() => null)
  if (!directoryInfo?.isDirectory()) {
    throw new Error(`${target.name}: input directory ${directory} is missing`)
  }

  const candidates = await walkFiles(directory)
  const selected = new Map()
  const requiredAssets = new Set(target.assetNames(version))
  const optionalBlockmaps = new Set(
    [...requiredAssets]
      .filter((name) => /\.(?:dmg|exe|zip)$/u.test(name))
      .map((name) => `${name}.blockmap`)
  )
  for (const source of candidates) {
    const name = path.basename(source)
    if (!isSafeFlatName(name)) {
      throw new Error(`${target.name}: ${name} is not a safe basename`)
    }
    const kind = classifyFile(name)
    if (!kind) continue
    if (kind === 'manifest' && !manifestNames.includes(name)) {
      throw new Error(
        `${target.name}: unexpected update manifest ${name}; expected ${manifestNames.join(', ')}`
      )
    }
    if (
      kind === 'asset' &&
      !requiredAssets.has(name) &&
      !optionalBlockmaps.has(name)
    ) {
      throw new Error(
        `${target.name}: unexpected release asset ${name}; expected ${[
          ...requiredAssets,
        ].join(', ')}`
      )
    }

    const key = name.toLowerCase()
    const previous = selected.get(key)
    if (previous) {
      throw new Error(
        `${target.name}: duplicate basename ${name} conflicts with ${previous.name}`
      )
    }
    selected.set(key, { kind, name, source })
  }
  return selected
}

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const files = []
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(file)))
    } else if (entry.isFile()) {
      files.push(file)
    } else if (classifyFile(entry.name)) {
      throw new Error(`${file}: release input must be a regular file`)
    }
  }
  return files
}

function classifyFile(name) {
  if (isUpdateManifest(name)) return 'manifest'
  if (RELEASE_ASSET_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'asset'
  }
  return null
}

function isUpdateManifest(name) {
  return /^(?:latest|beta|alpha|rc)(?:-[a-z0-9-]+)?\.yml$/.test(name)
}

function assertRequiredAssets(target, assets, version) {
  const names = new Set(assets.map((file) => file.name))
  for (const required of target.assetNames(version)) {
    if (!names.has(required)) {
      throw new Error(
        `${target.name}: required release asset ${required} is missing`
      )
    }
  }
}

async function verifyManifestAssets(
  target,
  manifest,
  files,
  version,
  manifestName
) {
  const expectedNames = target.manifestAssetNames(version)
  const allowedSourceNames =
    target.sourceManifestAssetNames?.(version) ?? expectedNames
  const allowedByName = new Map(
    allowedSourceNames.map((name) => [name.toLowerCase(), name])
  )
  const uniqueFiles = new Map()

  const expectedLegacyName = target.legacyAssetName(version)

  for (const file of manifest.files) {
    const key = file.url.toLowerCase()
    const allowedName = allowedByName.get(key)
    if (!allowedName || allowedName !== file.url) {
      throw new Error(
        `${target.name}/${manifestName}: files[] contains unexpected asset ${file.url}; expected only ${allowedSourceNames.join(', ')}`
      )
    }

    const previous = uniqueFiles.get(key)
    if (previous) {
      if (
        previous.url !== file.url ||
        previous.sha512 !== file.sha512 ||
        previous.size !== file.size
      ) {
        throw new Error(
          `${target.name}/${manifestName}: duplicate manifest asset ${file.url} has conflicting metadata`
        )
      }
    } else {
      uniqueFiles.set(key, file)
    }

    const input = files.get(file.url.toLowerCase())
    if (input?.kind !== 'asset' || input.name !== file.url) {
      throw new Error(
        `${target.name}/${manifestName}: referenced asset ${file.url} is missing`
      )
    }
    const info = await stat(input.source)
    if (info.size !== file.size) {
      throw new Error(
        `${target.name}/${manifestName}: ${file.url} size does not match manifest`
      )
    }
    const actual = await sha512File(input.source)
    if (actual !== file.sha512) {
      throw new Error(
        `${target.name}/${manifestName}: ${file.url} sha512 does not match manifest`
      )
    }
  }

  const canonicalFiles = expectedNames.map((name) =>
    uniqueFiles.get(name.toLowerCase())
  )
  if (canonicalFiles.some((file) => !file)) {
    throw new Error(
      `${target.name}/${manifestName}: files[] must contain ${expectedNames.join(', ')}`
    )
  }
  const canonicalLegacy = uniqueFiles.get(expectedLegacyName.toLowerCase())

  return {
    ...manifest,
    document: {
      ...manifest.document,
      files: canonicalFiles,
      path: expectedLegacyName,
      sha512: canonicalLegacy.sha512,
    },
    files: canonicalFiles,
    legacyFile: canonicalLegacy,
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

  const files = value.files.map((file, index) =>
    parseManifestFile(name, index, file)
  )
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
    document: value,
    version: value.version,
    files,
    legacyFile,
  }
}

function parseManifestFile(manifestName, index, value) {
  if (!isRecord(value)) {
    throw new Error(`${manifestName}: files[${index}] must be an object`)
  }
  if (typeof value.url !== 'string' || !isSafeFlatName(value.url)) {
    throw new Error(`${manifestName}: files[${index}].url is not a safe name`)
  }
  if (typeof value.sha512 !== 'string' || !isSha512(value.sha512)) {
    throw new Error(`${manifestName}: files[${index}].sha512 is invalid`)
  }
  if (
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0
  ) {
    throw new Error(`${manifestName}: files[${index}].size is invalid`)
  }
  return value
}

function mergeMacManifests(x64, arm64, manifestName) {
  if (x64.version !== arm64.version) {
    throw new Error(
      `${manifestName}: architecture versions differ (${x64.version} and ${arm64.version})`
    )
  }
  if (!x64.legacyFile.url.endsWith('.zip')) {
    throw new Error(`${manifestName}: x64 legacy path must reference a ZIP`)
  }

  const files = []
  const byName = new Map()
  for (const file of [...x64.files, ...arm64.files]) {
    const previous = byName.get(file.url.toLowerCase())
    if (previous) {
      if (
        previous.url !== file.url ||
        previous.sha512 !== file.sha512 ||
        previous.size !== file.size
      ) {
        throw new Error(
          `${manifestName}: duplicate update file ${file.url} has conflicting metadata`
        )
      }
      continue
    }
    byName.set(file.url.toLowerCase(), file)
    files.push(file)
  }

  return {
    ...x64.document,
    files,
    path: x64.legacyFile.url,
    sha512: x64.legacyFile.sha512,
  }
}

function addOutputFile(outputFiles, name, file) {
  const key = name.toLowerCase()
  const previous = outputFiles.get(key)
  if (previous) {
    throw new Error(
      `Output basename ${name} from ${file.target} conflicts with ${previous.name} from ${previous.target}`
    )
  }
  outputFiles.set(key, { ...file, name })
}

function assertOutputOutsideInputs(outputDirectory, inputDirectories) {
  for (const inputDirectory of inputDirectories) {
    const relative = path.relative(inputDirectory, outputDirectory)
    if (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..')
    ) {
      throw new Error(
        `Output directory must not be inside release input ${inputDirectory}`
      )
    }
  }
}

async function ensureEmptyOutputDirectory(directory) {
  const info = await stat(directory).catch(() => null)
  if (info && !info.isDirectory()) {
    throw new Error(`Output path ${directory} is not a directory`)
  }
  if (info) {
    const entries = await readdir(directory)
    if (entries.length > 0) {
      throw new Error(`Output directory ${directory} must be empty`)
    }
    return
  }
  await mkdir(directory, { recursive: true })
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
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  const inputDirectory = path.resolve(readArg('--input') ?? '.')
  const outputDirectory = path.resolve(readArg('--output') ?? 'release')
  const version =
    readArg('--version') ?? process.env.GITHUB_REF_NAME?.replace(/^v/, '')
  const result = await assembleReleaseArtifacts({
    inputDirectory,
    outputDirectory,
    version,
    channel: readArg('--channel') ?? releaseChannelFromVersion(version),
  })
  console.log(
    `Assembled ${result.assets.length} release asset(s) and ${result.manifests.length} update manifest(s)`
  )
}
