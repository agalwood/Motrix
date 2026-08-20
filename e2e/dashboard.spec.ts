// e2e/dashboard.spec.ts
// Dashboard v1 golden-path e2e tests.
//
// Note on infrastructure gaps:
// - Test 2 (window narrow / fold behavior): requires programmatic window resize.
//   The app exposes Commands.ResizeWindow via IPC, but there is no e2e helper
//   that drives the Electron window size from outside. This test is skipped.
// - Test 3 (engine offline/recovery): requires killing and restarting the aria2
//   subprocess. No e2e helper exists for this. This test is skipped.
//   Both are documented below with test.skip.
import { expect, test } from './fixtures/electron-app'

test.describe('Dashboard v1', () => {
  test('cold launch renders seven default tile labels within 800ms', async ({
    mainWindow,
  }) => {
    // Navigate to dashboard (hash router — '#/' is the dashboard route)
    await mainWindow.waitForLoadState('domcontentloaded')

    // Wait for the window-main class to confirm the app shell is mounted
    await expect(mainWindow.locator('html')).toHaveClass(/window-main/, {
      timeout: 15_000,
    })

    // Click the Dashboard nav link to ensure we're on the dashboard route
    await mainWindow.getByRole('link', { name: 'Dashboard' }).click()

    // All seven default tile labels should appear within 800ms of navigation
    // (they are rendered synchronously on mount; data fills in async)
    await Promise.all([
      expect(
        mainWindow
          .getByTestId('dashboard-tile-engine')
          .getByText('Engine', { exact: true })
      ).toBeVisible({ timeout: 800 }),
      expect(
        mainWindow
          .getByTestId('dashboard-tile-speedLimit')
          .getByText('Speed Limit', { exact: true })
      ).toBeVisible({ timeout: 800 }),
      expect(
        mainWindow
          .getByTestId('dashboard-tile-speedUp')
          .getByText('UPLOAD', { exact: true })
      ).toBeVisible({ timeout: 800 }),
      expect(
        mainWindow
          .getByTestId('dashboard-tile-speedDown')
          .getByText('DOWNLOAD', { exact: true })
      ).toBeVisible({ timeout: 800 }),
      expect(
        mainWindow
          .getByTestId('dashboard-tile-active')
          .getByText('Active Tasks', { exact: true })
      ).toBeVisible({ timeout: 800 }),
      expect(
        mainWindow
          .getByTestId('dashboard-tile-activity')
          .getByText('Activity', { exact: true })
      ).toBeVisible({ timeout: 800 }),
      expect(
        mainWindow
          .getByTestId('dashboard-tile-transfer')
          .getByText('Transfer', { exact: true })
      ).toBeVisible({ timeout: 800 }),
    ])
  })

  test.skip('window narrows below 904px → Tasks falls beneath grid', async () => {
    // SKIPPED: No e2e helper exists to programmatically resize the Electron
    // BrowserWindow to a specific pixel width from outside the process.
    // Commands.ResizeWindow is an IPC command but it is not wired to a
    // helper that updates the window dimensions before assertion.
    // To implement: add a resizeMainWindow(page, width, height) helper in
    // e2e/helpers/ that calls electronApp.evaluate() to call win.setSize().
  })

  test.skip('engine offline → Engine card shows Disconnected; recovery restores Ready', async () => {
    // SKIPPED: No e2e helper exists to kill and restart the aria2 subprocess
    // from outside the Electron process during a test. The EngineSupervisor
    // manages aria2's lifetime; there is no IPC command that deliberately
    // stops it without a full app quit.
    // To implement: add a helper that calls electronApp.evaluate() to reach
    // into the EngineSupervisor singleton and call .kill() / .start().
    // Alternatively, send SIGKILL to the aria2 PID obtained via
    // Queries.GetEngineStatus.featureReport and wait for EngineStateChanged.
  })
})
