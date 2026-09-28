import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { Commands } from '../../src/shared/protocol/commands'
import { Queries } from '../../src/shared/protocol/queries'
import type { fixtureState } from './fixture-transport'

declare global {
  interface Window {
    directoryPickerFixture: typeof fixtureState
  }
}

async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 25; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement))
      return
    await page.keyboard.press('Tab')
    // Base UI focus guards defer focus with rAF. Observe the completed focus
    // transition before another key, including callbacks queued by that frame.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
  }
  await expect(target).toBeFocused()
}

async function openPicker(
  page: Page,
  mac = false,
  query = '',
  entry: 'links' | 'torrent' | 'general' = 'links'
) {
  await page.addInitScript((isMac) => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      get: () => (isMac ? 'MacIntel' : 'Win32'),
    })
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      get: () => ({ platform: isMac ? 'macOS' : 'Windows' }),
    })
  }, mac)
  await page.goto(`/${query}`)
  const launchName =
    entry === 'links'
      ? 'Open download dialog'
      : entry === 'torrent'
        ? 'Open torrent dialog'
        : 'Open General settings'
  await tabTo(page, page.getByRole('button', { name: launchName }))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1')
  const opener = page.getByRole('button', {
    name: entry === 'general' ? 'Browse…' : 'Change directory',
    exact: true,
  })
  await tabTo(page, opener)
  await page.keyboard.press('Enter')
  const picker = page.getByRole('dialog', {
    name: 'Select server folder',
    exact: true,
  })
  try {
    await expect(picker).toBeVisible()
  } catch (error) {
    await saveJson(
      test.info().outputPath('picker-open-interactions.json'),
      await page.evaluate(() => ({
        interactions: window.directoryPickerFixture.interactions,
        calls: window.directoryPickerFixture.calls,
      }))
    )
    throw error
  }
  // Reject misleading interaction evidence if Tailwind missed production source.
  await expect(picker).toHaveCSS('position', 'fixed')
  await expect(picker).toHaveCSS('display', 'flex')
  await expect(picker).toHaveCSS('z-index', '50')
  await expect(
    picker.getByRole('option', { name: 'Movies', exact: true })
  ).toBeVisible()
  await expect(picker.getByRole('listbox', { name: 'Folders' })).toBeFocused()
  return {
    picker,
    opener,
    list: picker.getByRole('listbox', { name: 'Folders' }),
  }
}

async function switchRoot(picker: Locator, path: string) {
  const select = picker.getByRole('combobox', { name: 'Location', exact: true })
  if (await select.isVisible()) await select.selectOption(path)
  else
    await picker
      .getByRole('navigation', { name: 'Location', exact: true })
      .getByTitle(path, { exact: true })
      .first()
      .click()
}

async function calls(page: Page, channel: string) {
  return page.evaluate(
    (name) =>
      window.directoryPickerFixture.calls.filter(
        (call) => call.channel === name
      ),
    channel
  )
}

async function captureSettled(page: Page, picker: Locator, path: string) {
  await expect(picker).toHaveCSS('opacity', '1')
  await expect
    .poll(() =>
      picker.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === 'running')
      )
    )
    .toBe(false)
  const alpha = await picker.evaluate((element) => {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return 0
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return context.getImageData(0, 0, 1, 1).data[3]
  })
  expect(alpha).toBe(255)
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
}

