import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import { parseStrictSemVer } from './release-metadata.mjs'

const execFileAsync = promisify(execFile)
const UNSQUASHFS_PATH = '/usr/bin/unsquashfs'

const ARCHITECTURES = {
  amd64: {
    electronArch: 'x64',
    elfMachine: 62,
  },
  arm64: {
    electronArch: 'arm64',
    elfMachine: 183,
  },
}

const PERSONAL_FILES = [
  '$HOME/.config/google-chrome/NativeMessagingHosts/app.motrix.bridge.json',
  '$HOME/.config/microsoft-edge/NativeMessagingHosts/app.motrix.bridge.json',
  '$HOME/.mozilla/native-messaging-hosts/app.motrix.bridge.json',
]

const MOTRIX_PLUGS = [
  'audio-playback',
  'browser-native-messaging',
  'browser-support',
  'desktop',
  'desktop-legacy',
  'gsettings',
  'home',
  'network',
  'network-bind',
  'opengl',
  'removable-media',
  'screen-inhibit-control',
  'unity7',
  'wayland',
  'x11',
]

const ROOT_PLUGS = [
  'browser-native-messaging',
  'browser-support',
  'desktop',
  'gnome-46-2404',
  'gpu-2404',
  'gtk-3-themes',
  'icon-themes',
  'sound-themes',
]

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function requireString(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} must be "${expected}", received "${value ?? ''}"`)
  }
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`)
  }
  return value
}

function requireExactSet(actual, expected, label) {
  const values = requireStringArray(actual, label)
  if (
    values.length !== expected.length ||
    new Set(values).size !== expected.length ||
    expected.some((item) => !values.includes(item))
  ) {
    throw new Error(`${label} does not match the approved path set`)
  }
}

function requireExactArray(actual, expected, label) {
  const values = requireStringArray(actual, label)
  if (
    values.length !== expected.length ||
    expected.some((item, index) => values[index] !== item)
  ) {
    throw new Error(`${label} does not match the approved order`)
  }
}

async function readElfMachine(filePath) {
  const file = await open(filePath, 'r')
  try {
    const header = Buffer.alloc(20)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (
      bytesRead !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2
    ) {
      return null
    }
    if (header[5] === 1) return header.readUInt16LE(18)
    if (header[5] === 2) return header.readUInt16BE(18)
    return null
  } finally {
    await file.close()
  }
}

async function verifyExecutable(filePath, label, elfMachine) {
  const info = await lstat(filePath).catch(() => null)
  if (!info?.isFile()) {
    throw new Error(`${label} is missing or is not a regular file`)
  }
  if ((info.mode & 0o111) === 0) throw new Error(`${label} is not executable`)
  if ((await readElfMachine(filePath)) !== elfMachine) {
    throw new Error(`${label} has the wrong ELF architecture`)
  }
  await access(filePath, constants.X_OK)
}

async function verifyRegularFile(filePath, label) {
  const info = await lstat(filePath).catch(() => null)
  if (!info?.isFile()) throw new Error(`${label} is missing`)
}

async function findFileNamed(root, name) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.name === name) return entryPath
    if (entry.isDirectory()) {
      const nested = await findFileNamed(entryPath, name)
      if (nested) return nested
    }
  }
  return null
}

