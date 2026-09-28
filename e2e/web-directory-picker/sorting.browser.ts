import { expect, type Locator, type Page, test } from '@playwright/test'
import { Commands } from '../../src/shared/protocol/commands'
import { Queries } from '../../src/shared/protocol/queries'

const STORAGE_KEY = 'motrix.web-directory-picker.sort.v1'
const names = [
  'Folder 10',
  'folder 2',
  'Unknown 10',
  'Zero',
  'alpha',
  'Folder 2',
  'Unknown 2',
]
const natural = [
  'alpha',
  'Folder 2',
  'folder 2',
  'Folder 10',
  'Unknown 2',
  'Unknown 10',
  'Zero',
]
const modifiedAscending = [
  'alpha',
  'Folder 2',
  'folder 2',
  'Zero',
  'Folder 10',
  'Unknown 2',
  'Unknown 10',
]
const modifiedDescending = [
  'Folder 10',
  'Folder 2',
  'folder 2',
  'Zero',
  'alpha',
  'Unknown 2',
  'Unknown 10',
]

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    })
  )
})

async function seedEntries(page: Page) {
  await page.evaluate((children) => {
    window.directoryPickerFixture.setDirectoryChildren('/downloads', children)
    window.directoryPickerFixture.modifiedAtByPath = {
      '/downloads/alpha': -100,
      '/downloads/Folder 2': 0,
      '/downloads/folder 2': 0,
      '/downloads/Zero': 0,
      '/downloads/Folder 10': 10.5,
    }
  }, names)
}

async function openPicker(page: Page) {
  await page
    .getByRole('button', { name: 'Open download dialog', exact: true })
    .click()
  const parent = page.getByRole('dialog', { name: 'New Task', exact: true })
  await parent
    .getByRole('button', { name: 'Change directory', exact: true })
    .click()
  const picker = page.getByRole('dialog', {
    name: 'Select server folder',
    exact: true,
  })
  const list = picker.getByRole('listbox', { name: 'Folders', exact: true })
  await expect(list).toHaveAttribute('aria-busy', 'false')
  await expect(picker.getByTestId('directory-picker-favorite')).toBeEnabled()
  return { parent, picker, list }
}

async function choose(
  page: Page,
  picker: Locator,
  label: 'Name' | 'Date modified' | 'Ascending' | 'Descending'
) {
  await picker
    .getByRole('button', { name: 'View options', exact: true })
    .click()
  const menu = page.getByRole('menu', { name: 'View options', exact: true })
  await menu.getByRole('menuitemradio', { name: label, exact: true }).click()
  await expect(menu).not.toBeVisible()
  await expect(
    picker.getByRole('listbox', { name: 'Folders', exact: true })
  ).toBeFocused()
}

async function labels(list: Locator) {
  return list.getByRole('option').allTextContents()
}

async function expectVisibleRow(list: Locator, row: Locator) {
  // Browser zoom/layout may leave a fraction of a pixel outside the scroll clip.
  await expect(row).toBeInViewport({ ratio: 0.98 })
  const container = await list.boundingBox()
  const bounds = await row.boundingBox()
  if (!container || !bounds) throw new Error('Expected visible list and row')
  expect(bounds.y).toBeGreaterThanOrEqual(container.y - 1)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(
    container.y + container.height + 1
  )
}

async function goTo(picker: Locator, path: string) {
  await picker
    .getByRole('button', { name: 'Go to folder', exact: true })
    .click()
  await picker
    .getByRole('textbox', { name: 'Folder path', exact: true })
    .fill(path)
  await picker.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(
    picker.getByRole('listbox', { name: 'Folders', exact: true })
  ).toHaveAttribute('aria-busy', 'false')
}

async function calls(page: Page) {
  return page.evaluate(() => window.directoryPickerFixture.calls)
}

test('name and modification ordering use natural ties, numeric times and missing-last without RPC', async ({
  page,
}) => {
  await page.goto('/')
  await seedEntries(page)
  const { picker, list } = await openPicker(page)
  await expect.poll(() => labels(list)).toEqual(natural)
  const before = await calls(page)
  await choose(page, picker, 'Descending')
  await expect.poll(() => labels(list)).toEqual([...natural].reverse())
  await choose(page, picker, 'Date modified')
  await expect.poll(() => labels(list)).toEqual(modifiedDescending)
  await choose(page, picker, 'Ascending')
  await expect.poll(() => labels(list)).toEqual(modifiedAscending)
  await choose(page, picker, 'Name')
  await expect.poll(() => labels(list)).toEqual(natural)
  expect(await calls(page)).toEqual(before)
  await test.info().attach('sort-request-budget', {
    body: JSON.stringify({
      changes: 4,
      additionalCalls: 0,
      finalOrder: natural,
    }),
    contentType: 'application/json',
  })
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
      STORAGE_KEY
    )
  ).toEqual({ version: 1, by: 'name', direction: 'asc' })
})

