import { expect, test } from './fixtures/electron-app'

test.describe('smoke', () => {
  test('main window opens and renders the app shell', async ({
    electronApp,
    mainWindow,
  }) => {
    expect(electronApp).toBeDefined()

    // Main window opens with `?w=main` in the search string (see
    // WindowManager.open in src/main/window). The hash gets set
    // asynchronously once the hash router boots, so we only check
    // the search marker which is set by main BEFORE renderer JS runs.
    await expect.poll(() => mainWindow.url()).toContain('w=main')

    // SidebarProvider applies `class="platform-..."` and `class="window-main"`
    // to <html> in renderer/index.tsx — wait for that as the proof that
    // the bundle executed and platformServices wired up.
    await expect(mainWindow.locator('html')).toHaveClass(/window-main/, {
      timeout: 15_000,
    })

    // Sidebar component renders with data-sidebar="sidebar" once mounted.
    await expect(
      mainWindow.locator('[data-sidebar="sidebar"]').first()
    ).toBeVisible()
  })

  test('renderer reports no JS console errors during boot', async ({
    electronApp,
    mainWindow,
  }) => {
    const errors: string[] = []
    mainWindow.on('pageerror', (err) =>
      errors.push(`pageerror: ${err.message}`)
    )
    mainWindow.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
    })

    // Give the renderer a chance to finish first paint + initial IPC
    // round-trips. The engine bootstrap is async and does NOT block the
    // window, so a quick wait is enough to surface synchronous errors.
    await mainWindow.waitForLoadState('networkidle')
    await electronApp.evaluate(() => new Promise((r) => setTimeout(r, 1500)))

    expect(errors).toEqual([])
  })
})
