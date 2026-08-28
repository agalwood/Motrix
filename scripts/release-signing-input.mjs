import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const SCHEMA_VERSION = 2
const ELECTRON_BUILDER_VERSION = '26.15.7'
const ELECTRON_VERSION = '43.4.0'
const PLATFORMS = new Set(['darwin', 'win32'])
const ARCHES = new Set(['arm64', 'x64'])

export const SIGNING_ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 1024 * 1024 * 1024,
  inputBytes: 768 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024,
  files: 50_000,
  manifestBytes: 16 * 1024 * 1024,
  pathBytes: 4096,
})

const TRUSTED_INPUT_SHA256 = Object.freeze({
  'electron-builder.signing.json':
    '2950c8fb4ebe86a46d384efc373c3fb2b7d08389699fe1ab4ecb54e319dd5cd0',
  'signing-build-resources/256x256.png':
    '044d3b64a14aa512ca41469372d1ad630557daaeb2cb4e709d34f2d3c57d4c3b',
  'signing-build-resources/background.tiff':
    'f15290fe1a059a6b262466445fd24a63eabf0e2a4f734f9812dfe8ac0b9609c1',
  'signing-build-resources/entitlements.mac.plist':
    '38e56782c6c54555ff3c19b344ce8887e0689d935770a45208883e37f6aec500',
  'signing-build-resources/icon.icns':
    'f9ff86f32c2110b21d71a49a346f4186c4ef2cf1aed3884eca9704cb77fb4ed7',
  'signing-build-resources/icon.ico':
    'a71d20d0ca732e27b445e3f09a0cd22cb356620929416e790d005dfff9c4e5a7',
  'signing-build-resources/torrent.icns':
    '1c8e042a7d4391fa241b4411badbe4a7393a8ad8429679838bf43b25ab29425f',
  'signing-build-resources/torrent.ico':
    '7743ad382011e30236e91322164f0ebd20c283e634db44c36f314aa2abf2f5a8',
  'signing-policy/installer.nsh':
    '779f44909b4ea67a564bb67976bebdf3c307332c1e970fa48ef04d4fcd3b469c',
  'signing-tool/package.json':
    'b8ddd0e1bb90198d99628eb8b5b8c3c2b8cbda4a3aee48f118a36244467fac51',
  'signing-tool/package-lock.json':
    'd19faa86a197df62719776877d600b2345670a81d58b1939949681aee8b225bf',
  'scripts/electron-package-size-budgets.json':
    'f37ffcdb32967077cf66711526de91201d1bb976f3e48687cbc89fba89b94696',
  'scripts/electron-package-utils.mjs':
    '9d408f9edc91182be5d5aed39f2c5a5d20f5523e08d9c08e630c23c66302daa8',
  'scripts/before-build-use-staged-dependencies.mjs':
    'acbd47ea1ac9397990ec0d605cb1f5e627c3db265bd1e3a6588a7c65635af315',
  'scripts/native-binary-target.mjs':
    '6f0a42eecf729eb6de2df28b5d7449993590e494deb4e309b99c367094045797',
  'scripts/verify-electron-package.mjs':
    'fc8a3eb35684e2b21c46b6677a2568aeffbd4a7a6befae09fc57c9068b05c680',
})

