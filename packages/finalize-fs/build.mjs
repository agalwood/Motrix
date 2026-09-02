#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const targets = new Map([
  ['darwin-arm64', 'aarch64-apple-darwin'],
  ['darwin-x64', 'x86_64-apple-darwin'],
  ['linux-arm64', 'aarch64-unknown-linux-musl'],
  ['linux-x64', 'x86_64-unknown-linux-musl'],
  ['win32-x64', 'x86_64-pc-windows-msvc'],
])

function parseArgs(argv) {
  const out = { platform: process.platform, arch: process.arch }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') continue
    if (token !== '--platform' && token !== '--arch') {
      throw new Error(`unknown flag: ${token}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${token} requires a value`)
    }
    out[token.slice(2)] = value
    index += 1
  }
  return out
}

const selected = parseArgs(process.argv.slice(2))
const key = `${selected.platform}-${selected.arch}`
const rustTarget = targets.get(key)
if (!rustTarget) throw new Error(`unsupported finalize-fs target: ${key}`)
const binary =
  selected.platform === 'win32'
    ? 'motrix-finalize-fs.exe'
    : 'motrix-finalize-fs'
const targetDir = path.join(packageDir, 'target')
const result = spawnSync(
  process.env.CARGO || 'cargo',
  [
    'build',
    '--manifest-path',
    path.join(packageDir, 'Cargo.toml'),
    '--release',
    '--locked',
    '--target',
    rustTarget,
    '--target-dir',
    targetDir,
  ],
  { cwd: packageDir, env: process.env, stdio: 'inherit' }
)
if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`cargo failed for ${key} with exit code ${result.status}`)
}
const outputDir = path.join(packageDir, 'dist', key)
const output = path.join(outputDir, binary)
await mkdir(outputDir, { recursive: true })
await copyFile(path.join(targetDir, rustTarget, 'release', binary), output)
if (selected.platform !== 'win32') await chmod(output, 0o755)
process.stdout.write(`built ${key}: ${output}\n`)
