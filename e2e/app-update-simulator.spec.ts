import type { ElectronApplication } from '@playwright/test'
import { expect, launchMotrix, test } from './fixtures/electron-app'

test.describe('development update simulator', () => {
  test('drives the About update action through download and app quit', async ({
    userDataDir,
    rpcPort,
  }) => {
    let app: ElectronApplication | undefined
    try {
      app = await launchMotrix({
        userDataDir,
        rpcPort,
        extraEnv: { MOTRIX_UPDATE_SIMULATOR: '1' },
      })
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByText('About', { exact: true }).first().click()

      const checkButton = page.getByRole('button', {
        name: 'Check for updates',
      })
      await expect(checkButton).toBeVisible()
      const actionGroup = page.getByRole('group', { name: 'App updates' })
      await expect(actionGroup).toHaveAttribute('data-slot', 'button-group')
      expect(
        await actionGroup.evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            height: Number.parseFloat(style.height),
            radius: Number.parseFloat(style.borderTopRightRadius),
          }
        })
      ).toEqual({ height: 36, radius: 8 })
      const channel = actionGroup.getByRole('combobox', {
        name: 'Update channel',
      })
      await expect(channel).toBeVisible()
      expect(
        await channel.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).width)
        )
      ).toBe(68)
      expect(
        await channel.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).height)
        )
      ).toBe(24)
      expect(
        await actionGroup.evaluate((group) => {
          const select = group.querySelector('[data-slot="select-trigger"]')

          if (!select) {
            throw new Error('Update channel Select is missing')
          }

          const groupStyle = getComputedStyle(group)
          const selectStyle = getComputedStyle(select)
          const groupHeight = Number.parseFloat(groupStyle.height)
          const selectHeight = Number.parseFloat(selectStyle.height)
          const verticalInset = (groupHeight - selectHeight) / 2

          return {
            top: verticalInset,
            right: Number.parseFloat(groupStyle.paddingRight),
            bottom: verticalInset,
            innerRadius: Number.parseFloat(selectStyle.borderTopRightRadius),
            outerRadius: Number.parseFloat(groupStyle.borderTopRightRadius),
          }
        })
      ).toEqual({
        top: 6,
        right: 6,
        bottom: 6,
        innerRadius: 6,
        outerRadius: 8,
      })
      const channelValue = channel.locator('[data-slot="select-value"]')
      expect(
        await channelValue.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      ).toBe(true)
      await channel.click()
      await page.getByRole('option', { name: 'Beta' }).click()
      await expect(channel).toContainText('Beta')
      await expect(page.getByRole('option', { name: 'Beta' })).toBeHidden()
      await checkButton.click()
      await expect(
        page.getByRole('button', { name: 'Checking…' })
      ).toBeDisabled()
      await expect(channel).toBeDisabled()
      expect(
        await channel.evaluate((element) => getComputedStyle(element).opacity)
      ).toBe('1')

      const downloadButton = page.getByRole('button', {
        name: 'Download update',
      })
      await expect(downloadButton).toBeVisible()
      await downloadButton.click()
      const downloadingButton = page.getByRole('button', {
        name: /^Downloading… \d+%$/,
      })
      await expect(downloadingButton).toBeVisible()
      await expect(page.getByRole('progressbar')).toHaveCount(0)

      const installButton = page.getByRole('button', {
        name: 'Restart and install',
      })
      await expect(installButton).toBeVisible()
      await expect(installButton.locator('..')).toContainText('Beta')
      const closed = app.waitForEvent('close')
      await installButton.click()
      await closed
      app = undefined
    } finally {
      await app?.close().catch(() => {})
    }
  })
})