const SOURCE_MAPPINGS = [
  ['THIRD_PARTY_LICENSES', 'THIRD_PARTY_LICENSES'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['THIRD_PARTY_NOTICES.zh-CN.md', 'THIRD_PARTY_NOTICES.zh-CN.md'],
  ['build/legal', 'build/legal'],
  ['build/256x256.png', 'signing-build-resources/256x256.png'],
  ['build/background.tiff', 'signing-build-resources/background.tiff'],
  [
    'build/entitlements.mac.plist',
    'signing-build-resources/entitlements.mac.plist',
  ],
  ['build/icon.icns', 'signing-build-resources/icon.icns'],
  ['build/icon.ico', 'signing-build-resources/icon.ico'],
  ['build/torrent.icns', 'signing-build-resources/torrent.icns'],
  ['build/torrent.ico', 'signing-build-resources/torrent.ico'],
  ['build/installer.nsh', 'signing-policy/installer.nsh'],
  ['dist/builtin-plugins', 'dist/builtin-plugins'],
  ['dist/electron-app', 'dist/electron-app'],
  ['electron-builder.signing.json', 'electron-builder.signing.json'],
  ['extra/aria2.conf', 'extra/aria2.conf'],
  ['extra/tray', 'extra/tray'],
  ['scripts/release-signing-tool/package.json', 'signing-tool/package.json'],
  [
    'scripts/release-signing-tool/package-lock.json',
    'signing-tool/package-lock.json',
  ],
  [
    'scripts/electron-package-size-budgets.json',
    'scripts/electron-package-size-budgets.json',
  ],
  ['scripts/electron-package-utils.mjs', 'scripts/electron-package-utils.mjs'],
  [
    'scripts/before-build-use-staged-dependencies.mjs',
    'scripts/before-build-use-staged-dependencies.mjs',
  ],
  ['scripts/native-binary-target.mjs', 'scripts/native-binary-target.mjs'],
  [
    'scripts/verify-electron-package.mjs',
    'scripts/verify-electron-package.mjs',
  ],
  ['scripts/release-signing-input.mjs', 'scripts/release-signing-input.mjs'],
]

async function sha256File(absolutePath, expectedBytes) {
  const hash = createHash('sha256')
  let observedBytes = 0
  for await (const chunk of createReadStream(absolutePath)) {
    observedBytes += chunk.length
    if (observedBytes > SIGNING_ARCHIVE_LIMITS.fileBytes) {
      throw new Error(`signing input file exceeds size limit: ${absolutePath}`)
    }
    hash.update(chunk)
  }
  if (expectedBytes !== undefined && observedBytes !== expectedBytes) {
    throw new Error(`signing input file changed while reading: ${absolutePath}`)
  }
  return hash.digest('hex')
}

function portable(relativePath) {
  return relativePath.split(path.sep).join('/')
}

function compareCodeUnits(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isAllowedSigningDataPath(relativePath) {
  return (
    [
      'THIRD_PARTY_NOTICES.md',
      'THIRD_PARTY_NOTICES.zh-CN.md',
      'electron-builder.signing.json',
      'signing-policy/installer.nsh',
      'signing-tool/package.json',
      'signing-tool/package-lock.json',
      'scripts/before-build-use-staged-dependencies.mjs',
      'scripts/electron-package-size-budgets.json',
      'scripts/electron-package-utils.mjs',
      'scripts/native-binary-target.mjs',
      'scripts/release-signing-input.mjs',
      'scripts/verify-electron-package.mjs',
    ].includes(relativePath) ||
    [
      'THIRD_PARTY_LICENSES/',
      'build/legal/',
      'dist/builtin-plugins/',
      'dist/electron-app/',
      'extra/',
      'packages/native-host/dist/',
      'signing-build-resources/',
      'size-reports/',
    ].some((prefix) => relativePath.startsWith(prefix))
  )
}

function isForbiddenControlPath(relativePath) {
  if (
    relativePath === 'signing-tool/package.json' ||
    relativePath === 'signing-tool/package-lock.json'
  ) {
    return false
  }
  const lowercasePath = relativePath.toLowerCase()
  const basename = path.posix.basename(lowercasePath)
  return (
    basename === 'electron-builder.env' ||
    basename === 'yarn.lock' ||
    basename === 'pnpm-lock.yaml' ||
    basename === 'package-lock.json' ||
    basename === 'npm-shrinkwrap.json' ||
    basename === 'pnpm-workspace.yaml' ||
    basename === '.npmrc' ||
    basename === '.pnpmfile.cjs' ||
    basename.startsWith('bun.lock') ||
    basename.startsWith('.yarnrc') ||
    basename.startsWith('.pnp.') ||
    basename === '.yarn' ||
    lowercasePath.startsWith('.yarn/') ||
    lowercasePath.includes('/.yarn/')
  )
}

function isAllowedSigningDirectory(relativePath) {
  const recursiveRoots = [
    'THIRD_PARTY_LICENSES',
    'build/legal',
    'dist/builtin-plugins',
    'dist/electron-app',
    'extra',
    'packages/native-host/dist',
  ]
  const flatRoots = [
    'signing-build-resources',
    'signing-policy',
    'signing-tool',
    'scripts',
    'size-reports',
  ]
  return (
    recursiveRoots.some(
      (root) =>
        relativePath === root ||
        relativePath.startsWith(`${root}/`) ||
        root.startsWith(`${relativePath}/`)
    ) ||
    flatRoots.some(
      (root) => relativePath === root || root.startsWith(`${relativePath}/`)
    )
  )
}

function isAllowedSigningBuildResource(relativePath) {
  return new Set([
    'signing-build-resources/256x256.png',
    'signing-build-resources/background.tiff',
    'signing-build-resources/entitlements.mac.plist',
    'signing-build-resources/icon.icns',
    'signing-build-resources/icon.ico',
    'signing-build-resources/torrent.icns',
    'signing-build-resources/torrent.ico',
  ]).has(relativePath)
}

function parseOptions(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      throw new Error(`unknown argument: ${argument}`)
    }
    const key = argument.slice(2)
    if (
      !['arch', 'archive', 'commit', 'directory', 'mode', 'platform'].includes(
        key
      )
    ) {
      throw new Error(`unknown option: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${argument}`)
    }
    options[key] = value
    index += 1
  }
  if (!['create', 'verify'].includes(options.mode)) {
    throw new Error('--mode must be create or verify')
  }
  if (!PLATFORMS.has(options.platform)) {
    throw new Error('--platform must be darwin or win32')
  }
  if (!ARCHES.has(options.arch)) {
    throw new Error('--arch must be arm64 or x64')
  }
  if (
    typeof options.commit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(options.commit)
  ) {
    throw new Error('--commit must be a lowercase 40-character Git SHA')
  }
  if (!options.directory) throw new Error('--directory is required')
  if (options.mode === 'create' && !options.archive) {
    throw new Error('--archive is required in create mode')
  }
  if (options.platform === 'win32' && options.arch !== 'x64') {
    throw new Error('Windows signing input only supports x64')
  }
  return options
}

