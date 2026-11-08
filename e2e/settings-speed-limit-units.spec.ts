import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import { expect, test, waitForEngineReady } from './fixtures/electron-app'

for (const system of ['decimal', 'binary'] as const) {
  test(`speed limit units preserve bytes and save fractional ${system} limits`, async ({
    mainWindow: page,
  }, testInfo) => {
    await waitForEngineReady(page)
    const kilo = system === 'binary' ? 1024 : 1000
    const mega = kilo ** 2
    const megaUnit = system === 'binary' ? 'MiB/s' : 'MB/s'
    const original = 2 * mega + 1
    await page.evaluate(
      async ({ channel, units, download }) => {
        await window.motrix.invoke(channel, {
          app: { byteUnitSystem: units },
          speedLimit: {
            base: { download, upload: 0 },
            alt: { download: 0 },
          },
        })
      },
      { channel: Commands.UpdateSettings, units: system, download: original }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    const read = () =>
      page.evaluate(
        async (channel) => (await window.motrix.invoke(channel)) as AppSettings,
        Queries.GetSettings
      )
    const before = await read()
    const open = async () => {
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: /^downloads Downloads / }).click()
      await expect(
        page.getByRole('button', { name: 'Save', exact: true })
      ).toBeEnabled()
    }
    const chooseMega = async (field: string) => {
      const select = page.getByRole('combobox', { name: `Unit for ${field}` })
      await select.click()
      await page.getByRole('option', { name: megaUnit, exact: true }).click()
      await expect(select).toHaveText(megaUnit)
      await expect(page.getByRole('listbox')).toHaveCount(0)
      const text = select.locator('[data-slot="select-value"]')
      expect(
        await text.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      ).toBe(true)
    }
    const download = page.getByRole('spinbutton', {
      name: 'Download — Standard limits',
    })
    const upload = page.getByRole('spinbutton', {
      name: 'Upload — Standard limits',
    })
    const lowDownload = page.getByRole('spinbutton', {
      name: 'Download — Low speed limits',
    })

    await open()
    await chooseMega('Download (Standard limits)')
    await expect(download).toHaveValue('2.000001')
    await chooseMega('Upload (Standard limits)')
    await expect(upload).toHaveValue('')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await read()).speedLimit).toEqual(before.speedLimit)
    expect((await read()).app.speedLimitUnits).toMatchObject({
      baseDownload: 'mega',
      baseUpload: 'mega',
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await open()
    await expect(
      page.getByRole('combobox', { name: 'Unit for Upload (Standard limits)' })
    ).toHaveText(megaUnit)
    await expect(
      page.getByRole('combobox', {
        name: 'Unit for Download (Standard limits)',
      })
    ).toHaveText(megaUnit)
    await expect(download).toHaveValue('2.000001')
    await expect(upload).toHaveValue('')
    await expect(upload).toHaveAttribute('placeholder', 'Unlimited')
    await upload.pressSequentially('1.1')
    await expect(upload).toHaveValue('1.1')
    await chooseMega('Download (Low speed limits)')
    await expect(lowDownload).toHaveAttribute('placeholder', 'Use standard')
    await lowDownload.fill('2.5')
    const lowGroup = lowDownload.locator(
      'xpath=ancestor::*[@data-slot="button-group"]'
    )
    await lowGroup.getByRole('button', { name: 'Use standard limit' }).click()
    await expect(lowGroup.getByRole('combobox')).toHaveText(megaUnit)
    await expect(lowDownload).toHaveValue('')
    await page
      .getByRole('heading', { name: 'Speed limits', exact: true })
      .hover()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath(`speed-limit-units-${system}.png`),
    })
    expect((await read()).speedLimit).toEqual(before.speedLimit)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const saved = await read()
    expect(saved.speedLimit.base).toEqual({
      download: original,
      upload: Math.round(1.1 * mega),
    })
    expect(saved.speedLimit.alt.download).toBe(0)
    expect(saved.app.speedLimitUnits.altDownload).toBe('mega')
    expect(saved.speedLimit.alt.upload).toBe(before.speedLimit.alt.upload)

    await open()
    await expect(lowGroup.getByRole('combobox')).toHaveText(megaUnit)
    await expect(lowDownload).toHaveValue('')
    await expect(upload).toHaveValue('1.1')
    await page
      .getByRole('combobox', { name: 'Unit for Upload (Standard limits)' })
      .click()
    await page
      .getByRole('option', {
        name: system === 'binary' ? 'KiB/s' : 'KB/s',
        exact: true,
      })
      .click()
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await upload.fill('42')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await read()).speedLimit).toEqual(saved.speedLimit)
    expect((await read()).app.speedLimitUnits).toEqual(
      saved.app.speedLimitUnits
    )
    await open()
    await expect(
      page.getByRole('combobox', { name: 'Unit for Upload (Standard limits)' })
    ).toHaveText(megaUnit)
    await expect(upload).toHaveValue('1.1')
  })
}
