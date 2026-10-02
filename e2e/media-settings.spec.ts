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
      card.getByText(/Checks Developer ID and notarization/)
    ).toBeVisible()
    await expect(
      card.getByRole('link', { name: 'FFmpeg manual' })
    ).toHaveAttribute('href', 'https://motrix.app/manual/ffmpeg/')
    await card.screenshot({
      path: testInfo.outputPath('ffmpeg-install-consent.png'),
    })
    await card.getByRole('button', { name: 'Download and verify' }).click()
    const installAction = card.getByTestId('ffmpeg-install-action')
    await expect(installAction).toBeDisabled()
    await expect(installAction).toHaveAttribute('aria-busy', 'true')
    await expect(
      card.locator('[data-slot="ffmpeg-download-fill"]')
    ).toBeVisible({
      timeout: 120_000,
    })
    const accessibleProgress = card.getByRole('progressbar', {
      name: 'FFmpeg download progress',
    })
    await expect(accessibleProgress).toHaveCSS('position', 'absolute')
    await expect(accessibleProgress).toHaveCSS('width', '1px')
    await expect(accessibleProgress).toHaveCSS('height', '1px')
    await card.screenshot({
      path: testInfo.outputPath('ffmpeg-download-button.png'),
    })
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
    await expect(card.getByTestId('ffmpeg-install-action')).toHaveCount(0)
    await expect(
      card.getByRole('button', { name: 'Download FFmpeg' })
    ).toBeVisible()
    await expect(
      card.getByText(
        'Restart Motrix for active plugins to detect the installation.'
      )
    ).toBeVisible()
    const receipt = JSON.parse(
      await readFile(
        path.join(userDataDir, 'binaries', 'ffmpeg-verified', 'current.json'),
        'utf8'
      )
    )
    await expect(
      card.getByText(`FFmpeg ${receipt.releaseVersion.split('-motrix.')[0]}`, {
        exact: true,
      })
    ).toBeVisible({ timeout: 120_000 })
    const installedDirectory = path.join(
      userDataDir,
      'binaries',
      'ffmpeg-verified',
      'releases',
      `${receipt.manifestHash}-darwin-${process.arch}`
    )
    await expect(
      card
        .getByTestId('ffmpeg-installed-directory')
        .getByTitle(installedDirectory, { exact: true })
    ).toBeVisible()
    await mainWindow.screenshot({
      path: testInfo.outputPath('verified-ffmpeg-install.png'),
    })
    await card.getByRole('button', { name: 'Show detection details' }).click()
    const managedRow = card.getByTestId('candidate-row-userData')
    const binaryPath = path.join(installedDirectory, 'ffmpeg')
    const displayedPath = managedRow.getByTitle(binaryPath, { exact: true })
    await expect(displayedPath).toBeVisible()
    await expect(managedRow.getByText('In use', { exact: true })).toBeVisible()
    await managedRow.screenshot({
      path: testInfo.outputPath('ffmpeg-resolved-path.png'),
    })
    await mainWindow.setViewportSize({ width: 600, height: 740 })
    await displayedPath.scrollIntoViewIfNeeded()
    const filenameBounds = await displayedPath.evaluate((element) => {
      const tail = element.querySelector(
        '[aria-hidden="true"]:last-child > span'
      )
      const textNode = tail?.firstChild
      if (!textNode) throw new Error('Path suffix was not rendered')
      const range = document.createRange()
      range.setStart(
        textNode,
        (textNode.textContent?.length ?? 0) - 'ffmpeg'.length
      )
      range.setEnd(textNode, textNode.textContent?.length ?? 0)
      const filename = range.getBoundingClientRect()
      const container = element.getBoundingClientRect()
      return {
        filenameLeft: filename.left,
        filenameRight: filename.right,
        containerLeft: container.left,
        containerRight: container.right,
      }
    })
    expect(filenameBounds.filenameLeft).toBeGreaterThanOrEqual(
      filenameBounds.containerLeft
    )
    expect(filenameBounds.filenameRight).toBeLessThanOrEqual(
      filenameBounds.containerRight + 1
    )
    await managedRow.screenshot({
      path: testInfo.outputPath('ffmpeg-resolved-path-narrow.png'),
    })
  })
  test('shows detection status and saves a manual path', async ({
    mainWindow,
  }, testInfo) => {
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
    const envRow = detectionCard.getByTestId('candidate-row-env')
    for (const width of [1000, 600]) {
      await mainWindow.setViewportSize({ width, height: 740 })
      await envRow.scrollIntoViewIfNeeded()
      const bounds = await envRow.evaluate((row) => {
        const [source, location, state] = Array.from(row.children)
        const sourceRect = source.getBoundingClientRect()
        const locationRect = location.getBoundingClientRect()
        const stateRect = state.getBoundingClientRect()
        const textRange = document.createRange()
        textRange.selectNodeContents(source)
        const sourceText = textRange.getBoundingClientRect()
        return {
          sourceRight: sourceRect.right,
          sourceTextRight: sourceText.right,
          locationLeft: locationRect.left,
          locationRight: locationRect.right,
          stateLeft: stateRect.left,
          sourceCenter: (sourceRect.top + sourceRect.bottom) / 2,
          locationCenter: (locationRect.top + locationRect.bottom) / 2,
          stateCenter: (stateRect.top + stateRect.bottom) / 2,
        }
      })
      expect(bounds.sourceTextRight).toBeLessThanOrEqual(bounds.sourceRight + 1)
      expect(bounds.locationLeft - bounds.sourceRight).toBeGreaterThanOrEqual(
        11
      )
      expect(bounds.stateLeft - bounds.locationRight).toBeGreaterThanOrEqual(11)
      expect(
        Math.abs(bounds.sourceCenter - bounds.locationCenter)
      ).toBeLessThan(2)
      expect(Math.abs(bounds.sourceCenter - bounds.stateCenter)).toBeLessThan(2)
      await envRow.locator('..').screenshot({
        path: testInfo.outputPath(`ffmpeg-horizontal-columns-${width}.png`),
      })
    }
    await detectionCard
      .getByRole('button', { name: 'Edit custom FFmpeg path' })
      .click()
    const pathInput = mainWindow.locator(
      '[data-testid="media-binary-path-input"]'
    )
    await pathInput.fill('/tmp/custom-ffmpeg')
    await expect(pathInput).toHaveValue('/tmp/custom-ffmpeg')
    await expect(pathInput).toHaveAttribute('title', '/tmp/custom-ffmpeg')

    // 5. Save and verify that the dialog closes.
    await mainWindow.getByRole('button', { name: 'Save' }).click()
    await expect(pathInput).not.toBeVisible()
  })
})
