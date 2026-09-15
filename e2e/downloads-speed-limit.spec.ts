import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { SpeedLimitSettings } from '@shared/types/settings'
import { expect, test, waitForEngineReady } from './fixtures/electron-app'
import {
  setTaskInspectorContentSize,
  updateTaskInspectorAppearance,
} from './fixtures/task-inspector-activity'

test('fresh low-speed presets match the unit system and survive unit changes', async ({
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  const binary = process.platform !== 'darwin'
  const unit = binary ? 'KiB/s' : 'KB/s'
  const alt = binary
    ? { upload: 65_536, download: 524_288 }
    : { upload: 64_000, download: 512_000 }
  const readSettings = () =>
    mainWindow.evaluate(async (channel) => {
      const settings = (await window.motrix.invoke(channel)) as {
        speedLimit: SpeedLimitSettings
      }
      return settings.speedLimit
    }, Queries.GetSettings)
  await expect.poll(readSettings).toMatchObject({
    turtle: 'off',
    base: { upload: 0, download: 0 },
    alt,
  })
  const badge = mainWindow.locator('[data-slot="downloads-speed-limit"]')
  await badge.click()
  await mainWindow
    .getByRole('menuitemradio', { name: 'Low-speed mode' })
    .click()
  await expect(mainWindow.getByRole('menu')).toHaveCount(0)
  await expect(badge).toHaveAccessibleName('Speed mode: Low speed')
  await expect(badge).toBeEnabled()
  await mainWindow
    .getByRole('heading', { name: 'All Downloads', exact: true })
    .hover()
  await badge.hover()
  const tooltip = mainWindow.getByRole('tooltip')
  await expect(tooltip).toContainText(`Upload limit: 64 ${unit}`)
  await expect(tooltip).toContainText(`Download limit: 512 ${unit}`)
  await mainWindow.screenshot({
    path: testInfo.outputPath('default-speed-limits.png'),
  })
  await mainWindow.evaluate(
    async ({ channel, units }) => {
      await window.motrix.invoke(channel, { app: { byteUnitSystem: units } })
    },
    { channel: Commands.UpdateSettings, units: binary ? 'decimal' : 'binary' }
  )
  await expect.poll(readSettings).toMatchObject({ turtle: 'on', alt })
  await mainWindow.reload({ waitUntil: 'domcontentloaded' })
  await expect.poll(readSettings).toMatchObject({ turtle: 'on', alt })
  await expect(badge).toHaveAccessibleName('Speed mode: Low speed')
})

test('Downloads speed badge changes the existing mode and preserves its limits', async ({
  electronApp,
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await setTaskInspectorContentSize(electronApp, mainWindow, 1100, 760)
  await mainWindow.evaluate(async (channel) => {
    await window.motrix.invoke(channel, {
      speedLimit: {
        turtle: 'off',
        base: { upload: 1_000_000, download: 2_000_000 },
        alt: { upload: 80_000, download: 500_000 },
        auto: {
          schedule: { enabled: false },
          adaptive: { enabled: false },
          videoApp: { enabled: false },
        },
      },
    })
  }, Commands.UpdateSettings)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(mainWindow.getByTestId('downloads-loading')).toHaveCount(0)
  const badge = mainWindow.locator('[data-slot="downloads-speed-limit"]')
  const rates = mainWindow.locator('[data-slot="downloads-transfer-rates"]')
  await expect(badge).toHaveAccessibleName('Speed mode: Standard')
  await expect(badge.locator('.lucide-rabbit')).toHaveCount(1)
  await expect(badge).toHaveCSS('height', '20px')
  await expect(rates.getByRole('term')).toHaveText([
    'Upload speed',
    'Download speed',
  ])
  const rateBox = (await rates.boundingBox())!
  const badgeBox = (await badge.boundingBox())!
  expect(rateBox.x - badgeBox.x - badgeBox.width).toBeCloseTo(8, 0)
  expect(badgeBox.y).toBeCloseTo(rateBox.y, 0)

  await badge.hover()
  await expect(mainWindow.getByRole('tooltip')).toContainText(
    'Download limit: 2 MB/s'
  )
  await mainWindow.screenshot({
    path: testInfo.outputPath('standard-mode-tooltip.png'),
  })
  await badge.click()
  const menu = mainWindow.getByRole('menu', { name: 'Speed mode' })
  await expect(menu).toHaveAttribute('data-side', 'top')
  await expect(mainWindow.getByRole('tooltip')).toHaveCount(0)
  await expect(
    menu.getByRole('menuitemradio', { name: 'Standard mode' })
  ).toHaveAttribute('aria-checked', 'true')
  await mainWindow.screenshot({
    path: testInfo.outputPath('speed-mode-menu.png'),
  })
  await menu.getByRole('menuitemradio', { name: 'Low-speed mode' }).click()
  await expect(menu).toHaveCount(0)
  await expect(badge).toHaveAccessibleName('Speed mode: Low speed')
  await expect(badge.locator('.lucide-turtle')).toHaveCount(1)
  await expect(badge).toHaveAttribute('data-reduced', 'true')
  const readSettings = () =>
    mainWindow.evaluate(async (channel) => {
      const settings = (await window.motrix.invoke(channel)) as {
        speedLimit: SpeedLimitSettings
      }
      return settings.speedLimit
    }, Queries.GetSettings)
  await expect.poll(readSettings).toMatchObject({
    turtle: 'on',
    base: { upload: 1_000_000, download: 2_000_000 },
    alt: { upload: 80_000, download: 500_000 },
  })
  await expect
    .poll(() =>
      mainWindow.evaluate(
        (channel) => window.motrix.invoke(channel),
        Queries.GetSpeedLimitState
      )
    )
    .toMatchObject({
      turtle: 'on',
      effective: { upload: 80_000, download: 500_000 },
    })

  await badge.click()
  await menu.getByRole('menuitemradio', { name: 'Automatic mode' }).click()
  await expect(badge).toHaveAccessibleName('Speed mode: Automatic')
  await expect(badge.locator('.lucide-squirrel')).toHaveCount(1)
  await expect(badge).toHaveAttribute('data-reduced', 'false')
  await expect.poll(readSettings).toMatchObject({ turtle: 'auto' })

  // Changes made in other surfaces are reflected without navigating away.
  await mainWindow.evaluate(async (channel) => {
    await window.motrix.invoke(channel, { speedLimit: { turtle: 'on' } })
  }, Commands.UpdateSettings)
  await expect(badge).toHaveAttribute('data-mode', 'on')
  await updateTaskInspectorAppearance(mainWindow, 'dark', 'zh-CN')
  await expect(badge).toHaveAccessibleName('速度模式：低速')
  await setTaskInspectorContentSize(electronApp, mainWindow, 600, 650)
  await badge.click()
  const chineseMenu = mainWindow.getByRole('menu', { name: '速度模式' })
  await expect(chineseMenu).toBeVisible()
  const narrowBox = (await badge.boundingBox())!
  expect(narrowBox.x).toBeGreaterThanOrEqual(0)
  expect(narrowBox.x + narrowBox.width).toBeLessThanOrEqual(600)
  await mainWindow.screenshot({
    path: testInfo.outputPath('compact-chinese-speed-menu.png'),
  })
  await mainWindow.keyboard.press('Escape')
  await expect(chineseMenu).toHaveCount(0)
  await expect(badge).toBeFocused()
  await badge.press('Enter')
  await chineseMenu.getByRole('menuitemradio', { name: '常规模式' }).click()
  await expect(badge).toHaveAccessibleName('速度模式：常规')
  await expect.poll(readSettings).toMatchObject({
    turtle: 'off',
    base: { upload: 1_000_000, download: 2_000_000 },
    alt: { upload: 80_000, download: 500_000 },
  })
})
