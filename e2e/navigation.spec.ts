import type { Page } from '@playwright/test'
import { expect, launchMotrix, test } from './fixtures/electron-app'

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

test('opens the remembered or fixed downloads view from the sidebar after restarting', async ({
  userDataDir,
  rpcPort,
}) => {
  const visit = (page: Page, name: string) =>
    page.getByRole('link', { name, exact: true }).click()
  const chooseTab = async (page: Page, from: string, to: string) => {
    await page.getByRole('button', { name: from, exact: true }).click()
    await page.getByRole('menuitem', { name: new RegExp(to) }).click()
  }

  let app = await launchMotrix({ userDataDir, rpcPort })
  try {
    let page = await app.firstWindow()
    await visit(page, 'Downloads')
    await chooseTab(page, 'All Downloads', 'Active')
    await visit(page, 'Dashboard')
    await visit(page, 'Downloads')
    await expect(
      page.getByRole('heading', { name: 'Active Downloads' })
    ).toBeVisible()

    await app.close()
    app = await launchMotrix({ userDataDir, rpcPort })
    page = await app.firstWindow()
    await visit(page, 'Downloads')
    await expect(
      page.getByRole('heading', { name: 'Active Downloads' })
    ).toBeVisible()

    await visit(page, 'Settings')
    await page
      .getByRole('button', { name: /Concurrency, bandwidth limits/ })
      .click()
    const preference = page.getByRole('combobox', {
      name: 'When opening Downloads, show',
    })
    await expect(preference).toHaveText('Remember last selection')
    await preference.click()
    await page.getByRole('option', { name: 'Completed', exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(preference).toBeHidden()
    await visit(page, 'Downloads')
    await chooseTab(page, 'Completed Downloads', 'Error')
    await app.close()
    app = await launchMotrix({ userDataDir, rpcPort })
    page = await app.firstWindow()
    await visit(page, 'Downloads')
    await expect(
      page.getByRole('heading', { name: 'Completed Downloads' })
    ).toBeVisible()
  } finally {
    await app.close().catch(() => {})
  }
})
