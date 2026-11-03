import type { Page } from '@playwright/test'
import { expect, test, waitForQueryHandlers } from './fixtures/electron-app'

async function dispatchTitlebarDrag(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number }
): Promise<void> {
  await page.evaluate(
    ({ start, end }) => {
      const target = document.querySelector('.window-chrome')
      if (!target) throw new Error('Window chrome is unavailable')

      const event = (type: string, button: number, buttons: number) =>
        new MouseEvent(type, {
          bubbles: true,
          button,
          buttons,
          clientX: 12,
          clientY: 12,
          screenX: type === 'mousedown' ? start.x : end.x,
          screenY: type === 'mousedown' ? start.y : end.y,
        })

      target.dispatchEvent(event('mousedown', 0, 1))
      target.dispatchEvent(event('mousemove', -1, 1))
      target.dispatchEvent(event('mouseup', 0, 0))
    },
    { start, end }
  )
}

test('controlled macOS window dragging remains repeatable', async ({
  electronApp,
  mainWindow,
}) => {
  const fallback = await mainWindow.evaluate(
    () => window.motrix.usesWindowDragFallback
  )
  test.skip(!fallback, 'Requires the macOS 27.2+ drag fallback')

  await waitForQueryHandlers(mainWindow)
  const main = await electronApp.browserWindow(mainWindow)
  const initial = await main.evaluate((win) => win.getBounds())

  await dispatchTitlebarDrag(mainWindow, { x: 500, y: 300 }, { x: 560, y: 340 })
  await expect
    .poll(() => main.evaluate((win) => win.getBounds()))
    .toMatchObject({
      x: initial.x + 60,
      y: initial.y + 40,
      width: initial.width,
      height: initial.height,
    })

  await dispatchTitlebarDrag(mainWindow, { x: 800, y: 500 }, { x: 850, y: 540 })
  await expect
    .poll(() => main.evaluate((win) => win.getBounds()))
    .toMatchObject({
      x: initial.x + 110,
      y: initial.y + 80,
      width: initial.width,
      height: initial.height,
    })
})
