import { expect, type Locator, type Page, test } from '@playwright/test'
import { Commands } from '../../src/shared/protocol/commands'

async function expectSafePopup(popup: Locator, page: Page, top = 54) {
  await expect(popup).toBeVisible()
  await expect
    .poll(async () => {
      const rect = await popup.boundingBox()
      return (
        !!rect &&
        rect.y >= top - 0.5 &&
        rect.x >= -0.5 &&
        rect.y + rect.height <= (page.viewportSize()?.height ?? 0) + 0.5 &&
        rect.x + rect.width <= (page.viewportSize()?.width ?? 0) + 0.5
      )
    })
    .toBe(true)
}

async function openListView(page: Page) {
  const button = page.getByRole('button', { name: 'List View', exact: true })
  if (await button.isVisible()) await button.click()
  else {
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'List View', exact: true }).hover()
  }
  await expect(
    page.getByRole('menuitem', { name: 'Sort By', exact: true })
  ).toBeVisible()
}

async function openSortMenu(page: Page) {
  await openListView(page)
  await page.getByRole('menuitem', { name: 'Sort By', exact: true }).hover()
  return page.getByRole('menu', { name: 'Sort By', exact: true })
}

async function setGeometry(page: Page, left: number, right: number) {
  await page.evaluate(
    ({ left, right }) => {
      const root = document.documentElement
      root.style.setProperty('--window-controls-overlay-x', `${left}px`)
      root.style.setProperty(
        '--window-controls-overlay-width',
        `calc(100vw - ${left + right}px)`
      )
    },
    { left, right }
  )
}

test('long plugin settings selects keep options outside native controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 360 })
  await page.goto('/?mode=plugin-settings')
  await setGeometry(page, 108, 0)
  const trigger = page.getByRole('combobox')
  await trigger.click()
  const list = page.locator('[data-slot="select-content"]')
  await expectSafePopup(list, page)
  await page.getByRole('option', { name: 'Option 0', exact: true }).click()
  await expect(trigger).toHaveText('Option 0')
  await trigger.click()
  await page.getByRole('option', { name: 'Option 29', exact: true }).click()
  await expect(trigger).toHaveText('Option 29')
})

test('an open settings select follows native controls returning from fullscreen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 360 })
  await page.goto('/?mode=plugin-settings&fullscreen')
  await setGeometry(page, 0, 0)
  await page.getByRole('combobox').click()
  const list = page.locator('[data-slot="select-content"]')
  await expectSafePopup(list, page, 0)
  await setGeometry(page, 108, 0)
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('fixture-fullscreen', { detail: false })
    )
  })
  await expectSafePopup(list, page)
  await page.getByRole('option', { name: 'Option 0', exact: true }).click()
  await expect(page.getByRole('combobox')).toHaveText('Option 0')
})

for (const platform of ['win32', 'web']) {
  test(`${platform} settings selects retain item alignment`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 360 })
    await page.goto(`/?mode=plugin-settings&platform=${platform}`)
    await page.getByRole('combobox').click()
    await expect(page.locator('[data-slot="select-content"]')).toHaveAttribute(
      'data-side',
      'none'
    )
    await page.getByRole('option', { name: 'Option 0', exact: true }).click()
    await expect(page.getByRole('combobox')).toHaveText('Option 0')
  })
}

async function expectClickableActions(page: Page, safeTop = 54) {
  await page.getByRole('button', { name: 'Motrix', exact: true }).click()
  await expect(
    page.getByRole('menuitem', { name: 'About Motrix' })
  ).toBeVisible()
  await expect
    .poll(
      async () =>
        (
          await page
            .getByRole('menu', { name: 'Motrix', exact: true })
            .boundingBox()
        )?.y
    )
    .toBeGreaterThanOrEqual(safeTop)
  await page.keyboard.press('Escape')
  await page
    .getByRole('button', { name: 'Toggle sidebar', exact: true })
    .click({ trial: true })
  await page.getByRole('button', { name: 'New task', exact: true }).click()
  expect(
    await page.evaluate(() => window.windowChromeFixture.commands)
  ).toContain(Commands.ShowAddTaskWindow)
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await expectSafePopup(
    page.getByRole('menu', { name: 'More', exact: true }),
    page,
    safeTop
  )
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('menu', { name: 'More', exact: true })
  ).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    page.viewportSize()?.width
  )
}

for (const dir of ['ltr', 'rtl']) {
  for (const [layout, left, right] of [
    ['left', 108, 0],
    ['right', 0, 108],
    ['split', 36, 72],
  ] as const) {
    test(`${dir} ${layout}: real toolbar sorting menus stay clickable in short windows`, async ({
      page,
    }) => {
      for (const width of [320, 640]) {
        await page.setViewportSize({ width, height: 240 })
        await page.goto(`/?dir=${dir}`)
        await setGeometry(page, left, right)
        let sort = await openSortMenu(page)
        await expectSafePopup(sort, page)
        await sort
          .getByRole('menuitemradio', { name: 'Name', exact: true })
          .click()
        if (!(await sort.isVisible())) sort = await openSortMenu(page)
        await expectSafePopup(sort, page)
        // Auto-scroll must reach the final choice inside the submenu itself.
        await sort
          .getByRole('menuitemradio', { name: 'Descending', exact: true })
          .click()
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight)
        ).toBe(240)
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth)
        ).toBe(width)
      }
    })
  }
}

