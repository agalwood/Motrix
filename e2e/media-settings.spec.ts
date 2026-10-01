import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from './fixtures/electron-app'

test.describe('media settings', () => {
  test('downloads, verifies and installs the public FFmpeg release through the desktop UI', async ({
    mainWindow,
    userDataDir,
  }, testInfo) => {
    test.skip(
      process.env.MOTRIX_FFMPEG_PUBLIC_RELEASE_TEST !== '1' ||
        process.platform !== 'darwin',
      'Explicit macOS-only public Release acceptance'
    )
    test.setTimeout(600_000)
    await mainWindow
      .getByRole('link', { name: 'Settings', exact: true })
      .click()
    await mainWindow.getByText('Integration', { exact: true }).first().click()
    const card = mainWindow.getByTestId('media-detection-card')
    await card.scrollIntoViewIfNeeded()
    await card.getByRole('button', { name: 'Download FFmpeg' }).click()
    await expect(
      card.getByText(/Apple’s online notarization ticket/)
    ).toBeVisible()
    await card.getByRole('button', { name: 'Download and verify' }).click()
    await expect(
      card.getByRole('button', { name: 'Verifying…' })
    ).toBeDisabled()
    const terminalStatus = card.getByRole('status').filter({
      hasText: /Verified and installed\.|Download or verification failed/,
    })
    await expect(terminalStatus).toBeVisible({ timeout: 580_000 })
    if (
      !(await terminalStatus.textContent())?.includes('Verified and installed.')
    ) {
      await mainWindow.screenshot({
        path: testInfo.outputPath('ffmpeg-failed.png'),
      })
    }
    expect(await terminalStatus.textContent()).toContain(
      'Verified and installed.'
    )
    await expect(
      card.getByText(
        'Restart Motrix for active plugins to detect the installation.'
      )
    ).toBeVisible()
    const receipt = JSON.parse(
      await readFile(
        path.join(userDataDir, 'ffmpeg-verified', 'current.json'),
        'utf8'
      )
    )
    await expect(
      card.getByText(`FFmpeg ${receipt.releaseVersion.split('-motrix.')[0]}`, {
        exact: true,
      })
    ).toBeVisible({ timeout: 120_000 })
    await expect(
      card.getByText(
        new RegExp(`${receipt.manifestHash}-darwin-${process.arch}`)
      )
    ).toBeVisible()
    await mainWindow.screenshot({
      path: testInfo.outputPath('verified-ffmpeg-install.png'),
    })
  })
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

    // 4. Open the manual candidate editor and change the binary path.
    await detectionCard
      .getByRole('button', { name: 'Show detection details' })
      .click()
    await detectionCard
      .getByRole('button', { name: 'Edit custom FFmpeg path' })
      .click()
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
