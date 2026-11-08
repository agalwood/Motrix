import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../../src/core/settings/migrations'
import { Commands } from '../../src/shared/protocol/commands'
import {
  test as base,
  expect,
  launchMotrix,
  waitForEngineReady,
  waitForQueryHandlers,
} from '../fixtures/electron-app'

const WM_SCHEMA = 'org.gnome.desktop.wm.preferences'
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface'

function setting(schema: string, key: string): string {
  return execFileSync('gsettings', ['get', schema, key], {
    encoding: 'utf8',
  }).trim()
}

function setSetting(schema: string, key: string, value: string): void {
  execFileSync('gsettings', ['set', schema, key, value])
}

const test = base.extend<{
  desktopLayout: string
  desktopGtkTheme: string
  gtkVersion: string
  desktop: undefined
}>({
  desktopLayout: [':minimize,maximize,close', { option: true }],
  desktopGtkTheme: ['Adwaita', { option: true }],
  gtkVersion: ['', { option: true }],
  desktop: async ({ desktopLayout, desktopGtkTheme }, use) => {
    const layout = setting(WM_SCHEMA, 'button-layout')
    const theme = setting(INTERFACE_SCHEMA, 'gtk-theme')
    try {
      setSetting(WM_SCHEMA, 'button-layout', desktopLayout)
      setSetting(INTERFACE_SCHEMA, 'gtk-theme', desktopGtkTheme)
      await use(undefined)
    } finally {
      setSetting(WM_SCHEMA, 'button-layout', layout)
      setSetting(INTERFACE_SCHEMA, 'gtk-theme', theme)
    }
  },
  electronApp: async (
    { desktop, gtkVersion, userDataDir, rpcPort },
    use,
    info
  ) => {
    void desktop
    await writeFile(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        version: CURRENT_SETTINGS_VERSION,
        app: {
          theme: 'light',
          language: 'en-US',
          autofillClipboardLinks: false,
          mainWindowMinWidth: 320,
          mainWindowMinHeight: 240,
          lightweightMode: false,
        },
        tracker: { autoSync: false },
        nat: { enabled: false },
        onboarding: { disclaimerAccepted: true },
      })
    )
    const app = await launchMotrix({
      userDataDir,
      rpcPort,
      commandLineArgs: [
        `--ozone-platform=${process.env.MOTRIX_E2E_OZONE_PLATFORM ?? 'wayland'}`,
        ...(gtkVersion ? [`--gtk-version=${gtkVersion}`] : []),
      ],
    })
    try {
      const environment = await app.evaluate(async ({ app, screen }) => {
        await app.whenReady()
        return {
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          ozone: app.commandLine.getSwitchValue('ozone-platform'),
          gtk: app.commandLine.getSwitchValue('gtk-version') || 'default',
          displays: screen.getAllDisplays().map((display) => ({
            bounds: display.bounds,
            workArea: display.workArea,
            scale: display.scaleFactor,
          })),
        }
      })
      await info.attach('native-environment', {
        body: JSON.stringify(environment, null, 2),
        contentType: 'application/json',
      })
      await use(app)
    } finally {
      await app.close().catch(() => {})
    }
  },
})

test.skip(
  process.platform !== 'linux',
  'Native WCO requires a Linux desktop session'
)

async function geometry(page: Page) {
  return page.evaluate(() => {
    const overlay = (
      navigator as Navigator & {
        windowControlsOverlay?: {
          visible: boolean
          getTitlebarAreaRect(): DOMRect
        }
      }
    ).windowControlsOverlay
    if (!overlay)
      throw new Error('Native Window Controls Overlay API is absent')
    const rect = overlay.getTitlebarAreaRect()
    return {
      visible: overlay.visible,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      right: innerWidth - rect.x - rect.width,
      scale: devicePixelRatio,
    }
  })
}

