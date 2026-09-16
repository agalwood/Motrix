import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Commands } from '@shared/protocol/commands'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import {
  setTaskInspectorContentSize,
  updateTaskInspectorAppearance,
} from './fixtures/task-inspector-activity'

test('toolbar glass follows the saved switch and preserves dragging, search, sizing and focus', async ({
  userDataDir,
  rpcPort,
}, testInfo) => {
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: { liquidGlassEffect: true, theme: 'light', language: 'en-US' },
      tracker: { autoSync: false },
      onboarding: { disclaimerAccepted: true },
    })
  )
  const app = await launchMotrix({ userDataDir, rpcPort })
  try {
    let page = await app.firstWindow()
    await waitForEngineReady(page)
    await setTaskInspectorContentSize(app, page, 1280, 900)
    await page.getByRole('link', { name: 'Downloads', exact: true }).click()
    const toolbar = page.locator('[data-slot="downloads-toolbar"]')
    const layers = toolbar.locator('[data-slot="toolbar-glass"]')
    await expect(layers).toHaveCount(2)
    for (const layer of await layers.all()) {
      await expect(layer).toHaveAttribute('data-refraction', 'true')
      await expect(layer).toHaveCSS('pointer-events', 'none')
    }
    await expect(toolbar.getByRole('button')).toHaveCount(4)
    await page.screenshot({
      path: testInfo.outputPath('glass-standard-light.png'),
    })
    await toolbar
      .getByRole('button', { name: 'Search downloads', exact: true })
      .click()
    const input = toolbar.getByRole('textbox', { name: 'Search downloads' })
    await input.fill('glass')
    await expect(input).toBeFocused()
    const search = page.locator('[data-slot="downloads-search"]')
    await expect.poll(async () => (await search.boundingBox())!.width).toBe(230)
    // The map must track the animated search capsule, not stay a circular lens.
    await expect
      .poll(() =>
        search.locator('feImage').evaluate(async (image) => {
          const decoded = new Image()
          decoded.src = image.getAttribute('href')!
          await decoded.decode()
          return decoded.naturalWidth
        })
      )
      .toBe(228)
    await page.screenshot({
      path: testInfo.outputPath('glass-search-light.png'),
    })
    // Verify the rendered displacement, not just CSS syntax support. A
    // temporary striped backdrop exposes the rim while the center stays flat.
    await input.blur()
    await search.evaluate((element) => {
      element.style.backgroundImage =
        'repeating-linear-gradient(0deg, white 0px 4px, black 4px 8px)'
    })
    const glassSearch = search.locator('[data-slot="toolbar-glass"]')
    const glassFilter = await glassSearch.evaluate(
      (element) => element.style.backdropFilter
    )
    const refracted = await search.screenshot({
      path: testInfo.outputPath('rim-refraction.png'),
    })
    await glassSearch.evaluate((element) => {
      element.style.backdropFilter = 'blur(2px) saturate(1.08)'
    })
    const frosted = await search.screenshot({
      path: testInfo.outputPath('rim-frost.png'),
    })
    const difference = await page.evaluate(
      async ([before, after]) => {
        const read = async (source: string) => {
          const image = new Image()
          image.src = `data:image/png;base64,${source}`
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const context = canvas.getContext('2d')!
          context.drawImage(image, 0, 0)
          return context.getImageData(0, 0, canvas.width, canvas.height)
        }
        const a = await read(before)
        const b = await read(after)
        let rim = 0
        let center = 0
        // Avoid controls and rounded corners; inspect the central 80px span.
        for (let x = 70; x < 150; x++) {
          for (let y = 2; y < a.height - 2; y++) {
            const index = (y * a.width + x) * 4
            if (Math.abs(a.data[index] - b.data[index]) <= 5) continue
            if (y < 7 || y >= a.height - 7) rim++
            else if (y >= 12 && y < a.height - 12) center++
          }
        }
        return { rim, center }
      },
      [refracted.toString('base64'), frosted.toString('base64')]
    )
    expect(difference.rim).toBeGreaterThan(10)
    expect(difference.center).toBe(0)
    await glassSearch.evaluate((element, filter) => {
      element.style.backdropFilter = filter
    }, glassFilter)
    await search.evaluate((element) => {
      element.style.backgroundImage = ''
    })
    await page
      .getByRole('button', { name: 'Toggle sidebar', exact: true })
      .click()
    await expect(toolbar).toHaveAttribute('data-density', 'compact')
    await expect.poll(async () => (await search.boundingBox())!.height).toBe(30)
    // Blank toolbar space must reach a window drag region, while the two
    // control capsules remain clickable after collapsing the sidebar.
    const blankSpace = await toolbar.evaluate((element) => {
      const toolbarBounds = element.getBoundingClientRect()
      const controls = element
        .querySelector('[data-slot="downloads-action-group"]')!
        .getBoundingClientRect()
      return {
        width: controls.left - toolbarBounds.left,
        regions: document
          .elementsFromPoint(
            (toolbarBounds.left + controls.left) / 2,
            toolbarBounds.top + toolbarBounds.height / 2
          )
          .map((node) =>
            getComputedStyle(node).getPropertyValue('-webkit-app-region')
          ),
      }
    })
    expect(blankSpace.width).toBeGreaterThan(100)
    expect(blankSpace.regions).toContain('drag')
    expect(blankSpace.regions).not.toContain('no-drag')
    await expect(
      toolbar.locator('[data-slot="downloads-action-group"]')
    ).toHaveCSS('-webkit-app-region', 'no-drag')
    await expect(search).toHaveCSS('-webkit-app-region', 'no-drag')
    await input.click()
    await page.emulateMedia({ contrast: 'more' })
    await expect(layers).toHaveCount(0)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('glass')
    await page.emulateMedia({ contrast: 'no-preference' })
    await expect(layers).toHaveCount(2)
    await expect(input).toBeFocused()
    await page.screenshot({
      path: testInfo.outputPath('glass-compact-light.png'),
    })
    await updateTaskInspectorAppearance(page, 'dark', 'en-US')
    await expect(page.locator('[data-slot="toolbar-glass"]')).toHaveCount(2)
    await page.screenshot({
      path: testInfo.outputPath('glass-compact-dark.png'),
    })

    // macOS recreates its native window for this setting. Other hosts update
    // the same renderer through the sanitized preference event.
    const replacement =
      process.platform === 'darwin'
        ? app.waitForEvent('window', async (candidate) => {
            // Ignore the add-task window that may be prewarmed concurrently.
            await candidate.waitForLoadState('domcontentloaded')
            return new URL(candidate.url()).searchParams.get('w') === 'main'
          })
        : null
    await page.evaluate(async (command) => {
      const api = (
        window as unknown as {
          motrix: {
            invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).motrix
      await api.invoke(command, { app: { liquidGlassEffect: false } })
    }, Commands.UpdateSettings)
    if (replacement) {
      page = await replacement
      await page.waitForLoadState('domcontentloaded')
      await waitForEngineReady(page)
      if (
        (await page
          .locator('[data-slot="sidebar-wrapper"]')
          .getAttribute('data-state')) === 'collapsed'
      ) {
        await page
          .getByRole('button', { name: 'Toggle sidebar', exact: true })
          .click()
      }
      await page.getByRole('link', { name: 'Downloads', exact: true }).click()
    }
    await expect(page.locator('[data-slot="downloads-toolbar"]')).toBeVisible()
    await expect(page.locator('[data-slot="toolbar-glass"]')).toHaveCount(0)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-slot="downloads-toolbar"]')).toBeVisible()
    await expect(page.locator('[data-slot="toolbar-glass"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