function verifyMetadata(metadata, { arch, version }) {
  const root = requireRecord(metadata, 'meta/snap.yaml')
  requireString(root.name, 'motrix', 'snap name')
  requireString(root.version, version, 'snap version')
  requireString(root.base, 'core24', 'snap base')
  requireString(root.grade, 'stable', 'snap grade')
  requireString(root.confinement, 'strict', 'snap confinement')
  const assumes = requireStringArray(root.assumes, 'snap assumes')
  if (!assumes.includes('snapd2.46')) {
    throw new Error(
      'snap assumes must require snapd2.46 for SNAP_REAL_HOME support'
    )
  }
  const links = requireRecord(root.links, 'snap links')
  requireExactSet(links.website, ['https://motrix.app'], 'snap links.website')
  requireExactSet(
    links['source-code'],
    ['https://github.com/agalwood/Motrix'],
    'snap links.source-code'
  )
  requireExactSet(
    links.issues,
    ['https://github.com/agalwood/Motrix/issues'],
    'snap links.issues'
  )
  requireExactSet(root.architectures, [arch], 'snap architectures')

  const apps = requireRecord(root.apps, 'apps')
  const appNames = Object.keys(apps).sort()
  if (
    appNames.length !== 2 ||
    appNames[0] !== 'motrix' ||
    appNames[1] !== 'native-host'
  ) {
    throw new Error('Snap must expose exactly motrix and native-host apps')
  }

  const motrix = requireRecord(apps.motrix, 'apps.motrix')
  requireString(
    motrix.command,
    'app/motrix --no-sandbox',
    'apps.motrix.command'
  )
  requireExactSet(motrix.plugs, MOTRIX_PLUGS, 'apps.motrix.plugs')
  const motrixEnvironment = requireRecord(
    motrix.environment,
    'apps.motrix.environment'
  )
  requireString(
    motrixEnvironment.MOTRIX_BRIDGE_DATA_DIR,
    '$SNAP_USER_COMMON/bridge',
    'apps.motrix.environment.MOTRIX_BRIDGE_DATA_DIR'
  )
  requireString(
    motrixEnvironment.TMPDIR,
    '$XDG_RUNTIME_DIR',
    'apps.motrix.environment.TMPDIR'
  )
  requireExactArray(
    motrix['command-chain'],
    [
      'snap/command-chain/gpu-2404-wrapper',
      'snap/command-chain/desktop-launch',
    ],
    'apps.motrix.command-chain'
  )

  const nativeHost = requireRecord(apps['native-host'], 'apps.native-host')
  requireString(
    nativeHost.command,
    'app/resources/bin/motrix-native-host',
    'apps.native-host.command'
  )
  requireExactSet(
    nativeHost.plugs,
    ['desktop', 'network'],
    'apps.native-host.plugs'
  )
  if (Object.hasOwn(nativeHost, 'command-chain')) {
    throw new Error(
      'apps.native-host must not use launch wrappers that can pollute stdout'
    )
  }
  const nativeEnvironment = requireRecord(
    nativeHost.environment,
    'apps.native-host.environment'
  )
  requireString(
    nativeEnvironment.MOTRIX_BRIDGE_DATA_DIR,
    '$SNAP_USER_COMMON/bridge',
    'apps.native-host.environment.MOTRIX_BRIDGE_DATA_DIR'
  )

  const plugs = requireRecord(root.plugs, 'plugs')
  requireExactSet(Object.keys(plugs), ROOT_PLUGS, 'root plug names')
  const browserSupport = requireRecord(
    plugs['browser-support'],
    'plugs.browser-support'
  )
  requireString(
    browserSupport.interface,
    'browser-support',
    'plugs.browser-support.interface'
  )
  if (browserSupport['allow-sandbox'] !== false) {
    throw new Error('browser-support must set allow-sandbox to false')
  }

  const nativeMessaging = requireRecord(
    plugs['browser-native-messaging'],
    'plugs.browser-native-messaging'
  )
  requireString(
    nativeMessaging.interface,
    'personal-files',
    'plugs.browser-native-messaging.interface'
  )
  requireExactSet(
    nativeMessaging.write,
    PERSONAL_FILES,
    'plugs.browser-native-messaging.write'
  )

  const contentPlugs = {
    'gnome-46-2404': {
      target: '$SNAP/gnome-platform',
      provider: 'gnome-46-2404',
    },
    'gpu-2404': {
      target: '$SNAP/gpu-2404',
      provider: 'mesa-2404',
    },
    'gtk-3-themes': {
      target: '$SNAP/data-dir/themes',
      provider: 'gtk-common-themes',
    },
    'icon-themes': {
      target: '$SNAP/data-dir/icons',
      provider: 'gtk-common-themes',
    },
    'sound-themes': {
      target: '$SNAP/data-dir/sounds',
      provider: 'gtk-common-themes',
    },
  }
  for (const [name, expected] of Object.entries(contentPlugs)) {
    const plug = requireRecord(plugs[name], `plugs.${name}`)
    requireString(plug.interface, 'content', `plugs.${name}.interface`)
    requireString(plug.target, expected.target, `plugs.${name}.target`)
    requireString(
      plug['default-provider'],
      expected.provider,
      `plugs.${name}.default-provider`
    )
  }
  const desktop = requireRecord(plugs.desktop, 'plugs.desktop')
  if (
    ![undefined, 'desktop'].includes(desktop.interface) ||
    desktop['mount-host-font-cache'] !== false
  ) {
    throw new Error(
      'plugs.desktop must safely disable the host font cache mount'
    )
  }

  const environment = requireRecord(root.environment, 'snap environment')
  requireString(
    environment.SNAP_DESKTOP_RUNTIME,
    '$SNAP/gnome-platform',
    'snap environment.SNAP_DESKTOP_RUNTIME'
  )
  requireString(
    environment.GTK_USE_PORTAL,
    '1',
    'snap environment.GTK_USE_PORTAL'
  )
}

function verifyDesktopFile(contents) {
  const requiredLines = [
    'Exec=motrix %U',
    `Icon=\${SNAP}/meta/gui/icon.png`,
    'Terminal=false',
    'Type=Application',
    'MimeType=application/x-bittorrent;x-scheme-handler/magnet;x-scheme-handler/motrix;',
  ]
  const lines = new Set(contents.split(/\r?\n/))
  for (const line of requiredLines) {
    if (!lines.has(line)) {
      throw new Error(`Desktop file is missing "${line}"`)
    }
  }
}