test('keyboard movement and prefix search use the displayed order while confirmation remains path-based', async ({
  page,
}) => {
  await page.goto('/')
  await seedEntries(page)
  const { parent, picker, list } = await openPicker(page)
  await choose(page, picker, 'Date modified')
  await choose(page, picker, 'Descending')
  await page.keyboard.press('Home')
  await expect(picker.getByTestId('directory-picker-target')).toHaveText(
    '/downloads/Folder 10'
  )
  await page.keyboard.press('ArrowDown')
  await expect(picker.getByTestId('directory-picker-target')).toHaveText(
    '/downloads/Folder 2'
  )
  await page.keyboard.press('End')
  await expect(picker.getByTestId('directory-picker-target')).toHaveText(
    '/downloads/Unknown 10'
  )
  await page.keyboard.press('f')
  await expect(picker.getByTestId('directory-picker-target')).toHaveText(
    '/downloads/Folder 10'
  )
  const selected = list.locator('[aria-selected="true"]')
  await expect(selected).toHaveAttribute('aria-posinset', '1')
  await expect(list).toHaveAttribute(
    'aria-activedescendant',
    (await selected.getAttribute('id')) ?? ''
  )
  await picker
    .getByRole('button', { name: 'Select folder', exact: true })
    .click()
  await expect(picker).not.toBeVisible()
  await expect(
    parent.getByRole('button', { name: 'Change directory', exact: true })
  ).toHaveAttribute('title', '/downloads/Folder 10')
  expect(
    (await calls(page)).filter((call) => call.channel === Commands.CreateTask)
  ).toHaveLength(0)
})

for (const select of [false, true]) {
  test(`sorting a scrolled list ${select ? 'reveals its selected path' : 'returns to the top without selecting a folder'}`, async ({
    page,
  }) => {
    await page.goto('/')
    const { picker, list } = await openPicker(page)
    await goTo(picker, '/archive')
    await list.evaluate((element) => {
      element.scrollTop = 600 * 32
    })
    const selected = list.getByRole('option', {
      name: 'Folder 0600',
      exact: true,
    })
    await expectVisibleRow(list, selected)
    if (select) await selected.click()
    const before = await calls(page)
    await choose(page, picker, 'Descending')
    expect(await calls(page)).toEqual(before)
    if (select) {
      await expect(selected).toHaveAttribute('aria-selected', 'true')
      await expect(selected).toHaveAttribute('aria-posinset', '200')
      await expectVisibleRow(list, selected)
      await expect(picker.getByTestId('directory-picker-target')).toHaveText(
        '/archive/Folder 0600'
      )
    } else {
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBe(0)
      await expect(list.locator('[aria-selected="true"]')).toHaveCount(0)
      await expect(picker.getByTestId('directory-picker-target')).toHaveText(
        '/archive'
      )
    }
    const offset = await list.evaluate((element) => element.scrollTop)
    await choose(page, picker, 'Descending')
    expect(await calls(page)).toEqual(before)
    expect(await list.evaluate((element) => element.scrollTop)).toBe(offset)
  })
}

test('Back after sorting elsewhere reveals historical selection and refresh retains the chosen order', async ({
  page,
}) => {
  await page.goto('/')
  const { picker, list } = await openPicker(page)
  await goTo(picker, '/archive')
  await list.evaluate((element) => {
    element.scrollTop = 600 * 32
  })
  await list.getByRole('option', { name: 'Folder 0600', exact: true }).click()
  await goTo(picker, '/downloads')
  await choose(page, picker, 'Descending')
  await picker.getByRole('button', { name: 'Back', exact: true }).click()
  const selected = list.getByRole('option', {
    name: 'Folder 0600',
    exact: true,
  })
  await expect(selected).toHaveAttribute('aria-selected', 'true')
  await expect(selected).toHaveAttribute('aria-posinset', '200')
  await expectVisibleRow(list, selected)
  await expect(picker.getByTestId('directory-picker-target')).toHaveText(
    '/archive/Folder 0600'
  )
  const offset = await list.evaluate((element) => element.scrollTop)
  expect(offset).not.toBe(600 * 32)
  await picker.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(list).toHaveAttribute('aria-busy', 'false')
  await expect(selected).toHaveAttribute('aria-posinset', '200')
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(offset)
  await test.info().attach('history-sort-reveal', {
    body: JSON.stringify({
      oldOffset: 600 * 32,
      restoredOffset: offset,
      selectedPosition: 200,
      selectedBounds: await selected.boundingBox(),
      listBounds: await list.boundingBox(),
    }),
    contentType: 'application/json',
  })
})

