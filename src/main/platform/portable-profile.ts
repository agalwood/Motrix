import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export interface PortableProfile {
  readonly root: string
  readonly dataDir: string
  readonly userDataDir: string
  readonly workDir: string
  readonly tempDir: string
  readonly downloadsDir: string
}

let activeProfile: PortableProfile | null = null

export function getPortableProfile(): PortableProfile | null {
  return activeProfile
}

export function setPortableProfile(profile: PortableProfile | null): void {
  activeProfile = profile
}

export class PortableProfileError extends Error {}

/** A directory is an explicit opt-in. Installed NSIS and Store apps ignore it. */
export function resolvePortableProfile(options: {
  platform: NodeJS.Platform
  isPackaged: boolean
  isWindowsPackage: boolean
  executablePath: string
}): PortableProfile | null {
  if (
    options.platform !== 'win32' ||
    !options.isPackaged ||
    options.isWindowsPackage
  )
    return null
  const root = path.win32.dirname(options.executablePath)
  if (existsSync(path.win32.join(root, 'Uninstall Motrix.exe'))) return null
  const dataDir = path.win32.join(root, 'data')
  try {
    if (!statSync(dataDir).isDirectory())
      throw new PortableProfileError(
        'The portable data path must be a directory'
      )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new PortableProfileError(
      'The portable data directory is unavailable',
      { cause: error }
    )
  }
  return {
    root,
    dataDir,
    userDataDir: path.win32.join(dataDir, 'user-data'),
    workDir: path.win32.join(dataDir, 'work'),
    tempDir: path.win32.join(dataDir, 'tmp'),
    downloadsDir: path.win32.join(root, 'Downloads'),
  }
}

/** Probe actual writes; access(W_OK) alone is insufficient on Windows ACLs. */
export function preparePortableProfile(profile: PortableProfile): void {
  try {
    for (const directory of [
      profile.dataDir,
      profile.userDataDir,
      profile.workDir,
      profile.tempDir,
      path.win32.join(profile.userDataDir, 'logs'),
      path.win32.join(profile.userDataDir, 'crashes'),
    ]) {
      mkdirSync(directory, { recursive: true })
      const probe = path.join(directory, `.write-test-${randomUUID()}`)
      writeFileSync(probe, '', { flag: 'wx' })
      unlinkSync(probe)
    }
  } catch (error) {
    throw new PortableProfileError(
      'The portable data directory is not writable',
      { cause: error }
    )
  }
}
