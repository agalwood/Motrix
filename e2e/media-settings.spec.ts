import { expect, test } from './fixtures/electron-app'

test.describe('media settings', () => {
  test('shows detection status and saves manual path with restart hint', async ({
    mainWindow,
  }) => {
    // 1. Open Settings page from the main sidebar.
    await mainWindow.getByRole('link', { name: 'Settings' }).click()

    // 2. Click the Media card. Card titles come from
    //    settings.cards.media.title — match the exact text.
    await mainWindow.getByText('Media', { exact: true }).first().click()

    // 3. Detection status card visible — at least the manual candidate
    //    row always renders (state='unconfigured' when path is empty).
    await expect(
      mainWindow.locator('[data-testid="candidate-row-manual"]')
    ).toBeVisible()

    // 4. Change the binary path input.
    const pathInput = mainWindow.locator(
      '[data-testid="media-binary-path-input"]'
    )
    await pathInput.fill('/tmp/custom-ffmpeg')
    await expect(pathInput).toHaveValue('/tmp/custom-ffmpeg')

    // 5. Click Apply.
    await mainWindow.getByRole('button', { name: 'Apply' }).click()

    // 6. Restart hint surfaces inline. Text source:
    //    settings.media.restartHint — "Saved. Restart Motrix for active
    //    plugins to detect changes."
    const hint = mainWindow.locator('[data-testid="media-restart-hint"]')
    await expect(hint).toBeVisible()
    await expect(hint).toContainText(/restart/i)
  })
})