async function expectNativeControls(
  page: Page,
  layout: 'left' | 'right' | 'split'
) {
  await expect(page.locator('.window-chrome')).toBeVisible()
  await expect.poll(async () => (await geometry(page)).visible).toBe(true)
  await expect
    .poll(async () => {
      const rect = await geometry(page)
      return layout === 'left'
        ? rect.x > 40 && rect.right < 32
        : layout === 'right'
          ? rect.x < 32 && rect.right > 40
          : rect.x > 20 && rect.right > 20
    })
    .toBe(true)
  expect((await geometry(page)).height).toBe(54)
  await expect(
    page.locator('[data-slot="desktop-window-controls"]')
  ).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const overlay = (
          navigator as Navigator & {
            windowControlsOverlay: { getTitlebarAreaRect(): DOMRect }
          }
        ).windowControlsOverlay.getTitlebarAreaRect()
        return [
          ...document.querySelectorAll<HTMLElement>(
            '[data-slot="window-chrome-leading"] button, [data-slot="window-chrome-actions"] button, [data-slot="panel-shell-actions"] button'
          ),
        ]
          .filter((button) => button.getClientRects().length)
          .every((button) => {
            const bounds = button.getBoundingClientRect()
            return (
              bounds.y >= overlay.height ||
              (bounds.x >= overlay.x && bounds.right <= overlay.right)
            )
          })
      })
    )
    .toBe(true)
}

// Optional compositor capture bridge: write <id>.png and <id>.done, or
// <id>.jpg with { format: 'jpeg' } in the done file. Page screenshots omit
// native controls. No particular hypervisor or machine path is required.
async function captureNative(page: Page, info: TestInfo, label: string) {
  const state = await geometry(page)
  await info.attach(`${label}-geometry`, {
    body: JSON.stringify(state, null, 2),
    contentType: 'application/json',
  })
  const directory = process.env.MOTRIX_NATIVE_CAPTURE_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  const id = randomUUID()
  const pending = path.join(directory, `${id}.request.tmp`)
  await writeFile(pending, JSON.stringify({ id, label, state }))
  // Shared-folder guest and host UIDs can differ. Publish only non-secret
  // capture metadata, and only after it is readable by the capture runner.
  await chmod(pending, 0o644)
  await rename(pending, path.join(directory, `${id}.request.json`))
  await expect
    .poll(
      async () => {
        try {
          await access(path.join(directory, `${id}.done`))
          return true
        } catch {
          return false
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  const result = JSON.parse(
    await readFile(path.join(directory, `${id}.done`), 'utf8')
  )
  if (result.error) throw new Error(result.error)
  await info.attach(`${label}-native-desktop`, {
    path: path.join(
      directory,
      `${id}.${result.format === 'jpeg' ? 'jpg' : 'png'}`
    ),
    contentType: result.format === 'jpeg' ? 'image/jpeg' : 'image/png',
  })
}

for (const [layout, value] of [
  ['right', ':minimize,maximize,close'],
  ['left', 'close,minimize,maximize:'],
  ['split', 'close:minimize,maximize'],
] as const) {
  test.describe(`native ${layout} controls`, () => {
    test.use({ desktopLayout: value })
    test('matches actual native geometry and keeps downloads menus usable', async ({
      electronApp,
      mainWindow,
    }, info) => {
      await waitForQueryHandlers(mainWindow)
      await waitForEngineReady(mainWindow)
      await expectNativeControls(mainWindow, layout)
      await mainWindow
        .getByRole('link', { name: 'Downloads', exact: true })
        .click()
      await mainWindow
        .getByRole('button', { name: 'Toggle sidebar', exact: true })
        .click()
      await expectNativeControls(mainWindow, layout)
      const win = await electronApp.browserWindow(mainWindow)
      await win.evaluate((window) => window.setSize(640, 360))
      await expect
        .poll(async () => (await geometry(mainWindow)).viewportWidth)
        .toBe(640)
      const list = mainWindow.getByRole('button', {
        name: 'List View',
        exact: true,
      })
      if (await list.isVisible()) await list.click()
      else {
        await mainWindow
          .getByRole('button', { name: 'More', exact: true })
          .click()
        await mainWindow
          .getByRole('menuitem', { name: 'List View', exact: true })
          .hover()
      }
      await mainWindow
        .getByRole('menuitem', { name: 'Sort By', exact: true })
        .hover()
      const sort = mainWindow.getByRole('menu', {
        name: 'Sort By',
        exact: true,
      })
      await expect
        .poll(async () => (await sort.boundingBox())?.y)
        .toBeGreaterThanOrEqual(54)
      await sort
        .getByRole('menuitemradio', { name: 'Name', exact: true })
        .click()
      await expect(
        sort.getByRole('menuitemradio', { name: 'Name', exact: true })
      ).toHaveAttribute('aria-checked', 'true')
      await sort
        .getByRole('menuitemradio', { name: 'Descending', exact: true })
        .click()
      await expect(
        sort.getByRole('menuitemradio', { name: 'Descending', exact: true })
      ).toHaveAttribute('aria-checked', 'true')
      await mainWindow.keyboard.press('Escape')
      await mainWindow.keyboard.press('Escape')
      await captureNative(mainWindow, info, `${layout}-downloads`)
    })
  })
}

test('reacts to desktop layout changes and fullscreen on an existing window', async ({
  electronApp,
  mainWindow,
}, info) => {
  await waitForQueryHandlers(mainWindow)
  await expectNativeControls(mainWindow, 'right')
  setSetting(WM_SCHEMA, 'button-layout', 'close,minimize,maximize:')
  await expectNativeControls(mainWindow, 'left')
  const win = await electronApp.browserWindow(mainWindow)
  await win.evaluate((window) => window.setFullScreen(true))
  await expect
    .poll(async () => (await geometry(mainWindow)).visible)
    .toBe(false)
  await expect(mainWindow.locator('.window-chrome')).toHaveAttribute(
    'data-fullscreen',
    'true'
  )
  await win.evaluate((window) => window.setFullScreen(false))
  await expectNativeControls(mainWindow, 'left')
  await captureNative(mainWindow, info, 'restored-from-fullscreen')
})

test.describe('Breeze GTK3 native rendering', () => {
  test.use({ desktopGtkTheme: 'Breeze', gtkVersion: '3' })
  test('updates native and renderer themes together', async ({
    electronApp,
    mainWindow,
  }, info) => {
    await waitForQueryHandlers(mainWindow)
    await expectNativeControls(mainWindow, 'right')
    await expect(
      mainWindow.getByRole('heading', { name: 'Dashboard', exact: true })
    ).toBeVisible()
    await captureNative(mainWindow, info, 'breeze-light')
    await mainWindow.evaluate(
      (command) => window.motrix.invoke(command, { app: { theme: 'dark' } }),
      Commands.UpdateSettings
    )
    await expect(mainWindow.locator('html')).toHaveClass(/dark/)
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ nativeTheme }) => nativeTheme.shouldUseDarkColors
        )
      )
      .toBe(true)
    await expectNativeControls(mainWindow, 'right')
    await captureNative(mainWindow, info, 'breeze-dark')
  })
})

