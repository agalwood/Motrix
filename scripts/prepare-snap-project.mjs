import { constants } from 'node:fs'
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseStrictSemVer } from './release-metadata.mjs'

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

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function assertSupportedArchitecture(arch) {
  const architecture = ARCHITECTURES[arch]
  if (!architecture) {
    throw new Error(
      `Unsupported Snap architecture "${arch}"; expected amd64 or arm64`
    )
  }
  return architecture
}

function assertVersion(version) {
  parseStrictSemVer(version, 'Snap version')
  if (version.length > 32) throw new Error('Snap version exceeds 32 characters')
}

async function assertRegularFile(filePath, label) {
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) {
    throw new Error(`${label} is missing or is not a regular file: ${filePath}`)
  }
  return info
}

async function readElfArchitecture(filePath) {
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

async function verifyElfExecutable(filePath, label, elfMachine) {
  const info = await assertRegularFile(filePath, label)
  if ((info.mode & 0o111) === 0) {
    throw new Error(`${label} is not executable: ${filePath}`)
  }
  if ((await readElfArchitecture(filePath)) !== elfMachine) {
    throw new Error(`${label} is not an ELF64 binary for the requested arch`)
  }
  await access(filePath, constants.X_OK)
}

async function assertContainedSymlinks(root) {
  const canonicalRoot = await realpath(root)

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const link = await readlink(entryPath)
        const target = await realpath(entryPath).catch(() => null)
        if (
          path.isAbsolute(link) ||
          !target ||
          (target !== canonicalRoot && !isInside(canonicalRoot, target))
        ) {
          throw new Error(
            `App directory contains an unsafe symlink: ${entryPath}`
          )
        }
      } else if (entry.isDirectory()) {
        await walk(entryPath)
      }
    }
  }

  await walk(canonicalRoot)
}

function renderTemplate(template, { arch, version }) {
  const rendered = template
    .replaceAll('@MOTRIX_VERSION@', version)
    .replaceAll('@SNAP_ARCH@', arch)
  if (/@[A-Z][A-Z0-9_]*@/.test(rendered)) {
    throw new Error('Snapcraft template contains an unresolved placeholder')
  }
  return rendered
}

export async function prepareSnapProject({
  projectDir,
  appDir,
  outputDir,
  arch,
  version,
}) {
  const architecture = assertSupportedArchitecture(arch)
  assertVersion(version)

  const canonicalProject = await realpath(projectDir)
  const releaseRoot = path.join(canonicalProject, 'release')
  const requestedOutputDir = path.resolve(outputDir)
  const resolvedAppDir = await realpath(path.resolve(appDir)).catch(() => null)
  const outputParent = await realpath(path.dirname(requestedOutputDir)).catch(
    () => null
  )
  const resolvedOutputDir = outputParent
    ? path.join(outputParent, path.basename(requestedOutputDir))
    : null

  if (!resolvedAppDir || !isInside(releaseRoot, resolvedAppDir)) {
    throw new Error(`App directory must be inside ${releaseRoot}`)
  }
  if (!resolvedOutputDir || !isInside(releaseRoot, resolvedOutputDir)) {
    throw new Error(`Output directory must be inside ${releaseRoot}`)
  }
  if (
    resolvedAppDir === resolvedOutputDir ||
    isInside(resolvedAppDir, resolvedOutputDir) ||
    isInside(resolvedOutputDir, resolvedAppDir)
  ) {
    throw new Error('App and output directories must not overlap')
  }

  const canonicalAppDir = resolvedAppDir
  const appInfo = await stat(canonicalAppDir).catch(() => null)
  if (!appInfo?.isDirectory()) {
    throw new Error(`App directory is missing or unsafe: ${resolvedAppDir}`)
  }

  await assertContainedSymlinks(canonicalAppDir)

  const binaries = [
    {
      path: path.join(canonicalAppDir, 'motrix'),
      label: 'Motrix executable',
    },
    {
      path: path.join(
        canonicalAppDir,
        'resources',
        'bin',
        'motrix-native-host'
      ),
      label: 'native-host executable',
    },
    {
      path: path.join(
        canonicalAppDir,
        'resources',
        'extra',
        'linux',
        architecture.electronArch,
        'aria2c'
      ),
      label: 'aria2 executable',
    },
  ]
  for (const binary of binaries) {
    await verifyElfExecutable(
      binary.path,
      binary.label,
      architecture.elfMachine
    )
  }

  const templatePath = path.join(
    canonicalProject,
    'build',
    'snap',
    'snapcraft.yaml.in'
  )
  const desktopPath = path.join(
    canonicalProject,
    'build',
    'snap',
    'gui',
    'motrix.desktop'
  )
  const iconPath = path.join(canonicalProject, 'build', '256x256.png')
  await Promise.all([
    assertRegularFile(templatePath, 'Snapcraft template'),
    assertRegularFile(desktopPath, 'Snap desktop file'),
    assertRegularFile(iconPath, 'Snap icon'),
  ])

  await mkdir(releaseRoot, { recursive: true })
  const stagingDir = await mkdtemp(path.join(releaseRoot, '.snap-project-'))
  try {
    const stagedApp = path.join(stagingDir, 'app')
    const stagedGui = path.join(stagingDir, 'snap', 'gui')
    await cp(canonicalAppDir, stagedApp, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
    await Promise.all([
      rm(path.join(stagedApp, 'chrome-sandbox'), { force: true }),
      rm(path.join(stagedApp, 'resources', 'app-update.yml'), { force: true }),
    ])

    await mkdir(stagedGui, { recursive: true })
    const template = await readFile(templatePath, 'utf8')
    await Promise.all([
      writeFile(
        path.join(stagingDir, 'snap', 'snapcraft.yaml'),
        renderTemplate(template, { arch, version }),
        { encoding: 'utf8', mode: 0o644 }
      ),
      copyFile(desktopPath, path.join(stagedGui, 'motrix.desktop')),
      copyFile(iconPath, path.join(stagedGui, 'icon.png')),
    ])

    for (const binary of binaries) {
      const relative = path.relative(canonicalAppDir, binary.path)
      await verifyElfExecutable(
        path.join(stagedApp, relative),
        `staged ${binary.label}`,
        architecture.elfMachine
      )
    }
    if (await lstat(path.join(stagedApp, 'chrome-sandbox')).catch(() => null)) {
      throw new Error('chrome-sandbox must not be staged in the Snap project')
    }

    await rm(resolvedOutputDir, { recursive: true, force: true })
    await rename(stagingDir, resolvedOutputDir)
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true })
    throw error
  }

  return {
    arch,
    electronArch: architecture.electronArch,
    outputDir: requestedOutputDir,
    version,
  }
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if (
      !['--arch', '--version', '--app-dir', '--output-dir'].includes(option) ||
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
  const projectDir = fileURLToPath(new URL('..', import.meta.url))
  for (const option of ['--arch', '--version', '--app-dir', '--output-dir']) {
    if (!args.has(option))
      throw new Error(`Missing required argument: ${option}`)
  }
  const result = await prepareSnapProject({
    projectDir,
    appDir: args.get('--app-dir'),
    outputDir: args.get('--output-dir'),
    arch: args.get('--arch'),
    version: args.get('--version'),
  })
  console.log(
    `Prepared ${result.arch} Snapcraft project at ${result.outputDir}`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main()
}
