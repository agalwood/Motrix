import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchMotrix, test } from './fixtures/electron-app'

const SWITCH_LABEL = 'Notify when download completes'

async function openGeneralSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  // Settings cards are clickable tiles. The "General" card's title comes
  // from settings.cards.general.title. Match the text that's also the
  // accessible heading inside the card.
  await page.getByText('General', { exact: true }).first().click()
  // Dialog opens — wait for the switch to be present before interacting.
  await expect(page.getByRole('switch', { name: SWITCH_LABEL })).toBeVisible()
}

async function openMain(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return page
}

test.describe('settings persistence', () => {
  test('reduce motion applies immediately, survives restart, and can be disabled', async ({
    userDataDir,
    rpcPort,
  }) => {
    let app = await launchMotrix({ userDataDir, rpcPort })
    try {
      let main = await openMain(app)
      await main.emulateMedia({ reducedMotion: 'no-preference' })
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main.getByText('Appearance', { exact: true }).first().click()
      const reduceMotion = main.getByRole('switch', { name: 'Reduce motion' })
      await expect(reduceMotion).not.toBeChecked()
      await reduceMotion.click()
      await expect(main.locator('html')).toHaveAttribute(
        'data-reduced-motion',
        'false'
      )
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(reduceMotion).toBeHidden()
      await expect(main.locator('html')).toHaveAttribute(
        'data-reduced-motion',
        'true'
      )

      await main.getByRole('link', { name: 'Downloads', exact: true }).click()
      const glass = main.locator('[data-slot="cubic-glass-gradient"]').first()
      await expect(glass).toBeVisible()
      await expect(glass.locator('canvas')).toHaveCSS('animation-name', 'none')
      await expect(glass).toHaveCSS('transition-duration', '0s')
      await app.close()

      app = await launchMotrix({ userDataDir, rpcPort })
      main = await openMain(app)
      await main.emulateMedia({ reducedMotion: 'no-preference' })
      await expect(main.locator('html')).toHaveAttribute(
        'data-reduced-motion',
        'true'
      )
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main.getByText('Appearance', { exact: true }).first().click()
      const restored = main.getByRole('switch', { name: 'Reduce motion' })
      await expect(restored).toBeChecked()
      await restored.click()
      await main.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(restored).toBeHidden()
      await expect(main.locator('html')).toHaveAttribute(
        'data-reduced-motion',
        'false'
      )
      await main.getByRole('link', { name: 'Downloads', exact: true }).click()
      await expect(
        main.locator('[data-slot="cubic-glass-gradient"] canvas').first()
      ).toHaveCSS('animation-name', 'cubic-glass-breathe')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('notifyOnComplete switch survives an app restart', async ({
    userDataDir,
    rpcPort,
  }) => {
    // ─── Run 1: toggle the switch and Apply ──────────────────────
    let app = await launchMotrix({ userDataDir, rpcPort })
    let main = await openMain(app)
    await openGeneralSettings(main)

    const switch1 = main.getByRole('switch', { name: SWITCH_LABEL })
    const before = await switch1.getAttribute('aria-checked')
    expect(before).not.toBeNull()

    await switch1.click()
    // Toggle is local to react-hook-form until Apply commits.
    // Waiting on aria-checked flipping confirms the click registered
    // before we click Apply.
    const expectedAfter = before === 'true' ? 'false' : 'true'
    await expect(switch1).toHaveAttribute('aria-checked', expectedAfter)

    // Apply: handler awaits transport.invoke(UpdateSettings),
    // which awaits SettingsManager.update -> writeFile.
    // Dialog closes after success → switch leaves the DOM.
    await main.getByRole('button', { name: 'Save' }).click()
    await expect(switch1).toBeHidden()

    await app.close()

    // ─── Run 2: reopen, navigate back, assert persisted state ────
    app = await launchMotrix({ userDataDir, rpcPort })
    main = await openMain(app)
    await openGeneralSettings(main)

    const switch2 = main.getByRole('switch', { name: SWITCH_LABEL })
    await expect(switch2).toHaveAttribute('aria-checked', expectedAfter)

    await app.close()
  })
})
