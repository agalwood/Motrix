// electron-builder beforePack hook: fail fast when a target's bundled assets
// are missing, instead of shipping an engine-less app or dying mid-copy.
// Guards two concrete per-arch executables:
//   extra/<platform>/<arch>/aria2c[.exe]        — the download engine
//   packages/native-host/dist/<platform>-<arch>/
//     motrix-native-host[.exe]                  — the browser-bridge host
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { assertNativeBinaryTarget } from './native-binary-target.mjs'

// electron-builder Arch enum ordinals (builder-util/src/arch.ts).
const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
}

async function verifyExecutable(filePath, label, platform, arch) {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    throw new Error(`[before-pack-verify] missing ${label}: ${filePath}`)
  }

  if (!fileStat.isFile()) {
    throw new Error(
      `[before-pack-verify] ${label} is not a regular file: ${filePath}`
    )
  }

  try {
    await assertNativeBinaryTarget(filePath, platform, arch, {
      allowUniversal: platform === 'darwin',
      label,
    })
  } catch {
    throw new Error(
      `[before-pack-verify] ${label} is not a ${platform}-${arch} executable: ${filePath}`
    )
  }

  if (platform !== 'win32') {
    try {
      await access(filePath, constants.X_OK)
    } catch {
      throw new Error(
        `[before-pack-verify] ${label} is not executable: ${filePath}`
      )
    }
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `[before-pack-verify] missing or invalid ${label}: ${filePath}`,
      {
        cause: error,
      }
    )
  }
}

async function verifyStage(projectDir, platform, arch) {
  const manifestPath = path.join(
    projectDir,
    'dist/electron-app/.motrix-package-stage.json'
  )
  const stage = await readJson(manifestPath, 'Electron package stage manifest')
  const rootManifest = await readJson(
    path.join(projectDir, 'package.json'),
    'root package manifest'
  )
  const expectedKey = `${platform}-${arch}`
  if (
    stage.schemaVersion !== 1 ||
    stage.target?.platform !== platform ||
    stage.target?.arch !== arch ||
    stage.target?.key !== expectedKey
  ) {
    throw new Error(
      `[before-pack-verify] stage target does not match ${expectedKey}; run "pnpm run stage:electron -- --platform ${platform} --arch ${arch}"`
    )
  }
  if (stage.rootVersion !== rootManifest.version) {
    throw new Error(
      `[before-pack-verify] stage version ${stage.rootVersion} does not match root version ${rootManifest.version}`
    )
  }
  if (!Array.isArray(stage.buildOutputs) || stage.buildOutputs.length !== 4) {
    throw new Error(
      '[before-pack-verify] stage build-output inventory is missing'
    )
  }
  for (const output of stage.buildOutputs) {
    if (
      typeof output.path !== 'string' ||
      typeof output.sha256 !== 'string' ||
      !Number.isSafeInteger(output.bytes)
    ) {
      throw new Error(
        '[before-pack-verify] stage build-output inventory is invalid'
      )
    }
    const bytes = await readFile(path.join(projectDir, output.path)).catch(
      () => null
    )
    const sha256 = bytes
      ? createHash('sha256').update(bytes).digest('hex')
      : undefined
    if (bytes?.length !== output.bytes || sha256 !== output.sha256) {
      throw new Error(
        `[before-pack-verify] stage is stale for ${output.path}; rerun staging`
      )
    }
  }
}

export default async function beforePack(context) {
  const platform = context.electronPlatformName // darwin | win32 | linux
  const archName = ARCH_NAMES[context.arch]
  if (!archName)
    throw new Error(
      `[before-pack-verify] unknown arch ordinal: ${context.arch}`
    )

  const projectDir =
    context.packager.projectDir ?? context.packager.info.projectDir
  if (archName === 'universal') {
    throw new Error(
      '[before-pack-verify] universal Electron packages are unsupported'
    )
  }
  await verifyStage(projectDir, platform, archName)
  const engineBin = platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  const hostBin =
    platform === 'win32' ? 'motrix-native-host.exe' : 'motrix-native-host'
  const arches = [archName]

  for (const arch of arches) {
    const engine = path.join(projectDir, 'extra', platform, arch, engineBin)
    await verifyExecutable(engine, 'bundled aria2 engine', platform, arch)

    const host = path.join(
      projectDir,
      'packages',
      'native-host',
      'dist',
      `${platform}-${arch}`,
      hostBin
    )
    await verifyExecutable(host, 'native-host binary', platform, arch)
  }
}
