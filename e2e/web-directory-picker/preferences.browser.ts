import { expect, type Locator, type Page, test } from '@playwright/test'
import { Commands } from '../../src/shared/protocol/commands'
import { Queries } from '../../src/shared/protocol/queries'

async function seed(page: Page, query = '') {
  await page.goto(`/${query}`)
  await page.evaluate(() =>
    window.directoryPickerFixture.setPreferences({
      favorites: ['/archive'],
      recent: ['/downloads/Movies', '/downloads/Music', '/missing'],
    })
  )
}

async function openDownload(page: Page) {
  await page
    .getByRole('button', { name: 'Open download dialog', exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCSS('opacity', '1')
  return dialog
}

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 35; index++) {
    if (await target.evaluate((element) => element === document.activeElement))
      return
    await page.keyboard.press('Tab')
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
  }
  await expect(target).toBeFocused()
}

async function parentSubmissions(page: Page) {
  return page.evaluate(
    (channel) =>
      window.directoryPickerFixture.calls.filter(
        (call) => call.channel === channel
      ),
    Commands.CreateTask
  )
}

async function openSettingsManager(page: Page) {
  await page
    .getByRole('button', { name: 'Open Downloads settings', exact: true })
    .click()
  const downloads = page.getByRole('dialog', { name: 'Downloads', exact: true })
  await expect(downloads).toHaveCSS('opacity', '1')
  await downloads
    .getByRole('button', { name: 'Manage directories', exact: true })
    .click()
  const manager = page.getByRole('dialog', {
    name: 'Manage directories',
    exact: true,
  })
  await expect(manager).toHaveCSS('opacity', '1')
  return { downloads, manager }
}

for (const app of [false, true]) {
  test(`direct directory history selects without submitting (${app ? 'App service' : 'Web'})`, async ({
    page,
  }) => {
    await seed(page, app ? '?transportPlatform=linux&nativePicker=1' : '')
    const parent = await openDownload(page)
    const trigger = parent.getByRole('button', {
      name: 'Directory history',
      exact: true,
    })
    await tabTo(page, trigger)
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Directory history' })
    await expect(
      menu.getByRole('menuitem', { name: '/downloads/Music', exact: true })
    ).toBeVisible()
    if (!app)
      await expect(
        menu.getByRole('menuitem', { name: '/missing', exact: true })
      ).toHaveCount(0)
    await menu.screenshot({
      path: test.info().outputPath('directory-history.png'),
    })
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Meta+Enter')
    expect(await parentSubmissions(page)).toHaveLength(0)
    // The history menu is also navigable without the mouse.
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(menu).not.toBeVisible()
    await expect(
      parent.getByRole('button', { name: 'Change directory', exact: true })
    ).toHaveAttribute('title', '/downloads/Music')
    await expect(trigger).toBeFocused()
    expect(await parentSubmissions(page)).toHaveLength(0)
    expect(
      await page.evaluate(
        () => window.directoryPickerFixture.getPreferences().recent
      )
    ).toEqual(['/downloads/Movies', '/downloads/Music', '/missing'])
    if (app) {
      expect(
        await page.evaluate(
          (channel) =>
            window.directoryPickerFixture.calls.filter(
              (call) => call.channel === channel
            ),
          Queries.ListServerDirectoryLocations
        )
      ).toHaveLength(0)
    }
  })
}

test('Downloads settings deletes individual recent records and keeps changes after outer Cancel', async ({
  page,
}) => {
  await seed(page)
  const { downloads, manager } = await openSettingsManager(page)
  const remove = manager.getByRole('button', {
    name: 'Remove recent folder /downloads/Movies',
    exact: true,
  })
  await expect(remove).toBeVisible()
  await remove.click()
  await expect(remove).toHaveCount(0)
  await expect(
    manager.getByRole('button', {
      name: 'Remove recent folder /downloads/Music',
      exact: true,
    })
  ).toBeVisible()
  // Stale saved paths remain manageable even though Web navigation omits them.
  await manager
    .getByRole('button', { name: 'Remove recent folder /missing', exact: true })
    .click()
  await manager
    .getByRole('button', {
      name: 'Add to favorites /downloads/Music',
      exact: true,
    })
    .click()
  await expect(
    manager.getByRole('button', {
      name: 'Remove favorite /downloads/Music',
      exact: true,
    })
  ).toBeVisible()
  await manager.screenshot({
    path: test.info().outputPath('directory-management.png'),
  })
  await manager
    .getByRole('button', { name: 'Close', exact: true })
    .last()
    .click()
  await downloads.getByRole('button', { name: 'Cancel', exact: true }).click()
  const parent = await openDownload(page)
  await parent
    .getByRole('button', { name: 'Directory history', exact: true })
    .click()
  const menu = page.getByRole('menu', { name: 'Directory history' })
  await expect(
    menu.getByRole('menuitem', { name: '/downloads/Movies', exact: true })
  ).toHaveCount(0)
  await expect(
    menu
      .getByRole('menuitem', { name: '/downloads/Music', exact: true })
      .first()
  ).toBeVisible()
  expect(
    await page.evaluate(() => window.directoryPickerFixture.getPreferences())
  ).toEqual({
    favorites: ['/archive', '/downloads/Music'],
    recent: ['/downloads/Music'],
  })
})

