import { expect, test } from './fixtures/electron-app'

const destinations = [
  'Dashboard',
  'Downloads',
  'Trackers',
  'Plugins',
  'Notifications',
  'Settings',
]

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`sidebar selection remains distinct across the gradient (${platform} CSS)`, async ({
    mainWindow,
  }, testInfo) => {
    test.setTimeout(120_000)
    await expect(mainWindow.locator('html')).toHaveAttribute(
      'data-sidebar-color',
      'cyan'
    )

    // Exercise platform CSS in the real renderer, without pretending to test
    // native Windows/Linux window materials on a macOS test host.
    for (const theme of ['light', 'dark']) {
      for (const color of ['gray', 'blue', 'cyan']) {
        await mainWindow.evaluate(
          ({ platform, theme, color }) => {
            const root = document.documentElement
            root.classList.remove(
              'platform-win32',
              'platform-linux',
              'platform-darwin'
            )
            root.classList.add(`platform-${platform}`)
            root.classList.toggle('dark', theme === 'dark')
            root.dataset.sidebarColor = color
          },
          { platform, theme, color }
        )

        let selectedBackground: string | undefined
        for (const destination of destinations) {
          const link = mainWindow.getByRole('link', {
            name: destination,
            exact: true,
          })
          const button = link.locator('[data-sidebar="menu-button"]')
          await link.click()
          await mainWindow.mouse.move(500, 45)
          await expect(button).toHaveAttribute('data-active', 'true')
          const background = await button.evaluate(
            (element) => getComputedStyle(element).backgroundColor
          )
          const channels = background.match(/[\d.]+/g)?.map(Number)
          expect(channels).toHaveLength(4)
          const [red, green, blue, alpha] = channels!
          expect([red, green, blue]).toEqual(
            theme === 'light' ? [0, 0, 0] : [255, 255, 255]
          )
          expect(alpha).toBeGreaterThan(0)
          expect(alpha).toBeLessThan(1)
          selectedBackground ??= background
          expect(background).toBe(selectedBackground)

          // Hovering a selected item must not replace the selected fill.
          await link.hover()
          await expect(button).toHaveCSS('background-color', background)
          const other = mainWindow.getByRole('link', {
            name: destination === 'Dashboard' ? 'Settings' : 'Dashboard',
            exact: true,
          })
          await other.hover()
          const hoverBackground = await other
            .locator('[data-sidebar="menu-button"]')
            .evaluate((element) => getComputedStyle(element).backgroundColor)
          const hoverAlpha = Number(hoverBackground.match(/[\d.]+/g)?.[3])
          expect(hoverAlpha).toBeGreaterThan(0)
          expect(hoverAlpha).toBeLessThan(alpha)
        }

        await mainWindow.mouse.move(500, 45)
        await mainWindow.screenshot({
          path: testInfo.outputPath(
            `sidebar-${platform}-${theme}-${color}.png`
          ),
        })
      }
    }
  })
}
