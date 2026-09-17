import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import {
  setTaskInspectorContentSize,
  updateTaskInspectorAppearance,
} from './fixtures/task-inspector-activity'

test('Trackers and Plugins share expandable, keyboard-accessible panel toolbars', async ({
  userDataDir,
  rpcPort,
}, testInfo) => {
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: { liquidGlassEffect: true, theme: 'light', language: 'en-US' },
      tracker: { autoSync: false },
      onboarding: { disclaimerAccepted: true },
    })
  )
  const app = await launchMotrix({ userDataDir, rpcPort })
  try {
    const page = await app.firstWindow()
    await waitForEngineReady(page)
    await setTaskInspectorContentSize(app, page, 1100, 780)
    await page.getByRole('link', { name: 'Trackers', exact: true }).click()
    const trackers = page.getByRole('toolbar', { name: 'Trackers' })
    const trackerSearch = trackers.getByRole('button', {
      name: 'Filter by URL…',
    })
    await expect(trackers.getByRole('textbox')).toHaveCount(0)
    await trackerSearch.click()
    const trackerInput = trackers.getByRole('textbox')
    await expect(trackerInput).toBeFocused()
    await trackerInput.fill('tracker.example')
    await page.getByRole('tab', { name: /blacklist/i }).click()
    await expect(trackerInput).toHaveValue('tracker.example')
    await trackerInput.press('Escape')
    await expect(trackerInput).toHaveValue('')
    await trackerInput.press('Escape')
    await expect(trackerSearch).toBeFocused()
    await page.screenshot({
      path: testInfo.outputPath('trackers-toolbar.png'),
      animations: 'disabled',
    })

    await page.getByRole('link', { name: 'Plugins', exact: true }).click()
    const plugins = page.getByRole('toolbar', { name: 'Plugins' })
    await expect(plugins.locator('[data-slot="toolbar-glass"]')).toHaveCount(2)
    await expect(
      plugins.getByRole('button', { name: 'Add plugin' })
    ).toBeVisible()
    await expect(plugins.getByTestId('registry-refresh-btn')).toBeVisible()
    const search = plugins.getByRole('button', { name: 'Find a plugin' })
    await search.click()
    const input = plugins.getByRole('textbox', { name: 'Find a plugin' })
    await expect(input).toBeFocused()
    await input.fill('example')
    await plugins.getByRole('button', { name: 'Clear search' }).click()
    await expect(input).toBeFocused()
    await input.press('Escape')
    await expect(search).toBeFocused()
    await plugins.getByRole('button', { name: 'Add plugin' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath('plugins-toolbar-light.png'),
      animations: 'disabled',
    })
    await plugins.getByRole('link', { name: 'Diagnostics' }).click()
    await expect.poll(() => page.url()).toContain('/plugins/diagnostics')
    await page.getByRole('link', { name: 'Plugins', exact: true }).click()
    await page
      .getByRole('button', { name: 'Toggle sidebar', exact: true })
      .click()
    await expect(plugins).toHaveAttribute('data-density', 'compact')
    await search.click()
    await expect(input).toBeFocused()
    await updateTaskInspectorAppearance(page, 'dark', 'en-US')
    // The appearance helper reloads the page; reopen the ephemeral search.
    await search.click()
    await expect(input).toBeFocused()
    await page.screenshot({
      path: testInfo.outputPath('plugins-toolbar-dark-compact.png'),
      animations: 'disabled',
    })
    await page.emulateMedia({ contrast: 'more' })
    await expect(plugins.locator('[data-slot="toolbar-glass"]')).toHaveCount(0)
    await expect(input).toBeFocused()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth
    )
    expect(overflow).toBe(false)
  } finally {
    await app.close()
  }
})
