import { expect, test } from './fixtures/electron-app'

// Hash router routes — must mirror src/renderer/router.tsx.
// Labels match the explicit en-US preference seeded by the Electron fixture.
const ROUTES = [
  { name: 'Dashboard', hash: '#/' },
  { name: 'Downloads', hash: '#/downloads' },
  { name: 'Trackers', hash: '#/trackers' },
  { name: 'Settings', hash: '#/settings' },
] as const

test.describe('navigation', () => {
  test('each sidebar item routes the hash and marks itself active', async ({
    mainWindow,
  }) => {
    // Wait for the sidebar to mount before clicking.
    await expect(
      mainWindow.locator('[data-sidebar="sidebar"]').first()
    ).toBeVisible()

    for (const route of ROUTES) {
      // NavLink renders <a> elements with accessible name = label text.
      // Settings sits in the footer so getByRole picks it up the same way.
      await mainWindow.getByRole('link', { name: route.name }).click()

      await expect.poll(() => mainWindow.url()).toContain(route.hash)

      // NavLink toggles `data-active` (via aria-current under the hood)
      // on the active row, mirrored to SidebarMenuButton's
      // `data-state="active"` for the active item. Asserting via
      // aria-current is the most stable cross-component signal.
      await expect(
        mainWindow.getByRole('link', { name: route.name })
      ).toHaveAttribute('aria-current', 'page')
    }
  })
})
