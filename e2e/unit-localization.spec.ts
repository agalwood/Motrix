import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { expect, test, waitForEngineReady } from './fixtures/electron-app'

test('offline language changes localize speed limits and preserve stored bytes', async ({
  mainWindow,
}, testInfo) => {
  await waitForEngineReady(mainWindow)
  await mainWindow.getByRole('link', { name: 'Downloads', exact: true }).click()
  await mainWindow.evaluate(async (channel) => {
    await window.motrix.invoke(channel, {
      app: { byteUnitSystem: 'binary' },
      speedLimit: {
        turtle: 'off',
        base: { upload: 1_048_576, download: 1_572_864 },
      },
    })
  }, Commands.UpdateSettings)
  const badge = mainWindow.locator('[data-slot="downloads-speed-limit"]')
  await mainWindow.context().setOffline(true)
  for (const [locale, expected] of [
    ['fr', '1,5 Mio/s'],
    ['ru', '1,5 МиБ/с'],
    ['uk', '1,5 МіБ/с'],
    ['ja', '1.5 MiB/秒'],
    ['ar', 'MiB/ث'],
    ['zh-CN', '1.5 MiB/s'],
  ]) {
    await mainWindow.evaluate(
      async ({ channel, language }) => {
        await window.motrix.invoke(channel, { app: { language } })
      },
      { channel: Commands.UpdateSettings, language: locale }
    )
    await badge.hover()
    await expect(mainWindow.locator('html')).toHaveAttribute('lang', locale)
    await expect(mainWindow.locator('html')).toHaveAttribute(
      'dir',
      locale === 'ar' ? 'rtl' : 'ltr'
    )
    await expect(mainWindow.getByRole('tooltip')).toContainText(expected)
    await expect
      .poll(() =>
        mainWindow.evaluate(
          (channel) => window.motrix.invoke(channel),
          Queries.GetSettings
        )
      )
      .toMatchObject({
        app: { byteUnitSystem: 'binary', language: locale },
        speedLimit: { base: { upload: 1_048_576, download: 1_572_864 } },
      })
    await mainWindow.screenshot({
      path: testInfo.outputPath(`${locale}-speed-limit.png`),
      animations: 'disabled',
      scale: 'css',
    })
    await mainWindow.mouse.move(0, 0)
  }
})
