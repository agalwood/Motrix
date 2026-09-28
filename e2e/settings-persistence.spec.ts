import type { ElectronApplication, Page } from '@playwright/test'
import {
  expect,
  findAddTaskWindow,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

const NOTIFICATION_LABEL = 'Download completed'

async function chooseNotification(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  await expect(page.getByRole('combobox', { name: label })).toHaveText(option)
  await expect(page.getByRole('option')).toHaveCount(0)
}

async function openGeneralSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  // Settings cards are clickable tiles. The "General" card's title comes
  // from settings.cards.general.title. Match the text that's also the
  // accessible heading inside the card.
  await page.getByText('General', { exact: true }).first().click()
  // Wait for the authoritative settings baseline before editing.
  await expect(
    page.getByRole('combobox', { name: NOTIFICATION_LABEL })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Save', exact: true })
  ).toBeEnabled()
}

async function openMain(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return page
}

test.describe('settings persistence', () => {
  test('desktop notification choices filter existing history, refresh badges, and survive restart', async ({
    userDataDir,
    rpcPort,
    httpFixture,
  }, testInfo) => {
    let app = await launchMotrix({ userDataDir, rpcPort })
    try {
      let main = await openMain(app)
      await waitForEngineReady(main)
      await main.getByRole('button', { name: 'New task' }).click()
      const addTask = await findAddTaskWindow(app)
      await addTask
        .getByRole('textbox', { name: 'URLs' })
        .fill(httpFixture.fileUrl)
      await addTask.getByRole('button', { name: 'Download' }).click()
      const badge = main.getByTestId('notification-badge')
      await expect(badge).toHaveText('1', { timeout: 20_000 })
      // Task creation also queues navigation to its inspector. Let that
      // navigation settle before opening a settings dialog on another route.
      await expect(
        main.getByRole('dialog', { name: 'Task Inspector' })
      ).toBeVisible()

      await openGeneralSettings(main)
      await chooseNotification(
        main,
        'Download completed',
        'System notifications'
      )
      await main.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(badge).toHaveText('1')
      await openGeneralSettings(main)
      await expect(
        main.getByRole('combobox', { name: 'Download completed' })
      ).toHaveText('Both')
      await chooseNotification(
        main,
        'Download completed',
        'System notifications'
      )
      await chooseNotification(main, 'Download failed', 'System notifications')
      await main.getByRole('combobox', { name: 'Unread badge' }).click()
      await main.getByRole('option', { name: 'Dot', exact: true }).click()
      await main.screenshot({
        path: testInfo.outputPath('notification-preferences.png'),
      })
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(badge).toHaveCount(0)
      await expect(main.getByTestId('notification-badge-dot')).toHaveCount(0)
      await main
        .getByRole('link', { name: 'Notifications', exact: true })
        .click()
      await expect(
        main.getByText('No notifications', { exact: true })
      ).toBeVisible()

      await openGeneralSettings(main)
      await chooseNotification(main, 'Download completed', 'Both')
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(main.getByTestId('notification-badge-dot')).toBeVisible()
      await expect(main.getByTestId('notification-badge-dot')).toHaveAttribute(
        'aria-label',
        'Unread notifications'
      )
      await expect(badge).toHaveCount(0)
      await main.screenshot({
        path: testInfo.outputPath('notification-dot.png'),
      })
      await main.getByRole('button', { name: 'Toggle sidebar' }).click()
      // The desktop sidebar slides off-canvas rather than becoming an icon rail.
      await expect(
        main.getByTestId('notification-badge-dot')
      ).not.toBeInViewport()
      await main.screenshot({
        path: testInfo.outputPath('notification-dot-collapsed.png'),
      })
      await main.getByRole('button', { name: 'Toggle sidebar' }).click()
      await expect(main.getByTestId('notification-badge-dot')).toBeInViewport()

      await openGeneralSettings(main)
      await main.getByRole('combobox', { name: 'Unread badge' }).click()
      await main.getByRole('option', { name: 'Hidden', exact: true }).click()
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(main.getByTestId('notification-badge-dot')).toHaveCount(0)
      await app.close()

      app = await launchMotrix({ userDataDir, rpcPort })
      main = await openMain(app)
      await openGeneralSettings(main)
      await expect(
        main.getByRole('combobox', { name: 'Download completed' })
      ).toHaveText('Both')
      await expect(
        main.getByRole('combobox', { name: 'Download failed' })
      ).toHaveText('System notifications')
      await expect(
        main.getByRole('combobox', { name: 'Unread badge' })
      ).toHaveText('Hidden')
      await main.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(main.getByTestId('notification-badge')).toHaveCount(0)
      await expect(main.getByTestId('notification-badge-dot')).toHaveCount(0)
      await main
        .getByRole('link', { name: 'Notifications', exact: true })
        .click()
      await expect(
        main.getByText('test.bin finished downloading', { exact: true })
      ).toBeVisible()
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('task file deletion defaults to trash and persists an explicit permanent choice', async ({
    userDataDir,
    rpcPort,
  }, testInfo) => {
    let app = await launchMotrix({ userDataDir, rpcPort })
    const openDownloadsSettings = async () => {
      const main = await openMain(app)
      await waitForEngineReady(main)
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main
        .getByRole('button', {
          name: /Concurrency, bandwidth limits, network reliability/,
        })
        .click()
      return main
    }
    try {
      let main = await openDownloadsSettings()
      const deletion = main.getByRole('combobox', {
        name: 'When deleting task files',
      })
      await expect(deletion).toHaveText('Move to trash')
      await deletion.click()
      await main.getByRole('option', { name: 'Delete permanently' }).click()
      await expect(
        main.getByText('Deleted files cannot be restored from the trash.')
      ).toBeVisible()
      await main.screenshot({
        path: testInfo.outputPath('file-deletion-settings.png'),
      })
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(deletion).toBeHidden()
      await app.close()

      app = await launchMotrix({ userDataDir, rpcPort })
      main = await openDownloadsSettings()
      const restored = main.getByRole('combobox', {
        name: 'When deleting task files',
      })
      await expect(restored).toHaveText('Delete permanently')
      await restored.click()
      await main.getByRole('option', { name: 'Move to trash' }).click()
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(restored).toBeHidden()
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('magnet selection timeout is opt-in and persists its waiting time', async ({
    userDataDir,
    rpcPort,
  }) => {
    let app = await launchMotrix({ userDataDir, rpcPort })
    const openBitTorrentSettings = async () => {
      const main = await openMain(app)
      await expect(() => waitForEngineReady(main)).toPass({ timeout: 15000 })
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main.getByText('BitTorrent', { exact: true }).first().click()
      await expect(
        main.getByRole('button', { name: 'Save', exact: true })
      ).toBeEnabled()
      return main
    }
    try {
      let main = await openBitTorrentSettings()
      const toggle = main.getByRole('switch', {
        name: 'Download all if no selection is made',
      })
      await expect(toggle).not.toBeChecked()
      await toggle.click()
      const timeout = main.getByRole('spinbutton', {
        name: 'Time to choose files (s)',
      })
      await expect(timeout).toHaveValue('60')
      await timeout.fill('120')
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(toggle).toBeHidden()
      await app.close()
      app = await launchMotrix({ userDataDir, rpcPort })
      main = await openBitTorrentSettings()
      await expect(
        main.getByRole('switch', {
          name: 'Download all if no selection is made',
        })
      ).toBeChecked()
      await expect(
        main.getByRole('spinbutton', {
          name: 'Time to choose files (s)',
        })
      ).toHaveValue('120')
    } finally {
      await app.close()
    }
  })

  test('reduce motion applies immediately, survives restart, and can be disabled', async ({
    userDataDir,
    rpcPort,
  }) => {
    let app = await launchMotrix({ userDataDir, rpcPort })
    try {
      let main = await openMain(app)
      await main.emulateMedia({ reducedMotion: 'no-preference' })
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main.getByText('Appearance', { exact: true }).first().click()
      const reduceMotion = main.getByRole('switch', { name: 'Reduce motion' })
      await expect(reduceMotion).not.toBeChecked()
      await reduceMotion.click()
      await expect(main.locator('html')).toHaveAttribute(
        'data-reduced-motion',
        'false'
      )
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(reduceMotion).toBeHidden()
      await expect(main.locator('html')).toHaveAttribute(
        'data-reduced-motion',
        'true'
      )

      await main.getByRole('link', { name: 'Downloads', exact: true }).click()
      const glass = main.locator('[data-slot="cubic-glass-gradient"]').first()
      await expect(glass).toBeVisible()
      await expect(glass.locator('canvas')).toHaveCSS('animation-name', 'none')
      await expect(glass).toHaveCSS('transition-duration', '0s')
      await app.close()

      app = await launchMotrix({ userDataDir, rpcPort })
      main = await openMain(app)
      await main.emulateMedia({ reducedMotion: 'no-preference' })
      await expect(main.locator('html')).toHaveAttribute(
        'data-reduced-motion',
        'true'
      )
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main.getByText('Appearance', { exact: true }).first().click()
      const restored = main.getByRole('switch', { name: 'Reduce motion' })
      await expect(restored).toBeChecked()
      await restored.click()
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(restored).toBeHidden()
      await expect(main.locator('html')).toHaveAttribute(
        'data-reduced-motion',
        'false'
      )
      await main.getByRole('link', { name: 'Downloads', exact: true }).click()
      await expect(
        main.locator('[data-slot="cubic-glass-gradient"] canvas').first()
      ).toHaveCSS('animation-name', 'cubic-glass-breathe')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('notification channel selection survives an app restart', async ({
    userDataDir,
    rpcPort,
  }) => {
    let app = await launchMotrix({ userDataDir, rpcPort })
    try {
      let main = await openMain(app)
      await openGeneralSettings(main)
      await chooseNotification(main, NOTIFICATION_LABEL, 'Off')
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(
        main.getByRole('combobox', { name: NOTIFICATION_LABEL })
      ).toBeHidden()
      await app.close()
      app = await launchMotrix({ userDataDir, rpcPort })
      main = await openMain(app)
      await openGeneralSettings(main)
      await expect(
        main.getByRole('combobox', { name: NOTIFICATION_LABEL })
      ).toHaveText('Off')
    } finally {
      await app.close().catch(() => {})
    }
  })
})

test('sidebar glass color previews, cancels, and survives restart after save', async ({
  userDataDir,
  rpcPort,
}, testInfo) => {
  let app = await launchMotrix({ userDataDir, rpcPort })
  const openAppearance = async (main: Page) => {
    await main.getByRole('link', { name: 'Settings', exact: true }).click()
    await main.getByText('Appearance', { exact: true }).first().click()
    await expect(main.getByRole('radio', { name: 'Gray' })).toBeVisible()
  }
  try {
    let main = await openMain(app)
    await openAppearance(main)
    await expect(main.getByRole('radio', { name: 'Cyan' })).toBeChecked()
    await main.getByRole('radio', { name: 'Gray' }).check()
    await expect(main.locator('html')).toHaveAttribute(
      'data-sidebar-color',
      'gray'
    )
    await main.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(main.locator('html')).toHaveAttribute(
      'data-sidebar-color',
      'cyan'
    )
    await openAppearance(main)
    await main.getByRole('radio', { name: 'Violet' }).check()
    const swatch = main.locator('.sidebar-color-swatch[data-color="violet"]')
    await expect(swatch).toHaveCSS('width', '24px')
    await expect(swatch).toHaveCSS('height', '24px')
    await main.getByRole('radio', { name: 'Violet' }).hover()
    await expect(
      main
        .locator('.sidebar-color-picker label')
        .filter({ has: main.getByRole('radio', { name: 'Violet' }) })
        .locator('span')
        .last()
    ).toHaveCSS('opacity', '1')
    await main.screenshot({
      path: testInfo.outputPath('sidebar-color-selected.png'),
    })
    await main.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(main.getByRole('radio', { name: 'Violet' })).toBeHidden()
    await expect(main.locator('html')).toHaveAttribute(
      'data-sidebar-color',
      'violet'
    )
    await app.close()
    app = await launchMotrix({ userDataDir, rpcPort })
    main = await openMain(app)
    await expect(main.locator('html')).toHaveAttribute(
      'data-sidebar-color',
      'violet'
    )
    await openAppearance(main)
    await expect(main.getByRole('radio', { name: 'Violet' })).toBeChecked()
    await main.getByRole('radio', { name: 'Auto' }).check()
    await main.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(main.getByRole('radio', { name: 'Auto' })).toBeHidden()
    await app.close()
    app = await launchMotrix({ userDataDir, rpcPort })
    main = await openMain(app)
    await openAppearance(main)
    await expect(main.getByRole('radio', { name: 'Auto' })).toBeChecked()
  } finally {
    await app.close().catch(() => {})
  }
})
