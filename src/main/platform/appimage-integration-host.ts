import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { getLogger } from '@core/logger'
import type { AppImageIntegrationView } from '@shared/types/appimage-integration'
import { app, dialog } from 'electron'
import writeFileAtomic from 'write-file-atomic'
import { i18n } from '../lib/i18n'
import {
  type AppImageIntegrationDeps,
  type CommandResult,
  DEFAULT_INTEGRATION_RECORD,
  enableSystemIntegration,
  type IntegrationFs,
  type IntegrationRecord,
  type IntegrationStore,
  inspectSystemIntegration,
  parseIntegrationRecord,
  removeSystemIntegration,
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

// The AppImage environment gate: `process.env.APPIMAGE` is only set by the
// AppImage runtime, and only a packaged Linux build can be one.
function appImageEnvironmentPath(): string | null {
  if (process.platform !== 'linux' || !app.isPackaged) return null
  return process.env.APPIMAGE ?? null
}

function createHostStore(): IntegrationStore {
  return createFileIntegrationStore(
    path.join(app.getPath('userData'), INTEGRATION_FILE)
  )
}

// One deps assembly shared by the startup path and the settings IPC entry
// points; only the consent prompt differs (startup shows the dialog, a manual
// settings action *is* the consent).
function buildDeps(
  appImagePath: string,
  opts: SetupAppImageIntegrationOptions,
  prompt: () => Promise<boolean>
): AppImageIntegrationDeps {
  return {
    appImagePath,
    env: process.env,
    homedir: app.getPath('home'),
    iconSourcePath: path.join(process.resourcesPath, ICON_RESOURCE),
    store: createHostStore(),
    fs: hostFs,
    runCommand,
    getMagnetEnabled: opts.getMagnetEnabled,
    prompt,
    log: getLogger('appimage'),
  }
}

async function promptWithDialog(): Promise<boolean> {
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
}

function toView(record: IntegrationRecord): AppImageIntegrationView {
  return {
    supported: true,
    decision: record.decision,
    owner: record.owner,
    status: record.status,
  }
}

// Startup entry point wired from main/index.ts. No-op unless running as a
// packaged Linux AppImage. Never throws into the caller.
export async function setupAppImageIntegration(
  opts: SetupAppImageIntegrationOptions
): Promise<void> {
  const appImagePath = appImageEnvironmentPath()
  if (!appImagePath) return
  const deps = buildDeps(appImagePath, opts, promptWithDialog)
  try {
    await runStartupIntegration(deps)
  } catch (err) {
    deps.log.warn({ err }, 'appimage desktop integration failed')
  }
}

// Settings status query (Queries.GetAppImageIntegrationStatus): validates the
// persisted healthy state without mutating desktop files or defaults.
export async function getAppImageIntegrationView(
  opts: SetupAppImageIntegrationOptions
): Promise<AppImageIntegrationView> {
  const appImagePath = appImageEnvironmentPath()
  if (!appImagePath) return { supported: false }
  const deps = buildDeps(appImagePath, opts, async () => false)
  try {
    return toView(await inspectSystemIntegration(deps))
  } catch (err) {
    deps.log.warn({ err }, 'appimage integration status validation failed')
    const record = await deps.store.load()
    return toView(
      record.decision === 'accepted' && record.owner === 'self'
        ? { ...record, status: 'failed' }
        : record
    )
  }
}

// Settings action (Commands.EnableAppImageIntegration). The user clicked the
// enable button, so consent is already given — no dialog. Runs the full
// install transaction, including from a previously `declined` state.
export async function enableAppImageIntegrationFromSettings(
  opts: SetupAppImageIntegrationOptions
): Promise<AppImageIntegrationView> {
  const appImagePath = appImageEnvironmentPath()
  if (!appImagePath) return { supported: false }
  const deps = buildDeps(appImagePath, opts, async () => true)
  try {
    return toView(await enableSystemIntegration(deps))
  } catch (err) {
    deps.log.warn({ err }, 'manual appimage integration enable failed')
    return toView(await deps.store.load())
  }
}

// Settings action (Commands.RemoveAppImageIntegration). Externally-owned
// integrations are left untouched by the core module; the refreshed view
// reports that state back to the UI.
export async function removeAppImageIntegrationFromSettings(
  opts: SetupAppImageIntegrationOptions
): Promise<AppImageIntegrationView> {
  const appImagePath = appImageEnvironmentPath()
  if (!appImagePath) return { supported: false }
  const deps = buildDeps(appImagePath, opts, async () => true)
  try {
    return toView(await removeSystemIntegration(deps))
  } catch (err) {
    deps.log.warn({ err }, 'manual appimage integration removal failed')
    return toView(await deps.store.load())
  }
}

// Apply a saved magnet preference immediately for an existing self-owned
// AppImage integration. This deliberately does not prompt or create a new
// integration: users who declined (or have an externally-owned package) keep
// that decision, while an accepted integration no longer needs an app restart
// before its magnet default converges.
export async function reconcileAppImageIntegrationFromSettings(
  opts: SetupAppImageIntegrationOptions
): Promise<AppImageIntegrationView> {
  const appImagePath = appImageEnvironmentPath()
  if (!appImagePath) return { supported: false }
  const deps = buildDeps(appImagePath, opts, async () => false)
  try {
    const current = await deps.store.load()
    if (current.decision !== 'accepted' || current.owner !== 'self') {
      return toView(current)
    }
    return toView(await runStartupIntegration(deps))
  } catch (err) {
    deps.log.warn({ err }, 'appimage settings reconciliation failed')
    return toView(await deps.store.load())
  }
}

// TODO(Layer 3a): the browser bridge unconditionally syncs native-messaging
// manifests on startup (src/main/bridge/index.ts:648). That sync must become
// gated on this module's `nmConsent` once Layer 3a lands, so an AppImage that
// declined desktop integration never writes NM manifests. Not changed here.
