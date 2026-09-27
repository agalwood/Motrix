import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getRawHeader, uncache } from '@electron/asar'
import { detectNativeBinaryTarget } from './native-binary-target.mjs'
import { verifyElectronPackage } from './verify-electron-package.mjs'
import { validateWindowsStoreMetadata } from './windows-store-metadata.mjs'

const ALLOWED_EXECUTABLES = new Set([
  'Motrix.exe',
  'chrome_crashpad_handler.exe',
  'resources/bin/motrix-native-host.exe',
  'resources/bin/motrix-finalize-fs.exe',
  'resources/bin/motrix-windows-platform.exe',
  'resources/extra/win32/x64/aria2c.exe',
])
const SIGNING_EXTENSIONS = new Set([
  '.cer',
  '.cert',
  '.crt',
  '.csr',
  '.der',
  '.jks',
  '.key',
  '.keystore',
  '.p8',
  '.p12',
  '.pem',
  '.pfx',
  '.pvk',
  '.snk',
  '.spc',
])
const INSTALLER_EXTENSIONS = new Set([
  '.appinstaller',
  '.appx',
  '.appxbundle',
  '.appxupload',
  '.deb',
  '.dmg',
  '.msi',
  '.msix',
  '.msixbundle',
  '.msixupload',
  '.msp',
  '.nupkg',
  '.pkg',
  '.rpm',
])
const PE_EXTENSIONS = new Set(['.exe', '.dll', '.node'])
const MAX_ASAR_HEADER_BYTES = 16 * 1024 * 1024

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertWindowsSegment(segment) {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.length > 255 ||
    /[<>:"/\\|?*]/.test(segment) ||
    [...segment].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    /[. ]$/.test(segment) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)
  ) {
    throw new Error(
      `Invalid Windows path component: ${JSON.stringify(segment)}`
    )
  }
}

function recordPath(seen, relative) {
  const key = relative.toUpperCase()
  if (seen.has(key)) throw new Error(`Windows path collision: ${relative}`)
  seen.add(key)
}

function comparePaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

function assertFilePolicy(relative, archive = false) {
  const name = path.posix.basename(relative).toLowerCase()
  const extension = path.posix.extname(name)
  if (name === 'app-update.yml' || name === 'dev-app-update.yml') {
    throw new Error(`Application updater metadata is forbidden: ${relative}`)
  }
  // These file formats are not part of the runtime payload. Do not scan source
  // text for PEM markers: dependencies may legitimately contain such literals.
  if (SIGNING_EXTENSIONS.has(extension)) {
    throw new Error(`Certificate or signing-key file is forbidden: ${relative}`)
  }
  if (INSTALLER_EXTENSIONS.has(extension)) {
    throw new Error(`Additional installer is forbidden: ${relative}`)
  }
  if (extension === '.exe' && (archive || !ALLOWED_EXECUTABLES.has(relative))) {
    throw new Error(`Undeclared executable is forbidden: ${relative}`)
  }
}

async function assertDirectoryChain(root) {
  const parsed = path.parse(root)
  let current = parsed.root
  for (const segment of root
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        'appDir and its ancestors must be actual directories, without symlinks'
      )
    }
  }
}

async function openRegular(filePath) {
  const before = await lstat(filePath)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Expected a regular file without a symlink')
  }
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    const actual = await handle.stat()
    if (
      !actual.isFile() ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino
    ) {
      throw new Error('Payload file changed during verification')
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readExact(handle, length, position) {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(
      bytes,
      offset,
      length - offset,
      position + offset
    )
    if (result.bytesRead === 0)
      throw new Error('Unexpected end of payload file')
    offset += result.bytesRead
  }
  return bytes
}

async function inventoryFile(absolute, relative) {
  const handle = await openRegular(absolute)
  try {
    const before = await handle.stat()
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
    })) {
      hash.update(chunk)
    }
    const result = {
      path: relative,
      bytes: before.size,
      sha256: hash.digest('hex'),
    }
    if (PE_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) {
      const dos = await readExact(handle, 64, 0)
      const offset = dos.readUInt32LE(0x3c)
      if (
        dos.toString('ascii', 0, 2) !== 'MZ' ||
        offset < 64 ||
        offset > before.size - 6
      ) {
        throw new Error(`Invalid PE header: ${relative}`)
      }
      const pe = await readExact(handle, 6, offset)
      if (
        !pe.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0, 0])) ||
        pe.readUInt16LE(4) !== 0x8664
      ) {
        throw new Error(`Expected x64 PE machine: ${relative}`)
      }
      result.peMachine = 'x64'
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`Payload file changed during verification: ${relative}`)
    }
    return result
  } finally {
    await handle.close()
  }
}