async function assertSafeTree(root) {
  const canonicalRoot = await realpath(root)
  async function visit(current, relative = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      const relativePath = portable(
        relative ? path.join(relative, entry.name) : entry.name
      )
      if (entry.isSymbolicLink()) {
        throw new Error(`signing input must not contain symlinks: ${entryPath}`)
      }
      if (entry.isDirectory()) {
        if (
          relativePath === 'trusted' ||
          relativePath.startsWith('trusted/') ||
          relativePath === 'release' ||
          relativePath.startsWith('release/') ||
          isForbiddenControlPath(relativePath) ||
          !isAllowedSigningDirectory(relativePath)
        ) {
          throw new Error(
            `signing input contains a reserved directory: ${relativePath}`
          )
        }
        await visit(entryPath, relativePath)
      } else if (
        entry.isFile() &&
        relativePath !== 'signing-input-manifest.json' &&
        (isForbiddenControlPath(relativePath) ||
          !isAllowedSigningDataPath(relativePath))
      ) {
        throw new Error(
          `signing input contains a reserved file: ${relativePath}`
        )
      } else if (!entry.isFile()) {
        throw new Error(`signing input must contain only files: ${entryPath}`)
      }
    }
  }
  await visit(canonicalRoot)
}

function targetResource(platform, arch) {
  const executable = platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  return `extra/${platform}/${arch}/${executable}`
}

function nativeHostResource(platform, arch) {
  const executable =
    platform === 'win32' ? 'motrix-native-host.exe' : 'motrix-native-host'
  return `packages/native-host/dist/${platform}-${arch}/${executable}`
}

function normalizedMode(relativePath, info, options) {
  if (
    relativePath === targetResource(options.platform, options.arch) ||
    relativePath === nativeHostResource(options.platform, options.arch)
  ) {
    return 0o755
  }
  return (info.mode & 0o111) === 0 ? 0o644 : 0o755
}

async function inventory(root, options = {}) {
  const files = []
  let totalBytes = 0
  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => compareCodeUnits(left.name, right.name))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const relativePath = relative
        ? path.join(relative, entry.name)
        : entry.name
      if (entry.isSymbolicLink()) {
        throw new Error(
          `signing input must not contain symlinks: ${relativePath}`
        )
      }
      if (entry.isDirectory()) {
        await visit(absolute, relativePath)
      } else if (entry.isFile()) {
        const normalized = portable(relativePath)
        if (normalized === options.exclude) continue
        if (Buffer.byteLength(normalized) > SIGNING_ARCHIVE_LIMITS.pathBytes) {
          throw new Error(`signing input path exceeds limit: ${normalized}`)
        }
        const info = await lstat(absolute)
        if (!info.isFile() || info.size > SIGNING_ARCHIVE_LIMITS.fileBytes) {
          throw new Error(`signing input file exceeds limit: ${normalized}`)
        }
        totalBytes += info.size
        if (
          files.length + 1 > SIGNING_ARCHIVE_LIMITS.files ||
          totalBytes > SIGNING_ARCHIVE_LIMITS.inputBytes
        ) {
          throw new Error('signing input exceeds archive limits')
        }
        files.push({
          path: normalized,
          bytes: info.size,
          mode: normalizedMode(normalized, info, options),
          sha256: await sha256File(absolute, info.size),
        })
      } else {
        throw new Error(
          `signing input must contain only files: ${relativePath}`
        )
      }
    }
  }
  await visit(root, '')
  return files.sort((left, right) => compareCodeUnits(left.path, right.path))
}

function tarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value)
  if (bytes.length > length) throw new Error(`tar field is too long: ${value}`)
  bytes.copy(buffer, offset)
}

function tarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0')
  if (encoded.length >= length) {
    throw new Error(`tar value is too large: ${value}`)
  }
  tarString(buffer, offset, length, `${encoded}\0`)
}

function tarHeader(name, size, mode, type) {
  const header = Buffer.alloc(512)
  tarString(header, 0, 100, name)
  tarOctal(header, 100, 8, mode)
  tarOctal(header, 108, 8, 0)
  tarOctal(header, 116, 8, 0)
  tarOctal(header, 124, 12, size)
  tarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  tarString(header, 156, 1, type)
  tarString(header, 257, 6, 'ustar')
  tarString(header, 263, 2, '00')
  tarString(header, 265, 32, 'root')
  tarString(header, 297, 32, 'root')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  tarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function paxPathRecord(relativePath) {
  const body = `path=${relativePath}\n`
  let length = Buffer.byteLength(body) + 3
  while (true) {
    const record = `${length} ${body}`
    const actual = Buffer.byteLength(record)
    if (actual === length) return Buffer.from(record)
    length = actual
  }
}

function tarEntryBytes(relativePath, size) {
  const paxBytes =
    Buffer.byteLength(relativePath) > 100
      ? 512 + Math.ceil(paxPathRecord(relativePath).length / 512) * 512
      : 0
  return paxBytes + 512 + Math.ceil(size / 512) * 512
}

async function writeAll(handle, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset)
    offset += result.bytesWritten
  }
}

async function writeFileContents(handle, absolutePath, expectedBytes) {
  let observedBytes = 0
  for await (const chunk of createReadStream(absolutePath)) {
    observedBytes += chunk.length
    if (observedBytes > expectedBytes) {
      throw new Error(`signing input file changed: ${absolutePath}`)
    }
    await writeAll(handle, chunk)
  }
  if (observedBytes !== expectedBytes) {
    throw new Error(`signing input file changed: ${absolutePath}`)
  }
}

async function writeTarEntry(handle, root, entry, index) {
  let tarName = entry.path
  if (Buffer.byteLength(entry.path) > 100) {
    const pax = paxPathRecord(entry.path)
    await writeAll(
      handle,
      tarHeader(
        `PaxHeaders/${String(index).padStart(8, '0')}`,
        pax.length,
        0o644,
        'x'
      )
    )
    await writeAll(handle, pax)
    await writeAll(handle, Buffer.alloc((512 - (pax.length % 512)) % 512))
    tarName = `PaxFiles/${String(index).padStart(8, '0')}`
  }
  await writeAll(handle, tarHeader(tarName, entry.bytes, entry.mode, '0'))
  await writeFileContents(handle, path.join(root, entry.path), entry.bytes)
  await writeAll(handle, Buffer.alloc((512 - (entry.bytes % 512)) % 512))
}

export async function createSigningArchive(directory, archive, options) {
  const root = path.resolve(directory)
  const archivePath = path.resolve(archive)
  const entries = await inventory(root, options)
  const archiveBytes =
    entries.reduce(
      (total, entry) => total + tarEntryBytes(entry.path, entry.bytes),
      0
    ) + 1024
  if (archiveBytes > SIGNING_ARCHIVE_LIMITS.archiveBytes) {
    throw new Error('signing input tar exceeds archive size limit')
  }
  await mkdir(path.dirname(archivePath), { recursive: true })
  const handle = await open(archivePath, 'w', 0o644)
  try {
    for (const [index, entry] of entries.entries()) {
      await writeTarEntry(handle, root, entry, index)
    }
    await writeAll(handle, Buffer.alloc(1024))
  } finally {
    await handle.close()
  }
}

async function copySource(sourcePath, destinationPath, output) {
  const source = path.join(REPOSITORY_ROOT, sourcePath)
  const info = await lstat(source).catch(() => null)
  if (!info) throw new Error(`missing signing input source: ${sourcePath}`)
  if (info.isSymbolicLink()) {
    throw new Error(`signing input source must not be a symlink: ${sourcePath}`)
  }
  const target = path.join(output, destinationPath)
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, dereference: false })
}