test('sort survives picker reopening and a new page using only versioned preference data', async ({
  page,
}) => {
  await page.goto('/')
  await seedEntries(page)
  const { parent, picker } = await openPicker(page)
  await choose(page, picker, 'Date modified')
  await choose(page, picker, 'Descending')
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  await parent
    .getByRole('button', { name: 'Change directory', exact: true })
    .click()
  await expect
    .poll(() =>
      labels(picker.getByRole('listbox', { name: 'Folders', exact: true }))
    )
    .toEqual(modifiedDescending)
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
      STORAGE_KEY
    )
  ).toEqual({ version: 1, by: 'modified', direction: 'desc' })
  await page.reload()
  await seedEntries(page)
  const reopened = await openPicker(page)
  await expect.poll(() => labels(reopened.list)).toEqual(modifiedDescending)
})

test('a blocked storage write keeps the latest in-memory choice when a picker reopens', async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({ version: 1, by: 'name', direction: 'asc' })
    )
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (name, value) {
      if (name === key)
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      original.call(this, name, value)
    }
  }, STORAGE_KEY)
  await page.goto('/')
  await seedEntries(page)
  const { parent, picker, list } = await openPicker(page)
  await choose(page, picker, 'Date modified')
  await choose(page, picker, 'Descending')
  await expect.poll(() => labels(list)).toEqual(modifiedDescending)
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  await parent
    .getByRole('button', { name: 'Change directory', exact: true })
    .click()
  await expect.poll(() => labels(list)).toEqual(modifiedDescending)
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
      STORAGE_KEY
    )
  ).toEqual({ version: 1, by: 'name', direction: 'asc' })
})

for (const width of [1024, 390]) {
  test(`View sorting radios support keyboard choice, Escape and parent isolation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 620 })
    await page.goto('/')
    await seedEntries(page)
    const { picker, list } = await openPicker(page)
    const trigger = picker.getByRole('button', {
      name: 'View options',
      exact: true,
    })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'View options', exact: true })
    const name = menu.getByRole('menuitemradio', { name: 'Name', exact: true })
    const modified = menu.getByRole('menuitemradio', {
      name: 'Date modified',
      exact: true,
    })
    await expect(name).toBeChecked()
    await expect(
      menu.getByRole('menuitemradio', { name: 'Ascending', exact: true })
    ).toBeChecked()
    await expect(menu.getByText('Sort by', { exact: true })).toBeVisible()
    await expect(menu.getByText('Order', { exact: true })).toBeVisible()
    await name.focus()
    const before = await calls(page)
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Meta+Enter')
    await expect(menu).toBeVisible()
    await expect(name).toBeChecked()
    expect(await calls(page)).toEqual(before)
    await page.keyboard.press('ArrowDown')
    await expect(modified).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await expect(picker).toBeVisible()
    await expect.poll(() => labels(list)).toEqual(natural)
    await page.keyboard.press('Enter')
    await name.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(menu).not.toBeVisible()
    await expect(list).toBeFocused()
    await expect.poll(() => labels(list)).toEqual(modifiedAscending)
    await trigger.click()
    await expect(modified).toBeChecked()
    await menu
      .getByRole('menuitemradio', { name: 'Descending', exact: true })
      .focus()
    await page.keyboard.press('Space')
    await expect(menu).not.toBeVisible()
    await expect(list).toBeFocused()
    await expect.poll(() => labels(list)).toEqual(modifiedDescending)
    await trigger.click()
    await expect(modified).toBeChecked()
    await expect(
      menu.getByRole('menuitemradio', { name: 'Descending', exact: true })
    ).toBeChecked()
    await expect(menu).toHaveCSS('opacity', '1')
    const menuBounds = await menu.boundingBox()
    if (!menuBounds) throw new Error('Expected the View options menu to exist')
    expect(menuBounds.height).toBeLessThan(252)
    expect(menuBounds.x).toBeGreaterThanOrEqual(0)
    expect(menuBounds.y).toBeGreaterThanOrEqual(0)
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width)
    expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(620)
    const rows = await menu
      .locator('[role="menuitemradio"], [role="menuitemcheckbox"]')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          label: element.textContent,
          height: element.getBoundingClientRect().height,
        }))
      )
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row.height).toBeGreaterThanOrEqual(24)
      expect(row.height).toBeLessThanOrEqual(28)
    }
    await test.info().attach(`compact-view-menu-${width}`, {
      body: JSON.stringify({
        viewport: { width, height: 620 },
        menuBounds,
        rows,
      }),
      contentType: 'application/json',
    })
    await picker.screenshot({
      path: test.info().outputPath(`sort-picker-${width}.png`),
    })
    await menu.screenshot({
      path: test.info().outputPath(`sort-menu-${width}.png`),
    })
    expect(
      (await calls(page)).filter((call) => call.channel === Commands.CreateTask)
    ).toHaveLength(0)
    expect(
      (await calls(page)).filter(
        (call) => call.channel === Queries.ListServerDirectories
      )
    ).toHaveLength(1)
  })
}
