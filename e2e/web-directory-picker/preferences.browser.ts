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

async function settleFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

async function settlePanel(page: Page, panel: Locator) {
  await expect(panel).toHaveCSS('opacity', '1')
  await panel.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity
        )
        .map((animation) => animation.finished.catch(() => {}))
    )
  })
  await settleFrames(page)
}

test('favorite updates preserve picker geometry, list state and request budget', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await seed(page, '?unrestricted=1')
  await page.evaluate(() =>
    window.directoryPickerFixture.setPreferences({ favorites: [], recent: [] })
  )
  const parent = await openDownload(page)
  // A previously opened history mirror must stop doing optional locations IO
  // after its menu closes; only the active picker refreshes on this mutation.
  await parent
    .getByRole('button', { name: 'Directory history', exact: true })
    .click()
  await expect(
    page.getByRole('menu', { name: 'Directory history' })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('menu', { name: 'Directory history' })
  ).not.toBeVisible()
  await parent
    .getByRole('button', { name: 'Change directory', exact: true })
    .click()
  const picker = page.getByRole('dialog', {
    name: 'Select server folder',
    exact: true,
  })
  await expect(picker.getByRole('listbox', { name: 'Folders' })).toBeFocused()
  await picker
    .getByRole('button', { name: 'Go to folder', exact: true })
    .click()
  await picker
    .getByRole('textbox', { name: 'Folder path', exact: true })
    .fill('/archive')
  await picker.getByRole('button', { name: 'Go', exact: true }).click()
  const list = picker.getByRole('listbox', { name: 'Folders', exact: true })
  await picker.getByRole('option', { name: 'Folder 0000', exact: true }).click()
  // The sorted display array must stay memoized across preference updates too.
  const sortCalls = await page.evaluate(
    () => window.directoryPickerFixture.calls
  )
  await picker
    .getByRole('button', { name: 'View options', exact: true })
    .click()
  const viewMenu = page.getByRole('menu', { name: 'View options', exact: true })
  await viewMenu
    .getByRole('menuitemradio', { name: 'Descending', exact: true })
    .click()
  await expect(viewMenu).not.toBeVisible()
  await expect(list).toBeFocused()
  await expect(
    list.getByRole('option', { name: 'Folder 0000', exact: true })
  ).toHaveAttribute('aria-posinset', '800')
  expect(
    await page.evaluate(() => window.directoryPickerFixture.calls)
  ).toEqual(sortCalls)
  await list.evaluate((element) => {
    element.scrollTop = 12000
  })
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(12000)
  await settleFrames(page)

  const sidebar = picker.getByTestId('directory-picker-locations')
  const main = picker.getByTestId('directory-picker-main')
  const sidebarNode = await sidebar.elementHandle()
  const mainNode = await main.elementHandle()
  const listNode = await list.elementHandle()
  const selectedNode = await list
    .locator('[role="option"][aria-selected="true"]')
    .elementHandle()
  if (!sidebarNode || !mainNode || !listNode || !selectedNode)
    throw new Error('Expected the picker nodes to exist before measurement')
  const star = picker.getByTestId('directory-picker-favorite')
  await star.focus()
  const capture = async () => ({
    mainBounds: await main.boundingBox(),
    listBounds: await list.boundingBox(),
    scroll: await list.evaluate((element) => element.scrollTop),
    activeDescendant: await list.getAttribute('aria-activedescendant'),
    selectedPath: await picker
      .getByTestId('directory-picker-target')
      .textContent(),
    sidebarRetained: await sidebarNode.evaluate(
      (element) => element.isConnected
    ),
    mainRetained: await mainNode.evaluate((element) => element.isConnected),
    listRetained: await listNode.evaluate((element) => element.isConnected),
    selectedNodeRetained: await selectedNode.evaluate(
      (element) => element.isConnected
    ),
    focus: await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      testId: document.activeElement?.getAttribute('data-testid'),
      label: document.activeElement?.getAttribute('aria-label'),
      insidePicker: !!document.activeElement?.closest(
        '[data-testid="web-directory-picker"]'
      ),
    })),
  })
  const before = await capture()
  const baselineCalls = await page.evaluate(
    () => window.directoryPickerFixture.calls.length
  )
  await page.evaluate((channel) => {
    window.directoryPickerFixture.holdChannel = channel
  }, Queries.ListServerDirectoryLocations)
  await star.click()
  await expect
    .poll(() =>
      page.evaluate(
        (channel) =>
          window.directoryPickerFixture.calls.filter(
            (call) => call.channel === channel
          ).length,
        Commands.MutateDirectoryPreferences
      )
    )
    .toBe(1)
  await settleFrames(page)
  const pending = await capture()
  // Retained locations are display snapshots while authorization refreshes.
  // Synthetic activation exercises the controller guard as well as disabled UI.
  await sidebar.locator('button[title="/home/operator"]').dispatchEvent('click')
  await star.dispatchEvent('click')
  const pendingCalls = await page.evaluate(
    (offset) => window.directoryPickerFixture.calls.slice(offset),
    baselineCalls
  )
  await page.evaluate(() => {
    window.directoryPickerFixture.holdChannel = null
    window.directoryPickerFixture.releaseRequest?.()
  })
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await settleFrames(page)
  const after = await capture()
  const calls = await page.evaluate(
    (offset) => window.directoryPickerFixture.calls.slice(offset),
    baselineCalls
  )
  const metrics = {
    before,
    pending,
    after,
    locationsQueries: calls.filter(
      (call) => call.channel === Queries.ListServerDirectoryLocations
    ).length,
    listingQueries: calls.filter(
      (call) => call.channel === Queries.ListServerDirectories
    ).length,
    mutations: calls.filter(
      (call) => call.channel === Commands.MutateDirectoryPreferences
    ).length,
    pendingCalls,
  }
  await test.info().attach('favorite-performance-metrics', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })
  expect.soft(metrics.locationsQueries).toBe(1)
  expect.soft(metrics.listingQueries).toBe(0)
  expect.soft(metrics.mutations).toBe(1)
  for (const state of [pending, after]) {
    expect.soft(state.sidebarRetained).toBe(true)
    expect.soft(state.mainRetained).toBe(true)
    expect.soft(state.listRetained).toBe(true)
    expect.soft(state.selectedNodeRetained).toBe(true)
    expect.soft(state.mainBounds).toEqual(before.mainBounds)
    expect.soft(state.listBounds).toEqual(before.listBounds)
    expect.soft(state.scroll).toBe(before.scroll)
    expect.soft(state.activeDescendant).toBe(before.activeDescendant)
    expect.soft(state.selectedPath).toBe(before.selectedPath)
    expect.soft(state.focus.insidePicker).toBe(true)
    expect.soft(state.focus.testId).toBe('directory-picker-favorite')
  }
})

