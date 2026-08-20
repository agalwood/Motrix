import { expect, test } from './fixtures/electron-app'

test.describe('media settings', () => {
  test('shows detection status and saves a manual path', async ({
    mainWindow,
  }) => {
    // 1. Open Settings page from the main sidebar.
    await mainWindow
      .getByRole('link', { name: 'Settings', exact: true })
      .click()

    // 2. Media tools live in the Integration card.
    await mainWindow.getByText('Integration', { exact: true }).first().click()

    // 3. The media section is lower in the scrollable Integration dialog.
    const detectionCard = mainWindow.locator(
      '[data-testid="media-detection-card"]'
    )
    await detectionCard.scrollIntoViewIfNeeded()
    await expect(detectionCard).toBeVisible()

    // 4. Change the binary path input.
    const pathInput = mainWindow.locator(
      '[data-testid="media-binary-path-input"]'
    )
    await pathInput.fill('/tmp/custom-ffmpeg')
    await expect(pathInput).toHaveValue('/tmp/custom-ffmpeg')

    // 5. Save and verify that the dialog closes.
    await mainWindow.getByRole('button', { name: 'Save' }).click()
    await expect(pathInput).not.toBeVisible()
  })
})