export async function verifyExtractedSnap({ root, arch, version }) {
  const architecture = ARCHITECTURES[arch]
  if (!architecture) {
    throw new Error(
      `Unsupported Snap architecture "${arch}"; expected amd64 or arm64`
    )
  }
  parseStrictSemVer(version, 'Snap version')
  if (version.length > 32) throw new Error('Snap version exceeds 32 characters')

  const metadataPath = path.join(root, 'meta', 'snap.yaml')
  const metadata = load(await readFile(metadataPath, 'utf8'))
  verifyMetadata(metadata, { arch, version })

  const desktopPath = path.join(root, 'meta', 'gui', 'motrix.desktop')
  verifyDesktopFile(await readFile(desktopPath, 'utf8'))
  const icon = await lstat(path.join(root, 'meta', 'gui', 'icon.png')).catch(
    () => null
  )
  if (!icon?.isFile()) throw new Error('Snap icon is missing')

  if (await findFileNamed(root, 'chrome-sandbox')) {
    throw new Error('Snap must not contain chrome-sandbox')
  }
  if (
    await lstat(path.join(root, 'app', 'resources', 'app-update.yml')).catch(
      () => null
    )
  ) {
    throw new Error('Snap must not contain electron-updater metadata')
  }

  await verifyExecutable(
    path.join(root, 'app', 'motrix'),
    'Motrix executable',
    architecture.elfMachine
  )
  await verifyExecutable(
    path.join(root, 'app', 'resources', 'bin', 'motrix-native-host'),
    'native-host executable',
    architecture.elfMachine
  )
  await verifyExecutable(
    path.join(
      root,
      'app',
      'resources',
      'extra',
      'linux',
      architecture.electronArch,
      'aria2c'
    ),
    'aria2 executable',
    architecture.elfMachine
  )
  const resources = path.join(root, 'app', 'resources')
  const complianceFiles = [
    ['THIRD_PARTY_NOTICES.md', 'English third-party notices'],
    ['THIRD_PARTY_NOTICES.zh-CN.md', 'Chinese third-party notices'],
    [path.join('THIRD_PARTY_LICENSES', 'aria2-COPYING'), 'aria2 license text'],
    [
      path.join('legal', 'THIRD_PARTY_DEPENDENCIES.md'),
      'runtime dependency inventory',
    ],
    [
      path.join('legal', 'THIRD_PARTY_LICENSES.txt'),
      'consolidated third-party licenses',
    ],
    [path.join('legal', 'sbom.spdx.json'), 'SPDX SBOM'],
  ]
  await Promise.all(
    complianceFiles.map(([relativePath, label]) =>
      verifyRegularFile(path.join(resources, relativePath), label)
    )
  )

  return {
    arch,
    version,
  }
}

export async function verifySnapArtifact({
  snapPath,
  arch,
  version,
  unsquashfsPath = UNSQUASHFS_PATH,
}) {
  if (!path.isAbsolute(unsquashfsPath)) {
    throw new Error('unsquashfs path must be absolute')
  }
  const info = await lstat(snapPath).catch(() => null)
  if (!info?.isFile() || path.extname(snapPath) !== '.snap') {
    throw new Error(`Snap artifact is missing or invalid: ${snapPath}`)
  }

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'motrix-snap-verify-')
  )
  const extractedRoot = path.join(temporaryDirectory, 'root')
  try {
    try {
      await execFileAsync(
        unsquashfsPath,
        ['-no-xattrs', '-d', extractedRoot, path.resolve(snapPath)],
        { maxBuffer: 4 * 1024 * 1024 }
      )
    } catch (error) {
      throw new Error(
        `Failed to extract Snap with unsquashfs: ${error.message}`,
        { cause: error }
      )
    }
    return await verifyExtractedSnap({
      root: extractedRoot,
      arch,
      version,
    })
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (
      !['--snap', '--arch', '--version'].includes(option) ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error(`Invalid argument near "${option ?? ''}"`)
    }
    if (values.has(option)) throw new Error(`Duplicate argument: ${option}`)
    values.set(option, value)
  }
  return values
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  for (const option of ['--snap', '--arch', '--version']) {
    if (!args.has(option))
      throw new Error(`Missing required argument: ${option}`)
  }
  const result = await verifySnapArtifact({
    snapPath: path.resolve(args.get('--snap')),
    arch: args.get('--arch'),
    version: args.get('--version'),
  })
  console.log(`Verified Motrix ${result.version} Snap for ${result.arch}`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main()
}
