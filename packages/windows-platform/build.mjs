#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const PACKAGE_DIR = path.dirname(SCRIPT_PATH)
export const WINDOWS_PLATFORM_TARGET = Object.freeze({
  key: 'win32-x64',
  rustTarget: 'x86_64-pc-windows-msvc',
  binaryName: 'motrix-windows-platform.exe',
})

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== '--platform' && flag !== '--arch') {
      throw new Error(`unknown flag: ${flag}`)
    }
    const key = flag.slice(2)
    if (Object.hasOwn(options, key)) throw new Error(`duplicate flag: ${flag}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    options[key] = value
  }
  if (options.platform !== 'win32' || options.arch !== 'x64') {
    throw new Error(
      'windows-platform requires explicit --platform win32 --arch x64'
    )
  }
  return options
}

export function cargoBuildArguments(targetDirectory) {
  return [
    'build',
    '--manifest-path',
    path.join(PACKAGE_DIR, 'Cargo.toml'),
    '--release',
    '--locked',
    '--target',
    WINDOWS_PLATFORM_TARGET.rustTarget,
    '--target-dir',
    targetDirectory,
    '--bin',
    'motrix-windows-platform',
  ]
}

export async function buildWindowsPlatform({
  argv = process.argv.slice(2),
  env = process.env,
  run = spawnSync,
} = {}) {
  parseArgs(argv)
  const targetDirectory = env.CARGO_TARGET_DIR
    ? path.resolve(PACKAGE_DIR, env.CARGO_TARGET_DIR)
    : path.join(PACKAGE_DIR, 'target')
  // Cargo discovers the repository's existing MSVC static-CRT configuration
  // from this package directory. No other platform binaries are produced.
  const result = run(
    env.CARGO || 'cargo',
    cargoBuildArguments(targetDirectory),
    {
      cwd: PACKAGE_DIR,
      env,
      shell: false,
      stdio: 'inherit',
    }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `cargo failed for win32-x64 with exit code ${result.status ?? 'unknown'}`
    )
  }
  const { key, rustTarget, binaryName } = WINDOWS_PLATFORM_TARGET
  const source = path.join(targetDirectory, rustTarget, 'release', binaryName)
  const outputDirectory = path.join(PACKAGE_DIR, 'dist', key)
  const output = path.join(outputDirectory, binaryName)
  await mkdir(outputDirectory, { recursive: true })
  await copyFile(source, output)
  process.stdout.write(`built ${key}: ${output}\n`)
  return { ...WINDOWS_PLATFORM_TARGET, output }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    await buildWindowsPlatform()
  } catch (error) {
    process.stderr.write(`windows-platform build failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
