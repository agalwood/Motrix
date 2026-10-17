import path from 'node:path'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import { expect, test, waitForEngineReady } from './fixtures/electron-app'
import {
  setTaskInspectorContentSize,
  updateTaskInspectorAppearance,
} from './fixtures/task-inspector-activity'

test('narrow settings keep readable cards and scroll within the panel', async ({
  electronApp,
  mainWindow: page,
}) => {
  await waitForEngineReady(page)
  await page.evaluate(() => {
    localStorage.setItem('sidebar_state', 'false')
    location.hash = '/settings'
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await updateTaskInspectorAppearance(page, 'light', 'zh-CN')
  await setTaskInspectorContentSize(electronApp, page, 176, 480)
  const grid = page.locator('[data-slot="settings-grid"]')
  const cards = grid.locator('[data-slot="settings-card"]')
  await expect(cards).toHaveCount(8)
  await expect
    .poll(() =>
      grid.evaluate((element) => {
        const titles = [
          ...element.querySelectorAll<HTMLElement>('.font-semibold'),
        ]
        return {
          overflow: element.scrollWidth > element.clientWidth,
          titlesFit: titles.every(
            (title) =>
              title.offsetHeight <=
              Number.parseFloat(getComputedStyle(title).lineHeight)
          ),
          documentOverflow:
            document.documentElement.scrollHeight > window.innerHeight,
        }
      })
    )
    .toEqual({ overflow: false, titlesFit: true, documentOverflow: false })
  await cards.last().scrollIntoViewIfNeeded()
  await expect(cards.last()).toBeInViewport()
  await cards.last().click()
  await expect(
    page.getByRole('dialog', { name: '关于', exact: true })
  ).toBeVisible()
})

test('moved settings preserve draft, cancel and save behavior in the desktop host', async ({
  mainWindow: page,
  userDataDir,
}, testInfo) => {
  await waitForEngineReady(page)
  const read = () =>
    page.evaluate(
      async (channel) => (await window.motrix.invoke(channel)) as AppSettings,
      Queries.GetSettings
    )
  const before = await read()
  const open = async (card: string) => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page
      .getByRole('button', {
        name: new RegExp(`^${card.toLowerCase()} ${card} `),
      })
      .click()
    await expect(
      page.getByRole('button', { name: 'Save', exact: true })
    ).toBeEnabled()
  }
  await open('Downloads')
  await expect(
    page.getByRole('heading', { name: 'Save folders' })
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'User-Agent' })).toHaveValue(
    before.engine.userAgent
  )
  const clipboard = page.getByRole('switch', {
    name: 'Autofill links from clipboard',
  })
  await clipboard.click()
  await page
    .getByRole('spinbutton', { name: 'Upload — Standard limits' })
    .fill('123')
  expect((await read()).app.autofillClipboardLinks).toBe(
    before.app.autofillClipboardLinks
  )
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await open('Downloads')
  await expect(clipboard).toBeChecked({
    checked: before.app.autofillClipboardLinks,
  })
  await clipboard.click()
  await page
    .getByRole('spinbutton', { name: 'Upload — Standard limits' })
    .fill('123')
  await page.screenshot({
    path: testInfo.outputPath('downloads-production.png'),
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const saved = await read()
  expect(saved.app.autofillClipboardLinks).toBe(
    !before.app.autofillClipboardLinks
  )
  expect(saved.speedLimit.base.upload).toBe(
    123 * (before.app.byteUnitSystem === 'binary' ? 1024 : 1000)
  )
  expect(saved.speedLimit.base.download).toBe(before.speedLimit.base.download)
  expect(saved.app.directoryPreferences).toEqual(
    before.app.directoryPreferences
  )
  await open('BitTorrent')
  const location = page.getByRole('switch', { name: 'Show country or region' })
  await location.click()
  expect((await read()).geoip.enabled).toBe(before.geoip.enabled)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await open('BitTorrent')
  await expect(location).toBeChecked({ checked: before.geoip.enabled })
  await location.click()
  await page
    .getByRole('spinbutton', { name: 'Magnet loading timeout (s)' })
    .fill('900')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await read()).geoip.enabled).toBe(!before.geoip.enabled)
  expect((await read()).engine.magnetResolveTimeout).toBe(900)
  await open('Advanced')
  const settingsFile = page.getByRole('textbox', {
    name: 'Configuration file',
  })
  await expect(settingsFile).toHaveValue(
    path.join(userDataDir, 'settings.json')
  )
  await expect(settingsFile).toHaveAttribute('readonly')
  await expect(page.getByRole('button', { name: 'Open folder' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy path' })).toHaveCount(0)
  const retention = page.getByRole('combobox', {
    name: 'Completed recovery records',
  })
  await retention.click()
  await page.getByRole('option', { name: 'Latest records…' }).click()
  const count = page.getByRole('spinbutton', { name: 'Records to keep' })
  await count.fill('0')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Enter a number greater than 0.')).toBeVisible()
  await count.fill('731')
  await retention.click()
  await page.getByRole('option', { name: 'Do not retain' }).click()
  await retention.click()
  await page.getByRole('option', { name: 'Latest records…' }).click()
  await expect(count).toHaveValue('731')
  await page.screenshot({
    path: testInfo.outputPath('advanced-production.png'),
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Advanced', exact: true })
  ).toHaveCount(0)
  expect((await read()).engine.sqlite3HistoryLimit).toBe(731)
  await open('Advanced')
  await expect(count).toHaveValue('731')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.evaluate(
    async ({ channel, language }) => {
      await window.motrix.invoke(channel, { app: { language } })
    },
    { channel: Commands.UpdateSettings, language: 'zh-CN' }
  )
})