test('secondary task window has native controls and survives close/reopen', async ({
  electronApp,
  mainWindow,
}, info) => {
  await waitForQueryHandlers(mainWindow)
  await mainWindow
    .getByRole('button', { name: 'New task', exact: true })
    .click()
  await expect
    .poll(() =>
      electronApp.windows().some((page) => page.url().includes('w=add-task'))
    )
    .toBe(true)
  const taskPage = electronApp
    .windows()
    .find((page) => page.url().includes('w=add-task'))
  if (!taskPage) throw new Error('Add-task window missing')
  await expectNativeControls(taskPage, 'right')
  await expect(taskPage.getByRole('textbox', { name: 'URLs' })).toBeVisible()
  const taskWindow = await electronApp.browserWindow(taskPage)
  // isMaximizable() always returns true on Linux; validate the supported
  // fixed-size window contract instead of the Windows/macOS-only query.
  expect(await taskWindow.evaluate((window) => window.isResizable())).toBe(
    false
  )
  await captureNative(taskPage, info, 'add-task-window')
  await taskWindow.evaluate((window) => window.close())
  await expect.poll(() => taskPage.isClosed()).toBe(true)
  await mainWindow
    .getByRole('button', { name: 'New task', exact: true })
    .click()
  await expect
    .poll(async () => {
      const page = electronApp
        .windows()
        .find((candidate) => candidate.url().includes('w=add-task'))
      if (!page) return false
      const window = await electronApp.browserWindow(page)
      return window.evaluate((candidate) => candidate.isVisible())
    })
    .toBe(true)
  const reopened = electronApp
    .windows()
    .find((page) => page.url().includes('w=add-task'))
  if (!reopened) throw new Error('Reopened add-task window missing')
  await expectNativeControls(reopened, 'right')
  await expect(reopened.getByRole('textbox', { name: 'URLs' })).toBeVisible()
})
