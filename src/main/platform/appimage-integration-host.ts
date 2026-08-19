import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { getLogger } from '@core/logger'
import { app, dialog } from 'electron'
import writeFileAtomic from 'write-file-atomic'
import { i18n } from '../lib/i18n'
import {
  type AppImageIntegrationDeps,
  type CommandResult,
  DEFAULT_INTEGRATION_RECORD,
  type IntegrationFs,
  type IntegrationRecord,
  type IntegrationStore,
  parseIntegrationRecord,
  runStartupIntegration,
} from './appimage-integration'

// Electron/Node adapter for the AppImage desktop integration. The core state
// machine in `appimage-integration.ts` is port-only and fully unit-tested; this
// file supplies the real filesystem, `xdg-*` runner, persisted store, consent
// dialog, and startup guard.

const execFileAsync = promisify(execFile)

const INTEGRATION_FILE = 'appimage-integration.json'
const ICON_RESOURCE = path.join('icons', 'motrix-appimage-256.png')
const COMMAND_TIMEOUT_MS = 10_000

function createFileIntegrationStore(filePath: string): IntegrationStore {
  return {
    async load() {
      try {
        const raw = await readFile(filePath, 'utf-8')
        return parseIntegrationRecord(JSON.parse(raw))
      } catch {
        return { ...DEFAULT_INTEGRATION_RECORD }
      }
    },
    async save(record: IntegrationRecord) {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFileAtomic(filePath, JSON.stringify(record, null, 2), {
        encoding: 'utf-8',
      })
    },
  }
}

const hostFs: IntegrationFs = {
  // Atomic write (temp + rename): never leaves a partially-written desktop
  // entry, and does not follow a dangling symlink squatting the target path.
  writeText: (filePath, data) =>
    writeFileAtomic(filePath, data, { encoding: 'utf-8' }),
  readText: (filePath) => readFile(filePath, 'utf-8'),
  readBytes: (filePath) => readFile(filePath),
  remove: (filePath) => rm(filePath, { force: true }),
  mkdirp: async (dirPath) => {
    await mkdir(dirPath, { recursive: true })
  },
  copyFile: (src, dest) => copyFile(src, dest),
}

async function runCommand(
  command: string,
  args: string[]
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
    })
    return { code: 0, stdout: String(stdout), stderr: String(stderr) }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string
      stdout?: string
      stderr?: string
    }
    const numericCode = typeof e.code === 'number' ? e.code : 127
    return {
      code: numericCode,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    }
  }
}

export interface SetupAppImageIntegrationOptions {
  getMagnetEnabled: () => boolean
}

// Startup entry point wired from main/index.ts. No-op unless running as a
// packaged Linux AppImage (`process.env.APPIMAGE` is only set by the AppImage
// runtime). Never throws into the caller.
export async function setupAppImageIntegration(
  opts: SetupAppImageIntegrationOptions
): Promise<void> {
  const log = getLogger('appimage')
  if (process.platform !== 'linux' || !app.isPackaged) return
  const appImagePath = process.env.APPIMAGE
  if (!appImagePath) return

  const deps: AppImageIntegrationDeps = {
    appImagePath,
    env: process.env,
    homedir: app.getPath('home'),
    iconSourcePath: path.join(process.resourcesPath, ICON_RESOURCE),
    store: createFileIntegrationStore(
      path.join(app.getPath('userData'), INTEGRATION_FILE)
    ),
    fs: hostFs,
    runCommand,
    getMagnetEnabled: opts.getMagnetEnabled,
    prompt: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: [
          i18n.t('settings.integration.appimage.prompt.decline'),
          i18n.t('settings.integration.appimage.prompt.accept'),
        ],
        defaultId: 1,
        cancelId: 0,
        title: i18n.t('settings.integration.appimage.prompt.title'),
        message: i18n.t('settings.integration.appimage.prompt.message'),
        detail: i18n.t('settings.integration.appimage.prompt.detail'),
      })
      return response === 1
    },
    log,
  }

  try {
    await runStartupIntegration(deps)
  } catch (err) {
    log.warn({ err }, 'appimage desktop integration failed')
  }
}

// TODO(Layer 3a): the browser bridge unconditionally syncs native-messaging
// manifests on startup (src/main/bridge/index.ts:648). That sync must become
// gated on this module's `nmConsent` once Layer 3a lands, so an AppImage that
// declined desktop integration never writes NM manifests. Not changed here.
