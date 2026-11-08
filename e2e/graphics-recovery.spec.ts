import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import { Queries } from '../src/shared/protocol/queries'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'

test('graphics failures recover on the next launch and acceleration stays off until the user enables it', async ({
  userDataDir,
  rpcPort,
}, testInfo) => {
  test.setTimeout(90_000)
  const settingsPath = path.join(userDataDir, 'settings.json')
  const recoveryPath = path.join(userDataDir, 'graphics-recovery.json')
  const readSettings = async () =>
    JSON.parse(await readFile(settingsPath, 'utf8'))
  await writeFile(
    settingsPath,
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: { language: 'zh-CN', autofillClipboardLinks: false },
      tracker: { autoSync: false },
      nat: { enabled: false },
      onboarding: { disclaimerAccepted: true },
    })
  )
  let electron = await launchMotrix({ userDataDir, rpcPort })
  try {
    let page = await electron.firstWindow()
    await waitForEngineReady(page)
    const initialAcceleration = await electron.evaluate(({ app }) =>
      app.isHardwareAccelerationEnabled()
    )
    expect((await readSettings()).app.hardwareAcceleration).toBe(true)

    // Inject Electron's documented process-failure event, not a synthetic
    // settings file. This tests production listeners and persistence without
    // requiring a defective GPU driver on the test machine.
    await electron.evaluate(({ app }) => {
      for (let i = 0; i < 3; i++) {
        app.emit(
          'child-process-gone',
          {},
          { type: 'GPU', reason: 'crashed', exitCode: 139 }
        )
      }
    })
    expect(
      JSON.parse(await readFile(recoveryPath, 'utf8')).recoveryPending
    ).toBe(true)
    expect((await readSettings()).app.hardwareAcceleration).toBe(true)
    expect(
      await electron.evaluate(({ app }) => app.isHardwareAccelerationEnabled())
    ).toBe(initialAcceleration)
    expect(
      await page.evaluate(
        (query) => window.motrix.invoke(query),
        Queries.GetGraphicsRecoveryNotice
      )
    ).toBeNull()
    await electron.close()

    electron = await launchMotrix({ userDataDir, rpcPort })
    page = await electron.firstWindow()
    await waitForEngineReady(page)
    expect((await readSettings()).app.hardwareAcceleration).toBe(false)
    expect(
      await electron.evaluate(({ app }) => app.isHardwareAccelerationEnabled())
    ).toBe(false)
    const title = page.getByText('已关闭硬件加速', { exact: true })
    await expect(title).toBeVisible()
    await expect(
      page.getByText(
        '由于画面显示连续出错，Motrix 已关闭硬件加速，避免再次闪退。你可以在“设置 → 外观”中重新开启，重启后生效。',
        { exact: true }
      )
    ).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('graphics-recovery-toast.png'),
    })
    // Base UI announces high-priority toasts in a separate live region and
    // keeps their visible dialog aria-hidden until focused.
    await page
      .locator('[role="dialog"], [role="alertdialog"]')
      .filter({ has: title })
      .getByRole('button', { name: '关闭', exact: true, includeHidden: true })
      .click()
    await expect
      .poll(() =>
        page.evaluate(
          (query) => window.motrix.invoke(query),
          Queries.GetGraphicsRecoveryNotice
        )
      )
      .toBeNull()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForEngineReady(page)
    await expect(page.getByText('已关闭硬件加速', { exact: true })).toHaveCount(
      0
    )
    await electron.close()

    // A later ordinary launch keeps software mode after the notice was read.
    electron = await launchMotrix({ userDataDir, rpcPort })
    page = await electron.firstWindow()
    await waitForEngineReady(page)
    expect(
      await electron.evaluate(({ app }) => app.isHardwareAccelerationEnabled())
    ).toBe(false)
    await page.evaluate(() => {
      location.hash = '/settings'
    })
    await page.getByText('外观', { exact: true }).click()
    const control = page.getByRole('switch', { name: '硬件加速', exact: true })
    await expect(control).not.toBeChecked()
    await control.click()
    expect((await readSettings()).app.hardwareAcceleration).toBe(false)
    await page.screenshot({
      path: testInfo.outputPath('graphics-settings.png'),
    })
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect
      .poll(async () => (await readSettings()).app.hardwareAcceleration)
      .toBe(true)
    expect(
      await electron.evaluate(({ app }) => app.isHardwareAccelerationEnabled())
    ).toBe(false)
    await electron.close()

    electron = await launchMotrix({ userDataDir, rpcPort })
    page = await electron.firstWindow()
    await waitForEngineReady(page)
    expect((await readSettings()).app.hardwareAcceleration).toBe(true)
    expect(
      await electron.evaluate(({ app }) => app.isHardwareAccelerationEnabled())
    ).toBe(initialAcceleration)
    expect(
      await page.evaluate(
        (query) => window.motrix.invoke(query),
        Queries.GetGraphicsRecoveryNotice
      )
    ).toBeNull()
  } finally {
    await electron.close().catch(() => {})
  }
})