async function openSettingsManager(page: Page) {
  await page
    .getByRole('button', { name: 'Open General settings', exact: true })
    .click()
  const manager = page.getByRole('dialog', { name: 'General', exact: true })
  await expect(manager).toHaveCSS('opacity', '1')
  return { manager }
}

for (const width of [1024, 390]) {
  test(`View options offers keyboard hidden-folder filtering without parent submission at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 620 })
    await seed(page)
    const parent = await openDownload(page)
    await parent
      .getByRole('button', { name: 'Change directory', exact: true })
      .click()
    const picker = page.getByRole('dialog', {
      name: 'Select server folder',
      exact: true,
    })
    const list = picker.getByRole('listbox', { name: 'Folders', exact: true })
    await expect(list).toBeFocused()
    await expect(
      picker.getByRole('switch', { name: 'Show hidden folders', exact: true })
    ).toHaveCount(0)
    await expect(
      picker.getByRole('option', { name: '.hidden', exact: true })
    ).toHaveCount(0)
    const view = picker.getByRole('button', {
      name: 'View options',
      exact: true,
    })
    await expect(
      picker
        .getByTestId('directory-picker-toolbar')
        .getByRole('button', { name: 'View options', exact: true })
    ).toBeInViewport({ ratio: 1 })
    await tabTo(page, view)
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'View options', exact: true })
    const hidden = menu.getByRole('menuitemcheckbox', {
      name: 'Show hidden folders',
      exact: true,
    })
    await expect(hidden).toBeVisible()
    await expect(hidden).not.toBeChecked()
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Meta+Enter')
    expect(await parentSubmissions(page)).toHaveLength(0)
    await expect(hidden).not.toBeChecked()
    await expect(menu).toHaveCSS('opacity', '1')
    await menu.screenshot({
      path: test.info().outputPath(`view-options-${width}.png`),
    })
    const baseline = await page.evaluate(
      () => window.directoryPickerFixture.calls.length
    )
    await hidden.focus()
    await page.keyboard.press('Space')
    await expect(menu).not.toBeVisible()
    await expect(
      picker.getByRole('option', { name: '.hidden', exact: true })
    ).toBeVisible()
    await expect(list).toBeFocused()
    const calls = await page.evaluate(
      (offset) => window.directoryPickerFixture.calls.slice(offset),
      baseline
    )
    expect(
      calls.filter((call) => call.channel === Queries.ListServerDirectories)
    ).toEqual([
      {
        channel: Queries.ListServerDirectories,
        args: [{ path: '/downloads', showHidden: true }],
      },
    ])
    expect(
      calls.filter(
        (call) => call.channel === Queries.ListServerDirectoryLocations
      )
    ).toHaveLength(0)
    await tabTo(page, view)
    await page.keyboard.press('Enter')
    await expect(hidden).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await expect(view).toBeFocused()
    await expect(picker).toBeVisible()
    expect(await parentSubmissions(page)).toHaveLength(0)
    await picker.screenshot({
      path: test.info().outputPath(`picker-filtered-${width}.png`),
    })
  })
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
    const literalPath = parent
      .getByRole('button', { name: 'Change directory', exact: true })
      .locator('span[dir="ltr"]')
    await expect(literalPath).toHaveText('/downloads/Music')
    await expect(literalPath).toHaveCSS('direction', 'ltr')
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

async function preferenceWrites(page: Page) {
  return page.evaluate(
    (channels) =>
      window.directoryPickerFixture.calls.filter((call) =>
        channels.some((channel) => channel === call.channel)
      ),
    [
      Commands.SaveGeneralSettings,
      Commands.MutateDirectoryPreferences,
      Commands.UpdateSettings,
    ]
  )
}

async function expandRecent(manager: Locator) {
  const trigger = manager.getByRole('button', { name: /^Recent folders/ })
  await expect(trigger).toBeVisible()
  if ((await trigger.getAttribute('aria-expanded')) === 'false')
    await trigger.click()
}

test('General directory and ordinary setting drafts cancel without any preference command', async ({
  page,
}) => {
  await seed(page)
  await page.evaluate(() =>
    window.directoryPickerFixture.setPreferences({
      favorites: ['/archive', '/downloads/Movies'],
      recent: ['/downloads/Movies', '/downloads/Music', '/missing'],
    })
  )
  const original = await page.evaluate(() =>
    window.directoryPickerFixture.getSettings()
  )
  const { manager } = await openSettingsManager(page)
  await expect(manager.getByRole('textbox')).toHaveValue('/downloads')
  await expect(manager.getByRole('textbox')).toHaveAttribute(
    'title',
    '/downloads'
  )
  await expect(manager.getByRole('textbox')).toHaveCSS('direction', 'ltr')
  await expect(
    manager.getByRole('button', {
      name: 'Remove favorite /downloads/Movies',
      exact: true,
    })
  ).toBeVisible()
  await settlePanel(page, manager)
  await manager.screenshot({
    path: test.info().outputPath('general-directory-fields-wide-light.png'),
  })
  await expandRecent(manager)
  await manager
    .getByRole('button', {
      name: 'Remove recent folder /downloads/Movies',
      exact: true,
    })
    .click()
  await manager
    .getByRole('button', { name: 'Remove favorite /archive', exact: true })
    .click()
  await manager
    .getByRole('button', {
      name: 'Add to favorites /downloads/Music',
      exact: true,
    })
    .click()
  await manager
    .getByRole('switch', {
      name: 'Notify when download completes',
      exact: true,
    })
    .click()
  await expect(
    manager.getByRole('button', {
      name: 'Remove favorite /downloads/Music',
      exact: true,
    })
  ).toBeVisible()
  await expect(
    manager.getByRole('button', {
      name: 'Remove recent folder /downloads/Movies',
      exact: true,
    })
  ).toHaveCount(0)
  expect(await preferenceWrites(page)).toHaveLength(0)
  expect(
    await page.evaluate(() => window.directoryPickerFixture.getSettings())
  ).toEqual(original)
  await manager.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await preferenceWrites(page)).toHaveLength(0)
  expect(
    await page.evaluate(() => window.directoryPickerFixture.getSettings())
  ).toEqual(original)
  const reopened = await openSettingsManager(page)
  await expandRecent(reopened.manager)
  await expect(
    reopened.manager.getByRole('button', {
      name: 'Remove favorite /archive',
      exact: true,
    })
  ).toBeVisible()
  await expect(
    reopened.manager.getByRole('button', {
      name: 'Remove recent folder /downloads/Movies',
      exact: true,
    })
  ).toBeVisible()
})

test('General Save atomically commits settings and directory intent against concurrent new records', async ({
  page,
}) => {
  await seed(page)
  const { manager } = await openSettingsManager(page)
  await expandRecent(manager)
  const notification = manager.getByRole('switch', {
    name: 'Notify when download completes',
    exact: true,
  })
  const initialNotification = await notification.isChecked()
  await manager
    .getByRole('button', {
      name: 'Remove recent folder /downloads/Movies',
      exact: true,
    })
    .click()
  await manager
    .getByRole('button', {
      name: 'Add to favorites /downloads/Music',
      exact: true,
    })
    .click()
  await notification.click()
  await page.evaluate((channel) => {
    window.directoryPickerFixture.holdChannel = channel
  }, Commands.SaveGeneralSettings)
  await manager.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => preferenceWrites(page)).toHaveLength(1)
  await page.evaluate(() =>
    window.directoryPickerFixture.setPreferences({
      favorites: ['/archive', '/downloads/Empty'],
      recent: ['/archive', '/downloads/Movies', '/downloads/Music', '/missing'],
    })
  )
  expect(
    (await page.evaluate(() => window.directoryPickerFixture.getSettings())).app
      .notifyOnComplete
  ).toBe(initialNotification)
  await page.evaluate(() => {
    window.directoryPickerFixture.holdChannel = null
    window.directoryPickerFixture.releaseRequest?.()
  })
  await expect(manager).not.toBeVisible()
  expect(await preferenceWrites(page)).toEqual([
    {
      channel: Commands.SaveGeneralSettings,
      args: [
        {
          app: { notifyOnComplete: !initialNotification },
          directories: {
            addFavorites: ['/downloads/Music'],
            removeFavorites: [],
            removeRecent: ['/downloads/Movies'],
          },
        },
      ],
    },
  ])
  expect(
    await page.evaluate(() => window.directoryPickerFixture.getPreferences())
  ).toEqual({
    favorites: ['/archive', '/downloads/Empty', '/downloads/Music'],
    recent: ['/archive', '/downloads/Music', '/missing'],
  })
  expect(
    (await page.evaluate(() => window.directoryPickerFixture.getSettings())).app
      .notifyOnComplete
  ).toBe(!initialNotification)
})

test('General failed Save keeps both committed settings and preferences unchanged and preserves the draft', async ({
  page,
}) => {
  await seed(page)
  const original = await page.evaluate(() =>
    window.directoryPickerFixture.getSettings()
  )
  const { manager } = await openSettingsManager(page)
  await expandRecent(manager)
  await manager
    .getByRole('button', { name: 'Remove recent folder /missing', exact: true })
    .click()
  const notification = manager.getByRole('switch', {
    name: 'Notify when download completes',
    exact: true,
  })
  await notification.click()
  await page.evaluate(() => {
    window.directoryPickerFixture.mutationFailure = true
  })
  await manager.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(manager.getByRole('alert')).toBeVisible()
  expect(
    await page.evaluate(() => window.directoryPickerFixture.getSettings())
  ).toEqual(original)
  await expect(notification).toBeChecked({
    checked: !original.app.notifyOnComplete,
  })
  await expect(
    manager.getByRole('button', {
      name: 'Remove recent folder /missing',
      exact: true,
    })
  ).toHaveCount(0)
  await manager.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(
    await page.evaluate(() => window.directoryPickerFixture.getSettings())
  ).toEqual(original)
})

test('history manager drafts contain failure shortcuts and cancel nested Web Browse without saving', async ({
  page,
}) => {
  await seed(page)
  const original = await page.evaluate(() =>
    window.directoryPickerFixture.getPreferences()
  )
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
  await expandRecent(manager)
  await manager
    .getByRole('button', {
      name: 'Remove recent folder /downloads/Music',
      exact: true,
    })
    .click()
  expect(await preferenceWrites(page)).toHaveLength(0)
  await page.evaluate(() => {
    window.directoryPickerFixture.mutationFailure = true
  })
  await manager.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(manager.getByRole('alert')).toBeVisible()
  await page.keyboard.press('Control+Enter')
  await page.keyboard.press('Meta+Enter')
  expect(await parentSubmissions(page)).toHaveLength(0)
  expect(
    await page.evaluate(() => window.directoryPickerFixture.getPreferences())
  ).toEqual(original)
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
  await expect(picker.getByRole('listbox', { name: 'Folders' })).toBeFocused()
  await expect(picker.getByTestId('directory-picker-favorite')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(picker).not.toBeVisible()
  await expect(
    manager.getByRole('button', { name: 'Add favorite', exact: true })
  ).toBeFocused()
  await manager.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(history).toBeFocused()
  expect(
    await page.evaluate(() => window.directoryPickerFixture.getPreferences())
  ).toEqual(original)
  expect(await parentSubmissions(page)).toHaveLength(0)
})

test('history manager Save commits its directory-only draft and restores the history trigger', async ({
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
  await settlePanel(page, manager)
  const collapsed = await manager.boundingBox()
  if (!collapsed) throw new Error('Expected the history manager to be visible')
  await manager.screenshot({
    path: test.info().outputPath('history-manager-collapsed.png'),
  })
  await expandRecent(manager)
  await settlePanel(page, manager)
  const expanded = await manager.boundingBox()
  if (!expanded)
    throw new Error('Expected the expanded history manager to be visible')
  expect(expanded.height).toBeGreaterThan(collapsed.height)
  await test.info().attach('history-manager-height-metrics', {
    body: JSON.stringify(
      { collapsed: collapsed.height, expanded: expanded.height },
      null,
      2
    ),
    contentType: 'application/json',
  })
  await manager.screenshot({
    path: test.info().outputPath('history-manager-expanded.png'),
  })
  await manager
    .getByRole('button', { name: 'Remove recent folder /missing', exact: true })
    .click()
  await manager.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(manager).not.toBeVisible()
  await expect(history).toBeFocused()
  expect(await preferenceWrites(page)).toEqual([
    {
      channel: Commands.SaveGeneralSettings,
      args: [
        {
          app: {},
          directories: {
            addFavorites: [],
            removeFavorites: [],
            removeRecent: ['/missing'],
          },
        },
      ],
    },
  ])
  expect(
    await page.evaluate(
      () => window.directoryPickerFixture.getPreferences().recent
    )
  ).toEqual(['/downloads/Movies', '/downloads/Music'])
  expect(await parentSubmissions(page)).toHaveLength(0)
})

for (const app of [false, true]) {
  test(`General Browse stages its default and favorites without recording recent use (${app ? 'App service' : 'Web'})`, async ({
    page,
  }) => {
    await seed(page, app ? '?transportPlatform=linux&nativePicker=1' : '')
    const original = await page.evaluate(() =>
      window.directoryPickerFixture.getPreferences()
    )
    await page.evaluate(() => {
      window.directoryPickerFixture.nativePickerResult = '/downloads/Movies'
    })
    const { manager } = await openSettingsManager(page)
    await expandRecent(manager)
    await manager
      .getByRole('button', { name: 'Clear recent folders', exact: true })
      .click()
    const chooseMovies = async (draft = true) => {
      if (app) return
      const picker = page.getByRole('dialog', {
        name: 'Select server folder',
        exact: true,
      })
      await expect(picker.getByTestId('directory-picker-favorite')).toHaveCount(
        draft ? 0 : 1
      )
      await picker.getByRole('option', { name: 'Movies', exact: true }).click()
      await picker
        .getByRole('button', { name: 'Select folder', exact: true })
        .click()
      await expect(picker).not.toBeVisible()
    }
    await manager.getByRole('button', { name: 'Browse…', exact: true }).click()
    await chooseMovies()
    await expect(manager.getByRole('textbox')).toHaveValue('/downloads/Movies')
    await expect(manager.getByRole('textbox')).toHaveAttribute(
      'title',
      '/downloads/Movies'
    )
    await expect(manager.getByRole('textbox')).toHaveCSS('direction', 'ltr')
    await manager
      .getByRole('button', { name: 'Add favorite', exact: true })
      .click()
    await chooseMovies()
    await expect(
      manager.getByRole('button', {
        name: 'Remove favorite /downloads/Movies',
        exact: true,
      })
    ).toBeVisible()
    expect(await preferenceWrites(page)).toHaveLength(0)
    expect(
      await page.evaluate(() => window.directoryPickerFixture.getPreferences())
    ).toEqual(original)
    await manager.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(manager).not.toBeVisible()
    expect(
      await page.evaluate(() => window.directoryPickerFixture.getPreferences())
    ).toEqual({ favorites: ['/archive', '/downloads/Movies'], recent: [] })
    expect(
      (await page.evaluate(() => window.directoryPickerFixture.getSettings()))
        .app.defaultSaveDir
    ).toBe('/downloads/Movies')
    const parent = await openDownload(page)
    await parent
      .getByRole('button', { name: 'Change directory', exact: true })
      .click()
    await chooseMovies(false)
    await expect
      .poll(() =>
        page.evaluate(
          () => window.directoryPickerFixture.getPreferences().recent
        )
      )
      .toEqual(['/downloads/Movies'])
    if (app) {
      expect(
        await page.evaluate(
          () => window.directoryPickerFixture.nativePickerCalls
        )
      ).toBe(3)
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

test('narrow General directory fields stay compact with centered rows, full path titles and a visible footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 620 })
  await seed(page, '?theme=dark')
  const paths = Array.from(
    { length: 20 },
    (_, index) => `/downloads/${index}-${'long-folder-name-'.repeat(12)}`
  )
  await page.evaluate(
    (favorites) =>
      window.directoryPickerFixture.setPreferences({
        favorites,
        recent: ['/downloads/Movies', '/downloads/Music'],
      }),
    paths
  )
  const { manager } = await openSettingsManager(page)
  const recent = manager.getByRole('button', { name: /^Recent folders/ })
  await expect(recent).toHaveAttribute('aria-expanded', 'false')
  const path = manager.getByTitle(paths[0], { exact: true })
  await expect(manager.getByRole('textbox')).toHaveValue('/downloads')
  await expect(manager.getByRole('textbox')).toHaveAttribute(
    'title',
    '/downloads'
  )
  await expect(manager.getByRole('textbox')).toHaveCSS('direction', 'ltr')
  await expect(path).toBeVisible()
  const row = path.locator('..')
  const layout = await row.evaluate((element) => {
    const children = [...element.children]
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
    const centers = children.map((rect) => rect.y + rect.height / 2)
    const text = element.querySelector('[title]') as HTMLElement
    return {
      height: element.getBoundingClientRect().height,
      right: element.getBoundingClientRect().right,
      dialogRight:
        element.closest('[role="dialog"]')?.getBoundingClientRect().right ?? 0,
      centerSpread: Math.max(...centers) - Math.min(...centers),
      truncated: text.scrollWidth > text.clientWidth,
    }
  })
  await test.info().attach('compact-directory-row-metrics', {
    body: JSON.stringify(layout, null, 2),
    contentType: 'application/json',
  })
  // A 40px content row may include its 1px divider.
  expect(layout.height).toBeLessThanOrEqual(42)
  expect(layout.centerSpread).toBeLessThanOrEqual(1)
  expect(layout.truncated).toBe(true)
  expect(layout.right).toBeLessThanOrEqual(layout.dialogRight)
  await expect(
    manager.getByRole('button', { name: 'Browse…', exact: true })
  ).toBeInViewport({ ratio: 1 })
  await expect(
    row.getByRole('button', {
      name: `Remove favorite ${paths[0]}`,
      exact: true,
    })
  ).toBeInViewport({ ratio: 1 })
  await expect(
    manager.getByRole('button', { name: 'Save', exact: true })
  ).toBeInViewport({ ratio: 1 })
  await expect(
    manager.getByRole('button', { name: 'Cancel', exact: true })
  ).toBeInViewport({ ratio: 1 })
  await manager.screenshot({
    path: test.info().outputPath('general-directory-fields-narrow-dark.png'),
  })
  await expandRecent(manager)
  await manager
    .getByRole('button', { name: 'Clear recent folders', exact: true })
    .click()
  expect(await preferenceWrites(page)).toHaveLength(0)
  await manager.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(
    await page.evaluate(
      () => window.directoryPickerFixture.getPreferences().recent
    )
  ).toEqual(['/downloads/Movies', '/downloads/Music'])
})

for (const control of ['location', 'favorite'] as const) {
  test(`external preferences event retains ${control} DOM while pending locations stay inert`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: 'MacIntel',
      })
    )
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
    await settlePanel(page, picker)
    const targetNode = await target.elementHandle()
    if (!targetNode) throw new Error('Expected the focused location control')
    const beforeCalls = await page.evaluate(
      () => window.directoryPickerFixture.calls.length
    )
    const beforeBounds = await picker
      .getByRole('listbox', { name: 'Folders', exact: true })
      .boundingBox()
    await page.evaluate((channel) => {
      window.directoryPickerFixture.holdChannel = channel
      window.directoryPickerFixture.setPreferences({
        favorites: [],
        recent: [],
      })
    }, Queries.ListServerDirectoryLocations)
    await settleFrames(page)
    expect(await targetNode.evaluate((element) => element.isConnected)).toBe(
      true
    )
    expect(
      await picker
        .getByRole('listbox', { name: 'Folders', exact: true })
        .boundingBox()
    ).toEqual(beforeBounds)
    if (control === 'favorite') {
      await expect(target).toBeFocused()
      await expect(target).toHaveAttribute('aria-disabled', 'true')
    }
    expect(
      await page.evaluate(
        () =>
          !!document.activeElement?.closest(
            '[data-testid="web-directory-picker"]'
          )
      )
    ).toBe(true)
    await picker
      .getByRole('combobox', { name: 'Location', exact: true })
      .evaluate((element) => {
        const select = element as HTMLSelectElement
        select.value = '/home/operator'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    await picker.getByTestId('directory-picker-favorite').dispatchEvent('click')
    await page.keyboard.press('Meta+Shift+h')
    await page.keyboard.press('Meta+Shift+o')
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Meta+Enter')
    const pendingCalls = await page.evaluate(
      (offset) => window.directoryPickerFixture.calls.slice(offset),
      beforeCalls
    )
    expect(
      pendingCalls.filter(
        (call) => call.channel === Queries.ListServerDirectories
      )
    ).toHaveLength(0)
    expect(
      pendingCalls.filter(
        (call) => call.channel === Commands.MutateDirectoryPreferences
      )
    ).toHaveLength(0)
    expect(await parentSubmissions(page)).toHaveLength(0)
    await expect(picker).toBeVisible()
  })
}