test('history manager contains failure shortcuts and cancels nested Web Browse without adding a record', async ({
  page,
}) => {
  await seed(page)
  const parent = await openDownload(page)
  const history = parent.getByRole('button', {
    name: 'Directory history',
    exact: true,
  })
  await history.click()
  await page
    .getByRole('menuitem', { name: 'Manage directories', exact: true })
    .click()
  const manager = page.getByRole('dialog', {
    name: 'Manage directories',
    exact: true,
  })
  await expect(manager).toHaveCSS('opacity', '1')
  await page.evaluate(() => {
    window.directoryPickerFixture.mutationFailure = true
  })
  await manager
    .getByRole('button', {
      name: 'Remove recent folder /downloads/Music',
      exact: true,
    })
    .click()
  await expect(manager.getByRole('alert')).toBeVisible()
  await page.keyboard.press('Control+Enter')
  await page.keyboard.press('Meta+Enter')
  expect(await parentSubmissions(page)).toHaveLength(0)
  await expect(
    manager.getByRole('button', {
      name: 'Remove recent folder /downloads/Music',
      exact: true,
    })
  ).toBeVisible()
  await page.evaluate(() => {
    window.directoryPickerFixture.mutationFailure = false
  })
  await manager
    .getByRole('button', { name: 'Add favorite', exact: true })
    .click()
  const picker = page.getByRole('dialog', {
    name: 'Select server folder',
    exact: true,
  })
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('listbox', { name: 'Folders' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(picker).not.toBeVisible()
  await expect(
    manager.getByRole('button', { name: 'Add favorite', exact: true })
  ).toBeFocused()
  expect(
    await page.evaluate(
      () => window.directoryPickerFixture.getPreferences().favorites
    )
  ).toEqual(['/archive'])
  await manager
    .getByRole('button', { name: 'Close', exact: true })
    .last()
    .click()
  await expect(history).toBeFocused()
  expect(await parentSubmissions(page)).toHaveLength(0)
})

test('App service Browse confirms history but management adds favorites without creating recent entries', async ({
  page,
}) => {
  await seed(page, '?transportPlatform=linux&nativePicker=1')
  await page.evaluate(() => {
    window.directoryPickerFixture.nativePickerResult = '/downloads/Movies'
  })
  const { manager } = await openSettingsManager(page)
  await manager
    .getByRole('button', { name: 'Add favorite', exact: true })
    .click()
  await expect(
    manager.getByRole('button', {
      name: 'Remove favorite /downloads/Movies',
      exact: true,
    })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => window.directoryPickerFixture.getPreferences().recent
    )
  ).toEqual(['/downloads/Movies', '/downloads/Music', '/missing'])
  expect(
    await page.evaluate(() => window.directoryPickerFixture.nativePickerCalls)
  ).toBe(1)
  await manager
    .getByRole('button', { name: 'Clear recent folders', exact: true })
    .click()
  await expect(
    manager.getByText('No recent folders', { exact: true })
  ).toBeVisible()
  await manager
    .getByRole('button', { name: 'Close', exact: true })
    .last()
    .click()
  await page
    .getByRole('dialog', { name: 'Downloads', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  const parent = await openDownload(page)
  await parent
    .getByRole('button', { name: 'Change directory', exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() => window.directoryPickerFixture.getPreferences().recent)
    )
    .toEqual(['/downloads/Movies'])
  expect(
    await page.evaluate(() => window.directoryPickerFixture.nativePickerCalls)
  ).toBe(2)
  await expect(
    page.getByRole('dialog', { name: 'Select server folder', exact: true })
  ).toHaveCount(0)
})

test('unrestricted common places, root breadcrumb and Mac jumps stay available without allowed roots', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    })
  )
  await seed(page, '?unrestricted=1')
  const parent = await openDownload(page)
  await parent
    .getByRole('button', { name: 'Change directory', exact: true })
    .click()
  const picker = page.getByRole('dialog', {
    name: 'Select server folder',
    exact: true,
  })
  await expect(
    picker.getByRole('option', { name: 'Movies', exact: true })
  ).toBeVisible()
  await expect(
    picker.getByRole('navigation', { name: 'Location', exact: true })
  ).toBeVisible()
  await expect(
    picker.getByRole('navigation', { name: 'Folder path', exact: true })
  ).toHaveText('/downloads')
  await page.keyboard.press('Meta+Shift+h')
  await expect(
    picker.getByRole('option', { name: 'Desktop', exact: true })
  ).toBeVisible()
  await page.keyboard.press('Meta+Shift+o')
  await expect(picker.getByText('No subfolders', { exact: true })).toBeVisible()
  await expect(
    picker
      .getByRole('navigation', { name: 'Folder path', exact: true })
      .getByRole('button', { name: 'Documents', exact: true })
  ).toBeVisible()
  await expect(picker).toHaveCSS('opacity', '1')
  await picker.screenshot({
    path: test.info().outputPath('unrestricted-native-places.png'),
  })
})