async function verifyTrustedInputDigests(root) {
  for (const [relativePath, expected] of Object.entries(TRUSTED_INPUT_SHA256)) {
    const absolute = path.join(root, relativePath)
    const info = await lstat(absolute).catch(() => null)
    if (
      !info?.isFile() ||
      info.size > SIGNING_ARCHIVE_LIMITS.fileBytes ||
      (await sha256File(absolute, info.size)) !== expected
    ) {
      throw new Error(`trusted signing input digest mismatch: ${relativePath}`)
    }
  }
}

export async function createSigningInput(options) {
  const output = path.resolve(options.directory)
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })

  const targetKey = `${options.platform}-${options.arch}`
  for (const [sourcePath, destinationPath] of [
    ...SOURCE_MAPPINGS,
    [
      targetResource(options.platform, options.arch),
      targetResource(options.platform, options.arch),
    ],
    [
      nativeHostResource(options.platform, options.arch),
      nativeHostResource(options.platform, options.arch),
    ],
    [
      `release/size-reports/${targetKey}.json`,
      `size-reports/${targetKey}.json`,
    ],
  ]) {
    await copySource(sourcePath, destinationPath, output)
  }
  await assertSafeTree(output)
  await verifyTrustedInputDigests(output)

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    commit: options.commit,
    target: {
      key: targetKey,
      platform: options.platform,
      arch: options.arch,
    },
    tools: {
      electronBuilder: ELECTRON_BUILDER_VERSION,
      electron: ELECTRON_VERSION,
    },
    limits: SIGNING_ARCHIVE_LIMITS,
    files: await inventory(output, options),
  }
  await writeFile(
    path.join(output, 'signing-input-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 }
  )
  if (options.archive) {
    await createSigningArchive(output, options.archive, options)
  }
  return manifest
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unexpected keys`)
  }
}

function verifyManifestEntry(entry) {
  exactKeys(entry, ['bytes', 'mode', 'path', 'sha256'], 'file inventory entry')
  if (
    typeof entry.path !== 'string' ||
    entry.path.length === 0 ||
    entry.path.includes('\\') ||
    entry.path.includes('\0') ||
    Buffer.byteLength(entry.path) > SIGNING_ARCHIVE_LIMITS.pathBytes ||
    path.posix.normalize(entry.path) !== entry.path ||
    path.posix.isAbsolute(entry.path) ||
    entry.path === '..' ||
    entry.path.startsWith('../') ||
    entry.path === 'trusted' ||
    entry.path.startsWith('trusted/') ||
    entry.path === 'release' ||
    entry.path.startsWith('release/') ||
    entry.path === 'package.json' ||
    (/(?:^|\/)installer\.ns[hi]$/iu.test(entry.path) &&
      entry.path !== 'signing-policy/installer.nsh') ||
    entry.path.startsWith('signing-build-resources/x86-unicode/') ||
    entry.path.startsWith('signing-build-resources/x86-ansi/') ||
    !isAllowedSigningDataPath(entry.path) ||
    (entry.path.startsWith('signing-build-resources/') &&
      !isAllowedSigningBuildResource(entry.path)) ||
    isForbiddenControlPath(entry.path) ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    entry.bytes > SIGNING_ARCHIVE_LIMITS.fileBytes ||
    ![0o644, 0o755].includes(entry.mode) ||
    typeof entry.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(entry.sha256)
  ) {
    throw new Error('signing input manifest contains an invalid file entry')
  }
}

async function verifyRestrictedConfig(input) {
  const config = JSON.parse(
    await readFile(path.join(input, 'electron-builder.signing.json'), 'utf8')
  )
  for (const hook of [
    'afterAllArtifactBuild',
    'afterExtract',
    'afterPack',
    'afterSign',
    'appxManifestCreated',
    'artifactBuildCompleted',
    'artifactBuildStarted',
    'beforePack',
    'msiProjectCreated',
    'onNodeModuleFile',
  ]) {
    if (Object.hasOwn(config, hook)) {
      throw new Error(`restricted signing config must not define ${hook}`)
    }
  }
  if (
    config.electronDist !== 'trusted/electron.zip' ||
    config.electronVersion !== ELECTRON_VERSION ||
    config.extends !== null ||
    config.npmRebuild !== true ||
    config.beforeBuild !==
      './scripts/before-build-use-staged-dependencies.mjs' ||
    config.directories?.app !== 'dist/electron-app' ||
    config.directories?.buildResources !== 'signing-build-resources' ||
    config.nsis?.include !== 'trusted/installer.nsh' ||
    config.nsis?.script !== null ||
    config.nsis?.customNsisBinary !== null ||
    config.nsis?.customNsisResources !== null ||
    config.toolsets?.nsis !== undefined ||
    config.mac?.sign !== undefined ||
    config.win?.signtoolOptions?.sign !== undefined
  ) {
    throw new Error('restricted signing config is not self-contained')
  }
}

async function verifySigningTool(input) {
  const toolPackage = JSON.parse(
    await readFile(path.join(input, 'signing-tool/package.json'), 'utf8')
  )
  const toolLock = JSON.parse(
    await readFile(path.join(input, 'signing-tool/package-lock.json'), 'utf8')
  )
  if (
    toolPackage.private !== true ||
    toolPackage.scripts !== undefined ||
    toolPackage.dependencies?.['electron-builder'] !==
      ELECTRON_BUILDER_VERSION ||
    toolLock.lockfileVersion !== 3 ||
    toolLock.packages?.['']?.dependencies?.['electron-builder'] !==
      ELECTRON_BUILDER_VERSION ||
    toolLock.packages?.['node_modules/electron-builder']?.version !==
      ELECTRON_BUILDER_VERSION
  ) {
    throw new Error('signing tool dependency closure is not pinned')
  }
  for (const [packagePath, metadata] of Object.entries(toolLock.packages)) {
    if (packagePath === '') continue
    if (
      typeof metadata.version !== 'string' ||
      typeof metadata.resolved !== 'string' ||
      !metadata.resolved.startsWith('https://registry.npmjs.org/') ||
      typeof metadata.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(metadata.integrity)
    ) {
      throw new Error(
        `signing tool lock contains an unpinned package: ${packagePath}`
      )
    }
  }
}

export async function verifySigningInput(options) {
  const input = path.resolve(options.directory)
  const manifestPath = path.join(input, 'signing-input-manifest.json')
  const manifestInfo = await lstat(manifestPath)
  if (
    !manifestInfo.isFile() ||
    manifestInfo.size > SIGNING_ARCHIVE_LIMITS.manifestBytes
  ) {
    throw new Error('signing input manifest exceeds size limit')
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  exactKeys(
    manifest,
    ['commit', 'files', 'limits', 'schemaVersion', 'target', 'tools'],
    'signing input manifest'
  )
  exactKeys(manifest.target, ['arch', 'key', 'platform'], 'target')
  exactKeys(manifest.tools, ['electron', 'electronBuilder'], 'tools')
  if (
    manifest.schemaVersion !== SCHEMA_VERSION ||
    manifest.commit !== options.commit ||
    manifest.target.platform !== options.platform ||
    manifest.target.arch !== options.arch ||
    manifest.target.key !== `${options.platform}-${options.arch}` ||
    manifest.tools.electronBuilder !== ELECTRON_BUILDER_VERSION ||
    manifest.tools.electron !== ELECTRON_VERSION ||
    JSON.stringify(manifest.limits) !==
      JSON.stringify(SIGNING_ARCHIVE_LIMITS) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('signing input manifest metadata does not match the job')
  }
  if (
    manifest.files.length === 0 ||
    manifest.files.length > SIGNING_ARCHIVE_LIMITS.files
  ) {
    throw new Error('signing input file inventory exceeds limit')
  }
  for (const entry of manifest.files) verifyManifestEntry(entry)
  const expectedPaths = manifest.files.map((entry) => entry.path)
  if (
    JSON.stringify(expectedPaths) !==
    JSON.stringify([...new Set(expectedPaths)].sort(compareCodeUnits))
  ) {
    throw new Error('signing input file inventory must be sorted and unique')
  }
  const totalBytes = manifest.files.reduce(
    (total, entry) => total + entry.bytes,
    0
  )
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > SIGNING_ARCHIVE_LIMITS.inputBytes
  ) {
    throw new Error('signing input file inventory exceeds size limit')
  }

  await assertSafeTree(input)
  const actual = await inventory(input, {
    exclude: 'signing-input-manifest.json',
    platform: options.platform,
    arch: options.arch,
  })
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error('signing input file inventory or digest does not match')
  }
  await verifyTrustedInputDigests(input)
  await verifyRestrictedConfig(input)
  await verifySigningTool(input)
  return manifest
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.mode === 'create') await createSigningInput(options)
  else await verifySigningInput(options)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
