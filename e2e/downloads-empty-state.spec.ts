import { expect, test, waitForEngineReady } from './fixtures/electron-app'

test('empty downloads stay interactive before the deferred animation starts', async ({
  mainWindow: page,
}) => {
  await page.addInitScript(() => {
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
        return null
      }
      return Reflect.apply(getContext, this, args)
    } as typeof getContext
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForEngineReady(page)
  await page.getByRole('link', { name: 'Downloads', exact: true }).click()
  const root = page.locator('html')
  const gradient = page.locator('[data-slot="cubic-glass-gradient"]')
  await expect(
    page.getByText('No downloads yet', { exact: true })
  ).toBeVisible()
  await expect(gradient).toHaveAttribute('data-renderer', 'fallback')
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
  await expect(
    page.getByText('No downloads yet', { exact: true })
  ).toBeVisible()
})
