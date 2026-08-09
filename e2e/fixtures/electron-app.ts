import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  test as base,
  type ElectronApplication,
  _electron as electron,
  type Page,
} from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../../src/core/settings/migrations'
import { getFreePort } from '../helpers/free-port'
import { type HttpFixture, startHttpFixture } from './http-server'

interface MotrixFixtures {
  userDataDir: string
  rpcPort: number
  electronApp: ElectronApplication
  mainWindow: Page
  httpFixture: HttpFixture
}

// package.json has "type": "module", so __dirname isn't defined here.
// Resolve via import.meta.url. e2e/fixtures/ → repo root is two levels up.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

export const test = base.extend<MotrixFixtures>({
  // Per-test tmp userData. Cleanup runs after the test even if it
  // failed — `force: true` on rm so a held SQLite handle doesn't
  // wedge the cleanup. Empty destructure is Playwright's fixture
  // signature for "no upstream fixtures consumed".
  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  userDataDir: async ({}, use) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'motrix-e2e-'))
    try {
      await use(dir)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  },

  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  rpcPort: async ({}, use) => {
    const port = await getFreePort()
    await use(port)
  },

  electronApp: async ({ userDataDir, rpcPort }, use) => {
    const app = await launchMotrix({ userDataDir, rpcPort })
    try {
      await use(app)
    } finally {
      await app.close().catch(() => {})
    }
  },

  mainWindow: async ({ electronApp }, use) => {
    // Motrix's main window is the first window opened on app.ready.
    // The add-task window is precreated 2s later (see main/index.ts);
    // firstWindow() resolves before that, so we always get main here.
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },

  // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
  httpFixture: async ({}, use) => {
    const fx = await startHttpFixture()
    try {
      await use(fx)
    } finally {
      await fx.close().catch(() => {})
    }
  },
})

/**
 * Polls the engine status query until the supervisor reports `Ready`.
 * Run this before any spec that exercises the download pipeline so the
 * AddDownload command doesn't race aria2 startup.
 */
export async function waitForEngineReady(
  page: Page,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          motrix?: { invoke: (channel: string) => Promise<unknown> }
        }
      ).motrix
      if (!api) return null
      const result = (await api.invoke('query:getEngineStatus')) as {
        state: string
      }
      return result?.state ?? null
    })
    if (state === 'ready') return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`engine did not reach Ready within ${timeoutMs}ms`)
}

/**
 * Resolves the add-task `Page` from the running ElectronApplication.
 * Motrix opens it as a separate BrowserWindow whose URL carries
 * `?w=add-task` (see main/window/window-manager). The window is
 * pre-created ~2s after main opens, so the find may need to retry.
 */
export async function findAddTaskWindow(
  electronApp: ElectronApplication,
  timeoutMs = 10_000
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = electronApp
      .windows()
      .find((w) => w.url().includes('w=add-task'))
    if (found) {
      await found.waitForLoadState('domcontentloaded')
      return found
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `add-task window did not appear within ${timeoutMs}ms (windows: ${electronApp
      .windows()
      .map((w) => w.url())
      .join(', ')})`
  )
}

export interface LaunchOptions {
  userDataDir: string
  rpcPort: number
  commandLineArgs?: readonly string[]
  extraEnv?: NodeJS.ProcessEnv
  disclaimerAccepted?: boolean
}

/**
 * Spawn a Motrix Electron process with hermetic per-launch state.
 * Exposed (in addition to the `electronApp` fixture) for specs that
 * need to launch and close the app multiple times within a single
 * test — e.g. asserting that a setting persists across restarts.
 */
export async function launchMotrix(
  opts: LaunchOptions
): Promise<ElectronApplication> {
  // Save dir lives under userDataDir/downloads so cleanup of the
  // tmp dir wipes all downloaded artifacts in one go. Without this
  // override SettingsManager.seedSentinels falls back to ~/Downloads,
  // which leaks test files into the developer's home directory.
  const saveDir = path.join(opts.userDataDir, 'downloads')

  // Most end-to-end specs exercise the main application, so seed only the
  // legal consent bit before the first launch. A disclaimer-specific spec can
  // opt out, and subsequent launches keep the settings written by the app.
  await writeFile(
    path.join(opts.userDataDir, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      onboarding: {
        disclaimerAccepted: opts.disclaimerAccepted ?? true,
      },
    }),
    { encoding: 'utf8', flag: 'wx' }
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })

  return electron.launch({
    // Launch the package root so Electron reads package.json and reports the
    // Motrix app version. Pointing directly at dist/main/index.cjs makes
    // app.getVersion() fall back to Electron's own version, which incorrectly
    // rejects version-bounded built-in plugins during registry discovery.
    args: [REPO_ROOT, ...(opts.commandLineArgs ?? [])],
    cwd: opts.userDataDir,
    env: {
      ...process.env,
      ...opts.extraEnv,
      MOTRIX_USER_DATA: opts.userDataDir,
      MOTRIX_RPC_PORT: String(opts.rpcPort),
      MOTRIX_DEFAULT_SAVE_DIR: saveDir,
      // Force production paths in renderer (no Vite dev server).
      NODE_ENV: 'test',
    },
  })
}

export { expect } from '@playwright/test'
