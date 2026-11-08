import type { Page } from '@playwright/test'
import { expect, test, waitForEngineReady } from './fixtures/electron-app'

async function holdAnimationStartup(page: Page, webglAvailable: boolean) {
  await page.addInitScript((webglAvailable) => {
    const pending = new Map<number, IdleRequestCallback>()
    let nextId = 0
    window.requestIdleCallback = (callback) => {
      pending.set(++nextId, callback)
      document.documentElement.dataset.pendingGlassWork = String(pending.size)
      return nextId
    }
    window.cancelIdleCallback = (id) => {
      pending.delete(id)
      document.documentElement.dataset.pendingGlassWork = String(pending.size)
    }
    window.addEventListener('start-empty-animation', () => {
      for (const [id, callback] of pending) {
        pending.delete(id)
        callback({ didTimeout: false, timeRemaining: () => 50 })
      }
      document.documentElement.dataset.pendingGlassWork = String(pending.size)
    })
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args
    ) {
      if (args[0] === 'webgl2') {
        const root = document.documentElement
        root.dataset.glassContextAttempts = String(
          Number(root.dataset.glassContextAttempts ?? 0) + 1
        )
        if (!webglAvailable) return null
      }
      return Reflect.apply(getContext, this, args)
    } as typeof getContext
  }, webglAvailable)
}

test('empty downloads stay interactive before the deferred animation starts', async ({
  mainWindow: page,
}) => {
  await holdAnimationStartup(page, false)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForEngineReady(page)
  await page.getByRole('link', { name: 'Downloads', exact: true }).click()
  const root = page.locator('html')
  const gradient = page.locator('[data-slot="cubic-glass-gradient"]')
  await expect(
    page.getByText('No downloads yet', { exact: true })
  ).toBeVisible()
  await expect(gradient).toHaveAttribute('data-renderer', 'fallback')
  await expect(gradient).toHaveCSS('background-image', 'none')
  await expect(gradient).toHaveCSS('opacity', '0')
  await expect(root).toHaveAttribute('data-pending-glass-work', '1')
  await expect(root).not.toHaveAttribute('data-glass-context-attempts')

  await page
    .getByRole('button', { name: 'Search downloads', exact: true })
    .click()
  const search = page.getByRole('textbox', { name: 'Search downloads' })
  await search.fill('responsive')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('responsive')

  // Leaving before idle cancels initialization; returning can still start it.
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(gradient).toHaveCount(0)
  await expect(root).toHaveAttribute('data-pending-glass-work', '0')
  await page.evaluate(() =>
    window.dispatchEvent(new Event('start-empty-animation'))
  )
  await expect(root).not.toHaveAttribute('data-glass-context-attempts')
  await page.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect(root).toHaveAttribute('data-pending-glass-work', '1')
  await page.evaluate(() =>
    window.dispatchEvent(new Event('start-empty-animation'))
  )
  await expect(root).toHaveAttribute('data-glass-context-attempts', '1')
  await expect(gradient).toHaveAttribute('data-renderer', 'fallback')
  await expect(gradient).toHaveCSS('background-image', 'none')
  await expect(gradient).toHaveCSS('opacity', '0')
  await expect(
    page.getByText('No downloads yet', { exact: true })
  ).toBeVisible()
})

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`empty downloads reveal the first WebGL frame with reduced motion=${reducedMotion}`, async ({
    mainWindow: page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion })
    await holdAnimationStartup(page, true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForEngineReady(page)
    await page.getByRole('link', { name: 'Downloads', exact: true }).click()
    const gradient = page.locator('[data-slot="cubic-glass-gradient"]')
    await expect(page.locator('html')).toHaveAttribute(
      'data-pending-glass-work',
      '1'
    )
    await expect(gradient).toHaveCSS('background-image', 'none')
    await expect(gradient).toHaveCSS('opacity', '0')
    await expect(
      page.getByText('No downloads yet', { exact: true })
    ).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('empty-before-webgl.png'),
    })
    await gradient.evaluate((element) => {
      element.addEventListener('transitionstart', (event) => {
        if (
          event.target === element &&
          (event as TransitionEvent).propertyName === 'opacity'
        ) {
          element.setAttribute(
            'data-fade-start-opacity',
            getComputedStyle(element).opacity
          )
        }
      })
    })
    await page.evaluate(() =>
      window.dispatchEvent(new Event('start-empty-animation'))
    )
    await expect(gradient.locator('canvas')).toHaveAttribute(
      'data-ready',
      'true'
    )
    if (reducedMotion === 'no-preference') {
      await expect(gradient).toHaveAttribute('data-fade-start-opacity')
      const startOpacity = Number(
        await gradient.getAttribute('data-fade-start-opacity')
      )
      expect(startOpacity).toBeGreaterThanOrEqual(0)
      expect(startOpacity).toBeLessThan(1)
      await expect(gradient).toHaveCSS('transition-duration', '0.52s')
    } else {
      await expect(gradient).toHaveCSS('transition-duration', '0s')
      await expect(gradient).not.toHaveAttribute('data-fade-start-opacity')
    }
    await expect(gradient).toHaveCSS('opacity', '1')
    await page.screenshot({
      path: testInfo.outputPath('empty-after-webgl.png'),
    })
  })
}