test('Web star saves the browsed directory and accepted AddTask updates shared recent history', async ({
  page,
}) => {
  await seed(page)
  const parent = await openDownload(page)
  await parent
    .getByRole('button', { name: 'Change directory', exact: true })
    .click()
  const picker = page.getByRole('dialog', {
    name: 'Select server folder',
    exact: true,
  })
  await picker.getByRole('option', { name: 'Movies', exact: true }).click()
  await picker
    .getByRole('button', { name: 'Add favorite', exact: true })
    .click()
  await expect(
    picker.getByRole('button', { name: 'Remove favorite', exact: true })
  ).toBeEnabled()
  expect(
    await page.evaluate(
      () => window.directoryPickerFixture.getPreferences().favorites
    )
  ).toEqual(['/archive', '/downloads'])
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(
    parent.getByRole('button', { name: 'Change directory', exact: true })
  ).toHaveAttribute('title', '/downloads')
  await parent
    .getByRole('button', { name: 'Directory history', exact: true })
    .click()
  const menu = page.getByRole('menu', { name: 'Directory history' })
  await expect(
    menu.getByRole('menuitem', { name: '/downloads', exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await parent.getByRole('button', { name: 'Download', exact: true }).click()
  await expect(parent).not.toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () => window.directoryPickerFixture.getPreferences().recent[0]
      )
    )
    .toBe('/downloads')
  expect(await parentSubmissions(page)).toHaveLength(1)
})

test('narrow dark management handles many paths, visible footer and authoritative removal events', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 620 })
  await seed(page, '?theme=dark')
  await page.evaluate(() =>
    window.directoryPickerFixture.setPreferences({
      favorites: Array.from(
        { length: 20 },
        (_, index) => `/downloads/${index}-${'long-folder-name-'.repeat(12)}`
      ),
      recent: [
        '/downloads/Movies',
        ...Array.from({ length: 9 }, (_, index) => `/archive/Recent ${index}`),
      ],
    })
  )
  const { manager } = await openSettingsManager(page)
  await expect(
    manager.getByRole('button', { name: 'Close', exact: true }).last()
  ).toBeInViewport({ ratio: 1 })
  await manager.screenshot({
    path: test.info().outputPath('directory-management-narrow-dark.png'),
  })
  await page.evaluate(() =>
    window.directoryPickerFixture.setPreferences({
      favorites: [],
      recent: ['/downloads/Music'],
    })
  )
  await expect(
    manager.getByRole('button', {
      name: 'Remove recent folder /downloads/Movies',
      exact: true,
    })
  ).toHaveCount(0)
  await expect(
    manager.getByText('No favorite folders', { exact: true })
  ).toBeVisible()
  await manager
    .getByRole('button', { name: 'Clear recent folders', exact: true })
    .click()
  await expect(
    manager.getByText('No recent folders', { exact: true })
  ).toBeVisible()
  await expect(
    manager.getByRole('button', { name: 'Close', exact: true }).last()
  ).toBeInViewport({ ratio: 1 })
})

for (const control of ['location', 'favorite'] as const) {
  test(`external preferences event keeps focus inside the picker when ${control} becomes unavailable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 620 })
    await seed(page, '?unrestricted=1')
    const parent = await openDownload(page)
    await parent
      .getByRole('button', { name: 'Change directory', exact: true })
      .click()
    const picker = page.getByRole('dialog', {
      name: 'Select server folder',
      exact: true,
    })
    const target =
      control === 'location'
        ? picker.getByRole('combobox', { name: 'Location', exact: true })
        : picker.getByRole('button', { name: 'Add favorite', exact: true })
    await expect(target).toBeEnabled()
    await target.focus()
    await expect(target).toBeFocused()
    await page.evaluate((channel) => {
      window.directoryPickerFixture.holdChannel = channel
      window.directoryPickerFixture.setPreferences({
        favorites: [],
        recent: [],
      })
    }, Queries.ListServerDirectoryLocations)
    await expect(
      picker.getByRole('listbox', { name: 'Folders', exact: true })
    ).toBeFocused()
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Meta+Enter')
    expect(await parentSubmissions(page)).toHaveLength(0)
    await expect(picker).toBeVisible()
  })
}
