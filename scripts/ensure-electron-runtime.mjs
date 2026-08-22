#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export const REQUIRED_ELECTRON_RUNTIME_FILES = [
  'dist/LICENSE',
  'dist/LICENSES.chromium.html',
  'dist/version',
  'path.txt',
]

const defaultFs = {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
}

function readTrimmed(filePath, fs = defaultFs) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim()
  } catch {
    return null
  }
}

function isNonEmptyFile(filePath, fs = defaultFs) {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

export function inspectElectronRuntime(electronPackageDir, fs = defaultFs) {
  const issues = []
  const manifestPath = path.join(electronPackageDir, 'package.json')
  let expectedVersion = null

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expectedVersion =
      typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    issues.push('package.json is missing or invalid')
  }

  for (const relativePath of REQUIRED_ELECTRON_RUNTIME_FILES) {
    if (!isNonEmptyFile(path.join(electronPackageDir, relativePath), fs)) {
      issues.push(`${relativePath} is missing or empty`)
    }
  }

  const installedVersion = readTrimmed(
    path.join(electronPackageDir, 'dist', 'version'),
    fs
  )?.replace(/^v/, '')
  if (
    expectedVersion &&
    installedVersion &&
    installedVersion !== expectedVersion
  ) {
    issues.push(
      `dist/version is ${installedVersion}, expected ${expectedVersion}`
    )
  }

  const executableRelativePath = readTrimmed(
    path.join(electronPackageDir, 'path.txt'),
    fs
  )
  if (executableRelativePath) {
    const distDir = path.resolve(electronPackageDir, 'dist')
    const executablePath = path.resolve(distDir, executableRelativePath)
    const relativeToDist = path.relative(distDir, executablePath)
    if (
      relativeToDist.startsWith('..') ||
      path.isAbsolute(relativeToDist) ||
      !isNonEmptyFile(executablePath, fs)
    ) {
      issues.push(`Electron executable is missing: ${executableRelativePath}`)
    }
  }

  return {
    complete: issues.length === 0,
    expectedVersion,
    issues,
  }
}

function moveAside(targetPath, fs = defaultFs) {
  if (!fs.existsSync(targetPath)) return null
  const backupPath = `${targetPath}.motrix-backup-${randomUUID()}`
  fs.renameSync(targetPath, backupPath)
  return backupPath
}

function removeIfPresent(targetPath, fs = defaultFs) {
  if (!targetPath) return
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true, recursive: true })
  }
}

function restoreBackup(targetPath, backupPath, hadOriginal, fs = defaultFs) {
  if (!hadOriginal) {
    removeIfPresent(targetPath, fs)
    return
  }

  // Do not delete an original payload when moving it aside failed before a
  // backup path could be recorded, or when the backup unexpectedly vanished.
  if (!backupPath) {
    if (fs.existsSync(targetPath)) return
    throw new Error(`backup is unavailable for ${targetPath}`)
  }
  if (!fs.existsSync(backupPath)) {
    throw new Error(`backup is unavailable for ${targetPath}`)
  }

  removeIfPresent(targetPath, fs)
  fs.renameSync(backupPath, targetPath)
}

function removeBackupBestEffort(backupPath, fs, logError) {
  try {
    removeIfPresent(backupPath, fs)
  } catch (error) {
    logError(
      `[ensure-electron-runtime] repaired runtime is valid, but its temporary backup could not be removed: ${error?.message ?? error}`
    )
  }
}

export function resolveElectronPackageDir() {
  return path.dirname(require.resolve('electron'))
}

export function ensureElectronRuntime(options = {}) {
  const fs = options.fs ?? defaultFs
  const spawn = options.spawn ?? spawnSync
  const log = options.log ?? console.log
  const logError = options.logError ?? console.error
  let electronPackageDir

  try {
    electronPackageDir =
      options.electronPackageDir ?? resolveElectronPackageDir()
  } catch (error) {
    logError(
      `[ensure-electron-runtime] Electron package is unavailable; run pnpm install first: ${error?.message ?? error}`
    )
    return 1
  }

  const before = inspectElectronRuntime(electronPackageDir, fs)
  if (before.complete) {
    log(
      `[ensure-electron-runtime] Electron ${before.expectedVersion ?? ''} runtime is complete`
    )
    return 0
  }

  const installerPath = path.join(electronPackageDir, 'install.js')
  if (!isNonEmptyFile(installerPath, fs)) {
    logError(
      `[ensure-electron-runtime] Electron installer is missing: ${installerPath}`
    )
    return 1
  }

  log(
    `[ensure-electron-runtime] repairing incomplete Electron runtime: ${before.issues.join('; ')}`
  )

  const distPath = path.join(electronPackageDir, 'dist')
  const pathFile = path.join(electronPackageDir, 'path.txt')
  const hadDist = fs.existsSync(distPath)
  const hadPathFile = fs.existsSync(pathFile)
  let distBackup = null
  let pathBackup = null

  try {
    // Electron 43's installer returns early when dist/version + the binary
    // look valid, even if runtime license files are missing. Move the entire
    // generated payload aside so every incomplete state gets a clean repair.
    distBackup = moveAside(distPath, fs)
    pathBackup = moveAside(pathFile, fs)

    const result = spawn(process.execPath, [installerPath], {
      env: options.env ?? process.env,
      stdio: 'inherit',
    })
    if (result.error) {
      throw result.error
    }
    if (result.signal) {
      throw new Error(`Electron installer was killed by ${result.signal}`)
    }
    if (result.status !== 0) {
      const error = new Error(
        `Electron installer exited with status ${result.status ?? 'unknown'}`
      )
      error.exitCode = result.status ?? 1
      throw error
    }

    const after = inspectElectronRuntime(electronPackageDir, fs)
    if (!after.complete) {
      throw new Error(
        `Electron installer completed without a valid runtime: ${after.issues.join('; ')}`
      )
    }

    // Cleanup is deliberately best-effort. Once the repaired runtime has been
    // validated, a backup cleanup error must not roll back working files.
    removeBackupBestEffort(distBackup, fs, logError)
    removeBackupBestEffort(pathBackup, fs, logError)
    log(
      `[ensure-electron-runtime] Electron ${after.expectedVersion ?? ''} runtime repaired`
    )
    return 0
  } catch (error) {
    const restoreErrors = []
    for (const [targetPath, backupPath, hadOriginal] of [
      [distPath, distBackup, hadDist],
      [pathFile, pathBackup, hadPathFile],
    ]) {
      try {
        restoreBackup(targetPath, backupPath, hadOriginal, fs)
      } catch (restoreError) {
        restoreErrors.push(restoreError?.message ?? String(restoreError))
      }
    }
    if (restoreErrors.length > 0) {
      logError(
        `[ensure-electron-runtime] failed to fully restore the previous runtime after repair failure: ${restoreErrors.join('; ')}`
      )
    }
    logError(
      `[ensure-electron-runtime] repair failed: ${error?.message ?? error}`
    )
    return Number.isInteger(error?.exitCode) ? error.exitCode : 1
  }
}

const invokedAsMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedAsMain) {
  process.exit(ensureElectronRuntime())
}
