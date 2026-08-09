#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FLATPAK_COMPANION_BINARY } from './package-flatpak-companion.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const PACKAGE_DIR = path.dirname(SCRIPT_PATH)

export const BUILD_TARGETS = new Map([
  [
    'darwin-arm64',
    { rustTarget: 'aarch64-apple-darwin', binaryName: 'motrix-native-host' },
  ],
  [
    'darwin-x64',
    { rustTarget: 'x86_64-apple-darwin', binaryName: 'motrix-native-host' },
  ],
  [
    'linux-x64',
    {
      rustTarget: 'x86_64-unknown-linux-musl',
      binaryName: 'motrix-native-host',
      companionBinaryName: FLATPAK_COMPANION_BINARY,
    },
  ],
  [
    'linux-arm64',
    {
      rustTarget: 'aarch64-unknown-linux-musl',
      binaryName: 'motrix-native-host',
      companionBinaryName: FLATPAK_COMPANION_BINARY,
    },
  ],
  [
    'win32-x64',
    {
      rustTarget: 'x86_64-pc-windows-msvc',
      binaryName: 'motrix-native-host.exe',
    },
  ],
  // Reserved for a future release matrix. This mapping does not create a
  // placeholder and is only built when an actual Windows arm64 job invokes it.
  [
    'win32-arm64',
    {
      rustTarget: 'aarch64-pc-windows-msvc',
      binaryName: 'motrix-native-host.exe',
    },
  ],
])

export function parseArgs(argv) {
  const args = { platform: undefined, arch: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') continue
    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    const flag = equals === -1 ? token : token.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1)
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`)
      }
      index += 1
      return value
    }

    if (flag === '--platform') args.platform = readValue()
    else if (flag === '--arch') args.arch = readValue()
    else throw new Error(`unknown flag: ${token}`)
  }
  if ((args.platform === undefined) !== (args.arch === undefined)) {
    throw new Error('--platform and --arch must be provided together')
  }
  return args
}

export function resolveBuildTarget(
  args,
  env = process.env,
  host = { platform: process.platform, arch: process.arch }
) {
  let platform
  let arch
  if (args.platform !== undefined) {
    platform = args.platform
    arch = args.arch
  } else {
    const envPlatform = env.MOTRIX_NATIVE_HOST_PLATFORM
    const envArch = env.MOTRIX_NATIVE_HOST_ARCH
    if ((envPlatform === undefined) !== (envArch === undefined)) {
      throw new Error(
        'native-host platform/arch environment overrides must be provided together'
      )
    }
    platform = envPlatform ?? host.platform
    arch = envArch ?? host.arch
  }
  const key = `${platform}-${arch}`
  const target = BUILD_TARGETS.get(key)
  if (!target) {
    throw new Error(
      `unsupported native-host target ${key}; supported targets: ${[
        ...BUILD_TARGETS.keys(),
      ].join(', ')}`
    )
  }
  return { key, platform, arch, ...target }
}

export function cargoBuildArguments(target, targetDir) {
  const binaryNames = [
    path.parse(target.binaryName).name,
    ...(target.companionBinaryName ? [target.companionBinaryName] : []),
  ]
  return [
    'build',
    '--manifest-path',
    path.join(PACKAGE_DIR, 'Cargo.toml'),
    '--release',
    '--locked',
    '--target',
    target.rustTarget,
    '--target-dir',
    targetDir,
    ...binaryNames.flatMap((binaryName) => ['--bin', binaryName]),
  ]
}

export async function buildNativeHost({
  args = parseArgs(process.argv.slice(2)),
  env = process.env,
  host,
} = {}) {
  const target = resolveBuildTarget(args, env, host)
  const targetDir = env.CARGO_TARGET_DIR
    ? path.resolve(PACKAGE_DIR, env.CARGO_TARGET_DIR)
    : path.join(PACKAGE_DIR, 'target')
  const cargo = env.CARGO || 'cargo'
  const result = spawnSync(cargo, cargoBuildArguments(target, targetDir), {
    cwd: PACKAGE_DIR,
    env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `cargo failed for ${target.key} with exit code ${result.status ?? 'unknown'}`
    )
  }

  const source = path.join(
    targetDir,
    target.rustTarget,
    'release',
    target.binaryName
  )
  const outputDir = path.join(PACKAGE_DIR, 'dist', target.key)
  const output = path.join(outputDir, target.binaryName)
  await mkdir(outputDir, { recursive: true })
  await copyFile(source, output)
  if (target.platform !== 'win32') await chmod(output, 0o755)
  let companionOutput
  if (target.companionBinaryName) {
    const companionSource = path.join(
      targetDir,
      target.rustTarget,
      'release',
      target.companionBinaryName
    )
    companionOutput = path.join(outputDir, target.companionBinaryName)
    await copyFile(companionSource, companionOutput)
    await chmod(companionOutput, 0o755)
  }
  process.stdout.write(`built ${target.key}: ${output}\n`)
  if (companionOutput) {
    process.stdout.write(
      `built ${target.key} Flatpak companion: ${companionOutput}\n`
    )
  }
  return { ...target, output, companionOutput }
}

async function main() {
  try {
    await buildNativeHost()
  } catch (error) {
    process.stderr.write(
      `native-host build failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main()
}