test('keyboard-only Windows navigation, creation and confirmation preserve the parent form', async ({
  page,
}) => {
  const { picker, list, opener } = await openPicker(page)
  await page.keyboard.type('mov')
  await expect(
    picker.getByRole('option', { name: 'Movies', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(picker.getByRole('option', { name: 'Classics' })).toBeVisible()
  await tabTo(
    page,
    picker.getByRole('button', { name: 'New folder', exact: true })
  )
  await page.keyboard.press('Enter')
  const name = picker.getByRole('textbox', { name: 'Folder name' })
  await expect(name).toBeFocused()
  await page.keyboard.type('Keyboard folder')
  await page.keyboard.press('Enter')
  await expect(
    picker.getByRole('option', { name: 'Keyboard folder', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await expect(list).toBeFocused()
  await tabTo(
    page,
    picker.getByRole('button', { name: 'Select folder', exact: true })
  )
  await page.keyboard.press('Enter')
  await expect(picker).not.toBeVisible()
  await expect(opener).toBeFocused()
  await expect(opener).toHaveAttribute(
    'title',
    '/downloads/Movies/Keyboard folder'
  )
  expect(await calls(page, Commands.CreateServerDirectory)).toHaveLength(1)
  expect(await calls(page, Queries.ValidateServerDirectory)).toEqual([
    {
      channel: Queries.ValidateServerDirectory,
      args: [{ path: '/downloads/Movies/Keyboard folder' }],
    },
  ])
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
})

test('Mac client keys enter and confirm independently of the Linux server platform', async ({
  page,
}) => {
  const { picker, opener } = await openPicker(
    page,
    true,
    '?transportPlatform=linux'
  )
  await page.keyboard.type('mov')
  await page.keyboard.press('Meta+ArrowDown')
  await expect(picker.getByRole('option', { name: 'Classics' })).toBeVisible()
  await page.keyboard.press('Meta+ArrowUp')
  await expect(
    picker.getByRole('option', { name: 'Movies', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(picker).not.toBeVisible()
  await expect(opener).toHaveAttribute('title', '/downloads/Movies')
})

test('double-click, parent navigation, roots and exact paths keep a coherent listing', async ({
  page,
}) => {
  const { picker } = await openPicker(page)
  await expect(
    picker.getByRole('button', { name: 'Up one level', exact: true })
  ).toBeDisabled()
  await picker.getByRole('option', { name: 'Movies', exact: true }).dblclick()
  await expect(picker.getByRole('option', { name: 'Classics' })).toBeVisible()
  await picker
    .getByRole('button', { name: 'Up one level', exact: true })
    .click()
  await expect(
    picker.getByRole('option', { name: 'Movies', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await picker
    .getByRole('button', { name: 'Go to folder', exact: true })
    .click()
  await picker.getByRole('textbox', { name: 'Folder path' }).fill('/outside')
  await picker.getByRole('textbox', { name: 'Folder path' }).press('Enter')
  await expect(
    picker.getByText('This folder is outside the allowed locations.')
  ).toBeVisible()
  await expect(
    picker.getByRole('option', { name: 'Movies', exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    picker.getByRole('button', { name: 'Up one level', exact: true })
  ).toBeDisabled()
  await switchRoot(picker, '/archive')
  await expect(
    picker.getByRole('option', { name: 'Folder 0000', exact: true })
  ).toBeVisible()
  await expect(
    picker.getByRole('button', { name: 'Up one level', exact: true })
  ).toBeDisabled()
})

test('nested Escape restores focus and preserves the parent draft until discard is confirmed', async ({
  page,
}) => {
  const { picker, list, opener } = await openPicker(page)
  await page.keyboard.press('Control+Enter')
  await page.keyboard.press('Control+Shift+N')
  await page.keyboard.press('Control+,')
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
  expect(new URL(page.url()).hash).toBe('')
  await picker.getByRole('button', { name: 'New folder', exact: true }).click()
  await picker
    .getByRole('textbox', { name: 'Folder name' })
    .fill('Discarded draft')
  await page.keyboard.press('Escape')
  await expect(picker).toBeVisible()
  await expect(
    picker.getByRole('textbox', { name: 'Folder name' })
  ).not.toBeVisible()
  await expect(list).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(picker).not.toBeVisible()
  await expect(opener).toBeVisible()
  await expect(opener).toBeFocused()
  await expect(opener).toHaveAttribute('title', '/downloads')
  expect(await calls(page, Commands.CreateServerDirectory)).toHaveLength(0)
  // Web no longer installs the legacy document-level preferences shortcut.
  await page.keyboard.press('Control+,')
  expect(new URL(page.url()).hash).toBe('')
  const parent = page.getByRole('dialog', { name: 'New Task', exact: true })
  const draft = parent.locator('textarea')
  await draft.fill('https://example.com/retained-draft.zip')
  await page.keyboard.press('Escape')
  const confirmation = page.getByRole('dialog', {
    name: 'Discard this task draft?',
    exact: true,
  })
  await expect(confirmation).toBeVisible()
  await confirmation
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await expect(confirmation).not.toBeVisible()
  await expect(parent).toBeVisible()
  await expect(draft).toHaveValue('https://example.com/retained-draft.zip')
  await parent.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirmation).toBeVisible()
  await confirmation
    .getByRole('button', { name: 'Discard', exact: true })
    .click()
  await expect(parent).not.toBeVisible()
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
})

test('creation failure retains the editor and typed name for correction', async ({
  page,
}) => {
  const { picker } = await openPicker(page)
  await page.evaluate(() => {
    window.directoryPickerFixture.createFailure = true
  })
  await picker.getByRole('button', { name: 'New folder', exact: true }).click()
  const name = picker.getByRole('textbox', { name: 'Folder name' })
  await name.fill('Keep this name')
  await name.press('Enter')
  await expect(
    picker.getByText('You do not have permission to use this folder.')
  ).toBeVisible()
  await expect(name).toHaveValue('Keep this name')
  await expect(
    picker.getByRole('button', { name: 'Select folder', exact: true })
  ).toBeDisabled()
  expect(await calls(page, Commands.CreateServerDirectory)).toHaveLength(1)
  await page.keyboard.press('Escape')
  await expect(picker).toBeVisible()
})

test('virtualization retains the active descendant after scrolling far away', async ({
  page,
}) => {
  const { picker, list } = await openPicker(page)
  await switchRoot(picker, '/archive')
  await expect(
    picker.getByRole('option', { name: 'Folder 0000', exact: true })
  ).toBeVisible()
  await list.focus()
  await page.keyboard.press('ArrowDown')
  const activeId = await list.getAttribute('aria-activedescendant')
  expect(activeId).toBeTruthy()
  // Scroll via the real pointer wheel without changing keyboard selection.
  await list.hover()
  await page.mouse.wheel(0, 20_000)
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(1000)
  await expect(
    picker.getByRole('option', { name: 'Folder 0000', exact: true })
  ).not.toBeInViewport()
  await expect(
    picker.getByRole('option', { name: 'Folder 0000', exact: true })
  ).toBeAttached()
  await expect(list).toHaveAttribute('aria-activedescendant', activeId ?? '')
  expect(
    await page.evaluate(
      (id) => !!id && document.getElementById(id) !== null,
      activeId
    )
  ).toBe(true)
  expect(await picker.getByRole('option').count()).toBeLessThan(100)
  const wheelOffset = await list.evaluate((element) => element.scrollTop)
  await picker.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(list).toBeFocused()
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeCloseTo(wheelOffset, 0)
  await expect(list).toHaveAttribute('aria-activedescendant', activeId ?? '')
  await expect(
    picker.getByRole('option', { name: 'Folder 0000', exact: true })
  ).not.toBeInViewport()
  await switchRoot(picker, '/downloads')
  await expect(
    picker.getByRole('option', { name: 'Movies', exact: true })
  ).toBeVisible()
  await picker.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(list).toBeFocused()
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeCloseTo(wheelOffset, 0)
  await expect(list).toHaveAttribute('aria-activedescendant', activeId ?? '')
  await expect(
    picker.getByRole('option', { name: 'Folder 0000', exact: true })
  ).toBeAttached()
  await expect(
    picker.getByRole('option', { name: 'Folder 0000', exact: true })
  ).not.toBeInViewport()
  await page.keyboard.press('End')
  await expect(
    picker.getByRole('option', { name: 'Folder 0799', exact: true })
  ).toBeVisible()
})

for (const theme of ['light', 'dark']) {
  test(`small viewport keeps navigation and confirmation visible (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 620 })
    const { picker } = await openPicker(page, false, `?theme=${theme}`)
    await expect(
      picker.getByRole('navigation', { name: 'Location', exact: true })
    ).not.toBeVisible()
    await expect(
      picker.getByRole('combobox', { name: 'Location', exact: true })
    ).toBeInViewport({ ratio: 1 })
    await expect(
      picker.getByRole('button', { name: 'New folder', exact: true })
    ).toBeInViewport({ ratio: 1 })
    await expect(
      picker.getByRole('button', { name: 'Select folder', exact: true })
    ).toBeInViewport({ ratio: 1 })
    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > innerWidth,
      vertical: document.documentElement.scrollHeight > innerHeight,
    }))
    expect(overflow).toEqual({ horizontal: false, vertical: false })
    await captureSettled(
      page,
      picker,
      testInfo.outputPath(`picker-${theme}-390x620.png`)
    )
    await picker
      .getByRole('button', { name: 'New folder', exact: true })
      .click()
    await expect(
      picker.getByRole('textbox', { name: 'Folder name' })
    ).toBeInViewport({ ratio: 1 })
    await expect(
      picker.getByRole('button', { name: 'Create', exact: true })
    ).toBeInViewport({ ratio: 1 })
    await captureSettled(
      page,
      picker,
      testInfo.outputPath(`picker-${theme}-create-390x620.png`)
    )
  })
}

test('torrent save directory uses the same picker without submitting a download', async ({
  page,
}) => {
  const { picker, opener } = await openPicker(page, false, '', 'torrent')
  await picker.getByRole('option', { name: 'Music', exact: true }).click()
  await picker
    .getByRole('button', { name: 'Select folder', exact: true })
    .click()
  await expect(picker).not.toBeVisible()
  await expect(opener).toHaveAttribute('title', '/downloads/Music')
  await expect(opener).toBeFocused()
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
  expect(await calls(page, Commands.UpdateSettings)).toHaveLength(0)
})

test('General settings retains its own Cancel and Save boundary after selection', async ({
  page,
}) => {
  const { picker, opener } = await openPicker(page, false, '', 'general')
  await picker.getByRole('option', { name: 'Movies', exact: true }).click()
  await picker
    .getByRole('button', { name: 'Select folder', exact: true })
    .click()
  await expect(picker).not.toBeVisible()
  await expect(opener).toBeFocused()
  const general = page.getByRole('dialog', { name: 'General', exact: true })
  await expect(general.getByRole('textbox')).toHaveValue('/downloads/Movies')
  expect(await calls(page, Commands.SaveGeneralSettings)).toHaveLength(0)
  expect(await calls(page, Commands.MutateDirectoryPreferences)).toHaveLength(0)
  await general.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Open General settings' }).click()
  await expect(general.getByRole('textbox')).toHaveValue('/downloads')
  await general.getByRole('button', { name: 'Browse…', exact: true }).click()
  await expect(picker).toBeVisible()
  await picker.getByRole('option', { name: 'Music', exact: true }).click()
  await picker
    .getByRole('button', { name: 'Select folder', exact: true })
    .click()
  await expect(general.getByRole('textbox')).toHaveValue('/downloads/Music')
  expect(await calls(page, Commands.SaveGeneralSettings)).toHaveLength(0)
  expect(await calls(page, Commands.MutateDirectoryPreferences)).toHaveLength(0)
  await general.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(general).not.toBeVisible()
  expect(await calls(page, Commands.SaveGeneralSettings)).toEqual([
    {
      channel: Commands.SaveGeneralSettings,
      args: [
        {
          expectedRevision: expect.any(String),
          app: { defaultSaveDir: '/downloads/Music' },
          directories: {
            addFavorites: [],
            removeFavorites: [],
            removeRecent: [],
          },
        },
      ],
    },
  ])
  await page.getByRole('button', { name: 'Open General settings' }).click()
  await expect(general.getByRole('textbox')).toHaveValue('/downloads/Music')
})

test('desktop selection keeps the complete target path visible', async ({
  page,
}, testInfo) => {
  const { picker } = await openPicker(page)
  await picker.getByRole('option', { name: 'Movies', exact: true }).click()
  await expect(
    picker.getByRole('option', { name: 'Movies', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    picker.getByText('/downloads/Movies', { exact: true })
  ).toBeVisible()
  const locations = picker.getByRole('navigation', {
    name: 'Location',
    exact: true,
  })
  await expect(locations).toBeVisible()
  await expect(
    picker.getByRole('combobox', { name: 'Location', exact: true })
  ).not.toBeVisible()
  const bounds = await picker.evaluate((dialog) => {
    const rect = (selector: string) => {
      const element = dialog.querySelector(selector)
      if (!element) throw new Error(`Missing layout region: ${selector}`)
      const { x, y, width, height, right, bottom } =
        element.getBoundingClientRect()
      return { x, y, width, height, right, bottom }
    }
    return {
      dialog: rect('[data-testid="directory-picker-main"]'),
      side: rect('[data-testid="directory-picker-locations"]'),
      toolbar: rect('[data-testid="directory-picker-toolbar"]'),
      list: rect('[role="listbox"]'),
      target: rect('[data-testid="directory-picker-target"]'),
      actions: rect('[data-testid="directory-picker-actions"]'),
    }
  })
  expect(bounds.side.right).toBeLessThanOrEqual(bounds.list.x + 1)
  expect(bounds.side.height).toBeGreaterThanOrEqual(bounds.dialog.height - 2)
  expect(bounds.toolbar.bottom).toBeLessThanOrEqual(bounds.list.y + 1)
  expect(bounds.list.height).toBeGreaterThan(bounds.dialog.height * 0.45)
  expect(bounds.target.y).toBeGreaterThanOrEqual(bounds.list.bottom - 1)
  expect(bounds.target.bottom).toBeLessThanOrEqual(bounds.actions.y + 1)
  const newFolder = await picker
    .getByRole('button', { name: 'New folder', exact: true })
    .boundingBox()
  const cancel = await picker
    .getByRole('button', { name: 'Cancel', exact: true })
    .boundingBox()
  const confirm = await picker
    .getByRole('button', { name: 'Select folder', exact: true })
    .boundingBox()
  if (!newFolder || !cancel || !confirm)
    throw new Error('Missing native-layout footer action')
  expect(newFolder.x + newFolder.width).toBeLessThan(cancel.x)
  expect(cancel.x + cancel.width).toBeLessThanOrEqual(confirm.x)
  expect(Math.abs(newFolder.y - confirm.y)).toBeLessThanOrEqual(1)
  await captureSettled(
    page,
    picker,
    testInfo.outputPath('picker-selected-desktop-1024x768.png')
  )
  await picker.screenshot({
    path: testInfo.outputPath('picker-native-panel.png'),
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1200, height: 800 })
  await picker.getByRole('option', { name: 'Empty', exact: true }).dblclick()
  await expect(picker.getByText('No subfolders', { exact: true })).toBeVisible()
  await expect(
    picker.getByText('/downloads/Empty', { exact: true })
  ).toBeVisible()
  await captureSettled(
    page,
    picker,
    testInfo.outputPath('picker-empty-native-comparison-1200x800.png')
  )
})

test('short viewport keeps creation errors and footer controls reachable', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 640, height: 420 })
  const { picker } = await openPicker(page, false, '?theme=dark')
  await picker.getByRole('button', { name: 'New folder', exact: true }).click()
  const name = picker.getByRole('textbox', { name: 'Folder name' })
  await name.fill('Movies')
  await name.press('Enter')
  await expect(
    picker.getByText('A file or folder with this name already exists.')
  ).toBeInViewport({ ratio: 1 })
  await expect(
    picker.getByRole('button', { name: 'Select folder', exact: true })
  ).toBeInViewport({ ratio: 1 })
  await expect(name).toBeInViewport({ ratio: 1 })
  await captureSettled(
    page,
    picker,
    testInfo.outputPath('picker-create-error-short-640x420.png')
  )
})

test('creating then cancelling selection keeps the folder and original form path', async ({
  page,
}) => {
  const { picker, opener } = await openPicker(page)
  await picker.getByRole('button', { name: 'New folder', exact: true }).click()
  const name = picker.getByRole('textbox', { name: 'Folder name' })
  await name.fill('Persistent folder')
  await name.press('Enter')
  await expect(
    picker.getByRole('option', { name: 'Persistent folder', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(picker).not.toBeVisible()
  await expect(opener).toHaveAttribute('title', '/downloads')
  await expect(opener).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(
    picker.getByRole('option', { name: 'Persistent folder', exact: true })
  ).toBeVisible()
  expect(await calls(page, Commands.CreateServerDirectory)).toHaveLength(1)
  expect(await calls(page, Queries.ValidateServerDirectory)).toHaveLength(0)
})

test('pending creation contains focus and shortcuts, then restores the rejected name editor', async ({
  page,
}) => {
  const { picker } = await openPicker(page)
  await page.evaluate((channel) => {
    window.directoryPickerFixture.holdChannel = channel
    window.directoryPickerFixture.createFailure = true
  }, Commands.CreateServerDirectory)
  await picker.getByRole('button', { name: 'New folder', exact: true }).click()
  const name = picker.getByRole('textbox', { name: 'Folder name' })
  await name.fill('Pending folder')
  await name.press('Enter')
  await expect(name).toBeDisabled()
  await expect
    .poll(() =>
      page.evaluate(() => window.directoryPickerFixture.releaseRequest !== null)
    )
    .toBe(true)
  await expect
    .poll(() =>
      picker.evaluate((element) => element.contains(document.activeElement))
    )
    .toBe(true)
  await page.keyboard.press('Control+Enter')
  await page.keyboard.press('Control+Shift+N')
  await page.keyboard.press('Control+,')
  await page.keyboard.press('Escape')
  await expect(picker).toBeVisible()
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
  expect(new URL(page.url()).hash).toBe('')
  await page.keyboard.press('Tab')
  await expect
    .poll(() =>
      picker.evaluate((element) => element.contains(document.activeElement))
    )
    .toBe(true)
  await page.evaluate(() => window.directoryPickerFixture.releaseRequest?.())
  await expect(
    picker.getByText('You do not have permission to use this folder.')
  ).toBeVisible()
  await expect(name).toBeEnabled()
  await expect(name).toBeFocused()
  await expect(name).toHaveValue('Pending folder')
  expect(await calls(page, Commands.CreateServerDirectory)).toHaveLength(1)
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
})

test('pending path navigation and validation retain dialog focus and isolate parent shortcuts', async ({
  page,
}) => {
  const { picker, opener } = await openPicker(page)
  await page.evaluate((channel) => {
    window.directoryPickerFixture.holdChannel = channel
  }, Queries.ListServerDirectories)
  await picker
    .getByRole('button', { name: 'Go to folder', exact: true })
    .click()
  const path = picker.getByRole('textbox', { name: 'Folder path' })
  await path.fill('/downloads/Movies')
  await path.press('Enter')
  await expect(path).toBeDisabled()
  await expect
    .poll(() =>
      picker.evaluate((element) => element.contains(document.activeElement))
    )
    .toBe(true)
  await page.keyboard.press('Control+Enter')
  await page.keyboard.press('Control+,')
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
  expect(new URL(page.url()).hash).toBe('')
  await page.evaluate(() => window.directoryPickerFixture.releaseRequest?.())
  await expect(
    picker.getByRole('option', { name: 'Classics', exact: true })
  ).toBeVisible()
  await page.evaluate((channel) => {
    window.directoryPickerFixture.holdChannel = channel
  }, Queries.ValidateServerDirectory)
  const select = picker.getByRole('button', {
    name: 'Select folder',
    exact: true,
  })
  await select.click()
  await expect(select).toBeDisabled()
  await expect
    .poll(() =>
      picker.evaluate((element) => element.contains(document.activeElement))
    )
    .toBe(true)
  await page.keyboard.press('Control+Enter')
  await page.keyboard.press('Control+,')
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
  expect(new URL(page.url()).hash).toBe('')
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(picker).not.toBeVisible()
  await expect(opener).toBeFocused()
  await page.evaluate(() => window.directoryPickerFixture.releaseRequest?.())
  await expect(opener).toHaveAttribute('title', '/downloads')
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
})

test('resizing between sidebar and compact roots preserves focus and editor DOM', async ({
  page,
}, testInfo) => {
  const { picker, list } = await openPicker(page)
  const originalList = await list.elementHandle()
  expect(originalList).not.toBeNull()
  const locations = picker.getByRole('navigation', {
    name: 'Location',
    exact: true,
  })
  await tabTo(
    page,
    locations.getByRole('button', { name: '/archive', exact: true })
  )
  await page.setViewportSize({ width: 390, height: 620 })
  await expect(locations).not.toBeVisible()
  await expect(list).toBeFocused()
  await page.keyboard.press('Control+Enter')
  await page.keyboard.press('Control+,')
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
  expect(new URL(page.url()).hash).toBe('')
  const compact = picker.getByRole('combobox', {
    name: 'Location',
    exact: true,
  })
  await expect(compact).toBeVisible()
  await tabTo(page, compact)
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(compact).not.toBeVisible()
  await expect(list).toBeFocused()
  expect(
    await list.evaluate(
      (element, original) => element === original,
      originalList
    )
  ).toBe(true)
  await picker
    .getByRole('button', { name: 'Go to folder', exact: true })
    .click()
  const editor = picker.getByRole('textbox', { name: 'Folder path' })
  await editor.fill('/downloads/Movies')
  const originalEditor = await editor.elementHandle()
  expect(originalEditor).not.toBeNull()
  await page.setViewportSize({ width: 390, height: 620 })
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue('/downloads/Movies')
  await captureSettled(
    page,
    picker,
    testInfo.outputPath('picker-path-editor-narrow-390x620.png')
  )
  const editorBounds = await editor.boundingBox()
  expect(editorBounds?.width).toBeGreaterThanOrEqual(190)
  const toolbar = picker.getByTestId('directory-picker-toolbar')
  await expect(
    toolbar.getByRole('button', { name: 'Go', exact: true })
  ).toBeInViewport({ ratio: 1 })
  await expect(
    toolbar.getByRole('button', { name: 'Cancel', exact: true })
  ).toBeInViewport({ ratio: 1 })
  await saveJson(
    testInfo.outputPath('narrow-path-editor-layout.json'),
    editorBounds
  )
  expect(
    await editor.evaluate(
      (element, original) => element === original,
      originalEditor
    )
  ).toBe(true)
  expect(
    await list.evaluate(
      (element, original) => element === original,
      originalList
    )
  ).toBe(true)
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(editor).toBeFocused()
  expect(
    await editor.evaluate(
      (element, original) => element === original,
      originalEditor
    )
  ).toBe(true)
  await editor.press('Escape')
  await expect(list).toBeFocused()
})

test('native shifted keys and filename spaces match the typed prefix', async ({
  page,
}) => {
  await page.clock.setFixedTime('2026-09-07T00:00:00Z')
  const { picker, list } = await openPicker(page)
  const target = picker.getByTestId('directory-picker-target')
  await page.keyboard.press('Space')
  await expect(target).toHaveText('/downloads')
  await page.keyboard.press('Shift+M')
  await expect(target).toHaveText('/downloads/Movies')
  await page.evaluate(() => {
    window.directoryPickerFixture.setDirectoryChildren('/downloads', [
      '!Bang',
      'Folder 01',
      'Folder 12',
      'Movies',
      'Music',
    ])
  })
  await picker.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(picker.getByRole('option', { name: '!Bang' })).toBeVisible()
  await expect(list).toBeFocused()

  await page.clock.setFixedTime('2026-09-07T00:00:01Z')
  await page.keyboard.press('Shift+Digit1')
  await expect(target).toHaveText('/downloads/!Bang')
  await page.clock.setFixedTime('2026-09-07T00:00:02Z')
  await page.keyboard.type('folder 12')
  await expect(target).toHaveText('/downloads/Folder 12')
  await expect(
    picker.getByRole('option', { name: 'Folder 12', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await expect(list).toBeFocused()
  await expect(picker).toBeVisible()
  expect(await calls(page, Queries.ValidateServerDirectory)).toHaveLength(0)
  expect(await calls(page, Commands.CreateTask)).toHaveLength(0)
})

test('rapid typeahead after navigation starts with the new folder name', async ({
  page,
}) => {
  await page.clock.setFixedTime('2026-09-07T00:00:00Z')
  const { picker } = await openPicker(page)
  await page.keyboard.type('mov')
  await expect(
    picker.getByRole('option', { name: 'Movies', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(
    picker.getByRole('option', { name: 'Classics', exact: true })
  ).toBeVisible()
  // Fixed Date.now keeps this below the typeahead reset deadline, including on slow CI.
  await page.keyboard.type('c')
  await expect(
    picker.getByRole('option', { name: 'Classics', exact: true })
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    picker.getByText('/downloads/Movies/Classics', { exact: true })
  ).toBeVisible()
})