test('real search/filter popover respects the native boundary after the toolbar collapses', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 240 })
  await page.goto('/')
  await setGeometry(page, 108, 0)
  await page
    .getByRole('button', { name: 'Search downloads', exact: true })
    .click()
  await page
    .getByRole('textbox', { name: 'Search downloads', exact: true })
    .fill('linux')
  await page.getByRole('button', { name: /^Filters/ }).click()
  await expectSafePopup(page.locator('[data-slot="popover-content"]'), page)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  const sort = await openSortMenu(page)
  await expectSafePopup(sort, page)
  await sort.getByRole('menuitemradio', { name: 'Name', exact: true }).click()
})

test('an already-open sorting submenu follows fullscreen geometry changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 240 })
  await page.goto('/')
  await setGeometry(page, 108, 0)
  const sort = await openSortMenu(page)
  await expectSafePopup(sort, page)
  for (const fullscreen of [true, false]) {
    await page.evaluate((fullscreen) => {
      document
        .querySelectorAll<HTMLElement>('[data-native-overlay]')
        .forEach((element) => {
          element.hidden = fullscreen
        })
      window.dispatchEvent(
        new CustomEvent('fixture-fullscreen', { detail: fullscreen })
      )
    }, fullscreen)
    await expectSafePopup(sort, page, fullscreen ? 0 : 54)
  }
  await sort.getByRole('menuitemradio', { name: 'Name', exact: true }).click()
})

for (const dir of ['ltr', 'rtl']) {
  for (const [layout, left, right] of [
    ['right', 0, 108],
    ['left', 108, 0],
    ['split', 36, 72],
  ] as const) {
    test(`${dir} ${layout} controls leave main actions usable in compact and expanded layouts`, async ({
      page,
    }) => {
      for (const width of [320, 700, 1000]) {
        await page.setViewportSize({ width, height: 672 })
        await page.goto(`/?dir=${dir}${width === 1000 ? '&expanded' : ''}`)
        await setGeometry(page, left, right)
        await expect(
          page.locator('[data-slot="desktop-window-controls"]')
        ).toHaveCount(0)
        await expectClickableActions(page)
        const content = await page.getByTestId('panel-content').boundingBox()
        expect(content?.y).toBeGreaterThanOrEqual(54)
        await page.evaluate(() =>
          document.documentElement.classList.add('dark')
        )
        await expectClickableActions(page)
      }
    })
  }
}

test('safe areas react to layout changes and fullscreen without remounting', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 672 })
  await page.goto('/')
  for (const [left, right] of [
    [0, 108],
    [108, 0],
    [36, 72],
  ]) {
    await setGeometry(page, left, right)
    await expectClickableActions(page)
  }
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLElement>('[data-native-overlay]')
      .forEach((el) => {
        el.hidden = true
      })
    window.dispatchEvent(
      new CustomEvent('fixture-fullscreen', { detail: true })
    )
  })
  await expect(page.locator('.window-chrome')).toHaveAttribute(
    'data-fullscreen',
    'true'
  )
  await expect(page.locator('.window-chrome')).toHaveCSS('padding-left', '12px')
  await expect(page.locator('[data-slot="panel-shell-header"]')).toHaveCSS(
    'padding-right',
    '24px'
  )
  await expectClickableActions(page, 0)
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLElement>('[data-native-overlay]')
      .forEach((el) => {
        el.hidden = false
      })
    window.dispatchEvent(
      new CustomEvent('fixture-fullscreen', { detail: false })
    )
  })
  await expect(page.locator('.window-chrome')).toHaveCSS('padding-left', '48px')
  await expectClickableActions(page)
})

for (const mode of ['add-task', 'onboarding']) {
  test(`${mode} leaves space for native controls on both sides`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: mode === 'add-task' ? 640 : 400,
      height: 670,
    })
    await page.goto(`/?mode=${mode}`)
    for (const [left, right] of [
      [0, 108],
      [108, 0],
      [36, 72],
    ]) {
      await setGeometry(page, left, right)
      await expect(
        page.locator('[data-slot="desktop-window-controls"]')
      ).toHaveCount(0)
      const content = await page.getByTestId('panel-content').boundingBox()
      expect(content?.y).toBe(54)
      if (mode === 'onboarding') {
        await page.getByRole('combobox', { name: 'Language' }).click()
        const options = page.getByRole('listbox')
        await expect(options).toBeVisible()
        await expect
          .poll(async () => (await options.boundingBox())?.y)
          .toBeGreaterThanOrEqual(54)
        await page.keyboard.press('Escape')
      }
    }
  })
}