async function inventoryDirectory(root) {
  const files = []
  const seen = new Set()
  async function visit(absolute, relative) {
    const names = (await readdir(absolute)).sort()
    for (const name of names) {
      assertWindowsSegment(name)
      const entry = relative ? `${relative}/${name}` : name
      recordPath(seen, entry)
      const filePath = path.join(absolute, name)
      const info = await lstat(filePath)
      if (info.isSymbolicLink())
        throw new Error(`Symlink is forbidden: ${entry}`)
      if (info.isDirectory()) await visit(filePath, entry)
      else if (info.isFile()) {
        assertFilePolicy(entry)
        files.push({ absolute: filePath, path: entry, bytes: info.size })
      } else throw new Error(`Non-regular payload entry is forbidden: ${entry}`)
    }
  }
  await visit(root, '')
  return files
}

async function inventoryAsar(asarPath, physicalFiles) {
  const handle = await openRegular(asarPath)
  try {
    const archiveSize = (await handle.stat()).size
    const size = await readExact(handle, 8, 0)
    const headerSize = size.readUInt32LE(4)
    if (headerSize > MAX_ASAR_HEADER_BYTES || headerSize > archiveSize - 8) {
      throw new Error('ASAR header is oversized or truncated')
    }
    uncache(asarPath)
    const { header, headerSize: parsedSize } = getRawHeader(asarPath)
    if (parsedSize !== headerSize)
      throw new Error('ASAR header changed during verification')
    const files = []
    const seen = new Set()
    function visit(directory, prefix = '') {
      if (
        !directory ||
        typeof directory !== 'object' ||
        Array.isArray(directory)
      ) {
        throw new Error('Invalid ASAR directory')
      }
      for (const [name, node] of Object.entries(directory)) {
        assertWindowsSegment(name)
        const relative = prefix ? `${prefix}/${name}` : name
        recordPath(seen, relative)
        if (
          !node ||
          typeof node !== 'object' ||
          Array.isArray(node) ||
          Object.hasOwn(node, 'link')
        ) {
          throw new Error(
            `ASAR link or invalid entry is forbidden: ${relative}`
          )
        }
        if (Object.hasOwn(node, 'files')) visit(node.files, relative)
        else {
          assertFilePolicy(relative, true)
          if (
            !Number.isSafeInteger(node.size) ||
            node.size < 0 ||
            (node.unpacked !== undefined && typeof node.unpacked !== 'boolean')
          ) {
            throw new Error(
              `Invalid ASAR file size or unpacked flag: ${relative}`
            )
          }
          if (node.unpacked) {
            const physical = physicalFiles.get(
              `resources/app.asar.unpacked/${relative}`
            )
            if (!physical || physical.bytes !== node.size) {
              throw new Error(
                `ASAR unpacked file is missing or has a different size: ${relative}`
              )
            }
          } else if (
            typeof node.offset !== 'string' ||
            !/^(0|[1-9]\d*)$/.test(node.offset) ||
            !Number.isSafeInteger(Number(node.offset)) ||
            Number(node.offset) + node.size > archiveSize - 8 - headerSize
          ) {
            throw new Error(`Invalid ASAR file range: ${relative}`)
          }
          files.push({ ...node, path: relative })
        }
      }
    }
    visit(header.files)
    const inventory = []
    let manifest
    for (const file of files) {
      let record
      let bytes
      if (file.unpacked) {
        const physical = physicalFiles.get(
          `resources/app.asar.unpacked/${file.path}`
        )
        record = { ...physical, path: file.path }
        if (file.path === 'package.json') {
          const unpacked = await openRegular(
            path.join(`${asarPath}.unpacked`, file.path)
          )
          try {
            bytes = await unpacked.readFile()
          } finally {
            await unpacked.close()
          }
        }
      } else {
        bytes = await readExact(
          handle,
          file.size,
          8 + headerSize + Number(file.offset)
        )
        record = { path: file.path, bytes: bytes.length, sha256: sha256(bytes) }
        if (PE_EXTENSIONS.has(path.posix.extname(file.path).toLowerCase())) {
          const target = detectNativeBinaryTarget(bytes)
          if (
            target?.format !== 'pe' ||
            target.arches.length !== 1 ||
            target.arches[0] !== 'x64'
          ) {
            throw new Error(`Expected x64 PE machine in ASAR: ${file.path}`)
          }
          record.peMachine = 'x64'
        }
      }
      inventory.push(record)
      if (file.path === 'package.json')
        manifest = JSON.parse(bytes.toString('utf8'))
    }
    if (!manifest || typeof manifest.version !== 'string')
      throw new Error('ASAR package.json version is missing')
    return {
      files: inventory.sort(comparePaths),
      productVersion: manifest.version,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Compose Store-specific directory checks with the unchanged Electron verifier.
 * Inputs must remain immutable during verification. PE machine checks do not
 * execute binaries or establish signatures, source provenance, or Store identity.
 */
export async function verifyWindowsStorePayload({
  appDir,
  metadata: raw,
  budgets,
} = {}) {
  const report = {
    schemaVersion: 1,
    scope: 'windows-x64-directory-payload-only',
    ok: false,
    checks: [],
    inventory: { physicalFiles: [], asarFiles: [] },
    versions: null,
    electronPackage: null,
    storeIdentityVerified: false,
    payloadSourceVerified: false,
    signatureVerified: false,
    executableBehaviorVerified: false,
  }
  async function check(name, operation) {
    try {
      await operation()
      report.checks.push({ name, ok: true })
      return true
    } catch (error) {
      // Filesystem errors may contain machine paths; keep only their error code.
      const message = error.code
        ? `Payload IO failed (${error.code})`
        : error.message
      report.checks.push({ name, ok: false, message })
      return false
    }
  }
  let metadata
  if (
    !(await check('metadata', () => {
      metadata = validateWindowsStoreMetadata(raw).metadata
    }))
  )
    return report
  let root
  let physical
  if (
    !(await check('safe-directory', async () => {
      if (typeof appDir !== 'string' || !appDir)
        throw new Error('appDir must be an explicit directory')
      root = path.resolve(appDir)
      await assertDirectoryChain(root)
      physical = await inventoryDirectory(root)
      if (!physical.some((file) => file.path === 'Motrix.exe'))
        throw new Error('Motrix.exe is missing')
      if (
        !physical.some(
          (file) => file.path === 'resources/bin/motrix-windows-platform.exe'
        )
      )
        throw new Error('motrix-windows-platform.exe is missing')
      if (!physical.some((file) => file.path === 'resources/app.asar'))
        throw new Error('resources/app.asar is missing')
    }))
  )
    return report

  if (
    !(await check('physical-files', async () => {
      for (const file of physical)
        report.inventory.physicalFiles.push(
          await inventoryFile(file.absolute, file.path)
        )
      report.inventory.physicalFiles.sort(comparePaths)
    }))
  )
    return report
  if (
    !(await check('asar-files', async () => {
      const physicalByPath = new Map(
        report.inventory.physicalFiles.map((file) => [file.path, file])
      )
      const archive = await inventoryAsar(
        path.join(root, 'resources/app.asar'),
        physicalByPath
      )
      report.inventory.asarFiles = archive.files
      report.versions = {
        productVersion: metadata.productVersion,
        asarProductVersion: archive.productVersion,
        packageVersion: metadata.packageVersion,
        packageVersionSource: 'validated-metadata-only',
      }
      if (metadata.productVersion !== archive.productVersion)
        throw new Error(
          'ASAR product version does not match metadata.productVersion'
        )
    }))
  )
    return report

  await check('electron-package', async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), 'motrix-store-payload-report-')
    )
    try {
      report.electronPackage = await verifyElectronPackage({
        appDir: root,
        platform: 'win32',
        arch: 'x64',
        ...(budgets === undefined ? {} : { budgets }),
        reportPath: path.join(temporary, 'electron-package.json'),
      })
      if (!report.electronPackage.passed)
        throw new Error(
          'Existing Electron package checks failed; see electronPackage'
        )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
  report.ok = report.checks.every((entry) => entry.ok)
  return report
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key !== '--app-dir' && key !== '--metadata')
      throw new Error(`Unknown argument: ${key}`)
    if (Object.hasOwn(options, key))
      throw new Error(`Duplicate argument: ${key}`)
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`${key} requires a value`)
    options[key] = value
  }
  if (!options['--app-dir'] || !options['--metadata'])
    throw new Error(
      'Required arguments: --app-dir <directory> --metadata <file>'
    )
  return options
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const metadataPath = path.resolve(options['--metadata'])
    await assertDirectoryChain(path.dirname(metadataPath))
    const handle = await openRegular(metadataPath)
    let metadata
    try {
      metadata = JSON.parse(await handle.readFile('utf8'))
    } finally {
      await handle.close()
    }
    const report = await verifyWindowsStorePayload({
      appDir: options['--app-dir'],
      metadata,
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          checks: [
            {
              name: 'input',
              ok: false,
              message: error.code
                ? `Input IO failed (${error.code})`
                : error.message,
            },
          ],
          storeIdentityVerified: false,
          payloadSourceVerified: false,
          signatureVerified: false,
          executableBehaviorVerified: false,
        },
        null,
        2
      )}\n`
    )
    process.exitCode = 1
  }
}
