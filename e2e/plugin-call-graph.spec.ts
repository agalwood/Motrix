import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, launchMotrix, test } from './fixtures/electron-app'

const COMMANDS = {
  archive: 'motrix.scraper-hook.rewriteArchive',
  resolve: 'motrix.url-resolver.resolve',
  scrape: 'motrix.scraper-hook.scrapePage',
  template: 'motrix.filename-template.applyTemplate',
  missing: 'historical.missing.run',
} as const

interface AuditRecord {
  ts: number
  type: 'command.invoke'
  caller: string
  callee: string
  commandId: string
  argsSize: number
  resultSize: number
  durMs: number
  depth: number
  ok: true
}

function successfulCall(
  ts: number,
  caller: string,
  callee: string,
  commandId: string
): AuditRecord {
  return {
    ts,
    type: 'command.invoke',
    caller,
    callee,
    commandId,
    argsSize: 24,
    resultSize: 48,
    durMs: 6,
    depth: 1,
    ok: true,
  }
}

async function seedCallGraph(userDataDir: string): Promise<void> {
  const now = Date.now()
  const records = [
    successfulCall(
      now - 5_000,
      'motrix.filename-template',
      'motrix.scraper-hook',
      COMMANDS.scrape
    ),
    successfulCall(
      now - 4_000,
      'motrix.filename-template',
      'motrix.scraper-hook',
      COMMANDS.archive
    ),
    successfulCall(
      now - 3_000,
      'motrix.scraper-hook',
      'motrix.url-resolver',
      COMMANDS.resolve
    ),
    successfulCall(
      now - 2_000,
      'motrix.url-resolver',
      'motrix.filename-template',
      COMMANDS.template
    ),
    successfulCall(
      now - 1_000,
      'motrix.filename-template',
      'historical.missing',
      COMMANDS.missing
    ),
  ]
  const auditDir = path.join(userDataDir, 'plugins', '_audit')
  await mkdir(auditDir, { recursive: true })
  await writeFile(
    path.join(auditDir, 'command-invokes.ndjson'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  )
}

async function openMain(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('html')).toHaveClass(/window-main/)
  return page
}

async function openCallGraph(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Plugins' }).click()
  await page.getByRole('link', { name: 'Diagnostics', exact: true }).click()
  await expect.poll(() => page.url()).toContain('#/plugins/diagnostics')
  await expect(
    page.getByRole('heading', {
      name: 'Diagnostics',
      exact: true,
      level: 1,
    })
  ).toBeVisible()
  await expect(
    page.getByText(
      'Inspect successful calls between plugins from the last 24 hours.'
    )
  ).toBeVisible()
  await expect(
    page.getByRole('application', {
      name: 'Plugin command relationships',
    })
  ).toBeVisible()
}

async function readToolbarGeometry(page: Page) {
  return page.evaluate(() => {
    const inset = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-inset"]'
    )
    const container = document.querySelector<HTMLElement>(
      '[data-testid="plugin-call-graph-container"]'
    )
    const toolbar = document.querySelector<HTMLElement>(
      '[data-testid="plugin-call-graph-toolbar-primary"]'
    )
    const input = toolbar?.querySelector<HTMLElement>('input')
    const inputGroup = input?.closest<HTMLElement>('[data-slot="input-group"]')
    const content = container?.parentElement
    const activePanel = container?.querySelector<HTMLElement>(
      '[role="tabpanel"]:not([hidden])'
    )
    const actions = document.querySelector<HTMLElement>(
      '[data-testid="plugin-call-graph-toolbar-actions"]'
    )
    const tabsList = actions?.querySelector<HTMLElement>('[role="tablist"]')
    const refreshButton = actions?.querySelector<HTMLElement>(
      '[data-slot="button"]'
    )
    if (
      !inset ||
      !container ||
      !toolbar ||
      !input ||
      !inputGroup ||
      !content ||
      !activePanel ||
      !actions ||
      !tabsList ||
      !refreshButton
    ) {
      return null
    }
    const insetRect = inset.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const toolbarRect = toolbar.getBoundingClientRect()
    const inputRect = input.getBoundingClientRect()
    const actionRect = actions.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const inputGroupRect = inputGroup.getBoundingClientRect()
    const tabsListRect = tabsList.getBoundingClientRect()
    const refreshButtonRect = refreshButton.getBoundingClientRect()
    return {
      containerWidth: containerRect.width,
      containerOverflow: getComputedStyle(container).overflow,
      pageOverflow: getComputedStyle(content).overflow,
      activePanelOverflow: getComputedStyle(activePanel).overflow,
      inputHeight: inputGroupRect.height,
      tabsListHeight: tabsListRect.height,
      refreshButtonHeight: refreshButtonRect.height,
      toolbarGap: Number.parseFloat(getComputedStyle(toolbar).columnGap),
      actionsGap: Number.parseFloat(getComputedStyle(actions).columnGap),
      focusRingClearance: Math.min(
        inputGroupRect.left - contentRect.left,
        contentRect.right - inputGroupRect.right,
        inputGroupRect.top - contentRect.top,
        contentRect.bottom - inputGroupRect.bottom
      ),
      sameRow:
        Math.min(inputRect.bottom, actionRect.bottom) -
          Math.max(inputRect.top, actionRect.top) >
        8,
      actionsBelow: actionRect.top >= inputRect.bottom - 1,
      actionsEndAligned: Math.abs(actionRect.right - toolbarRect.right) <= 2,
      toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth,
      contentInsideInset:
        containerRect.left >= insetRect.left - 1 &&
        containerRect.right <= insetRect.right + 1 &&
        containerRect.top >= insetRect.top - 1 &&
        containerRect.bottom <= insetRect.bottom + 1,
      noDocumentScroll:
        document.documentElement.scrollHeight <= window.innerHeight &&
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollHeight <= window.innerHeight &&
        document.body.scrollWidth <= window.innerWidth,
    }
  })
}

async function readLegendGeometry(page: Page) {
  return page
    .getByRole('group', { name: 'Call volume legend' })
    .evaluate((legend) => {
      const canvas = legend.closest<HTMLElement>('.react-flow')
      if (!canvas) return null

      const legendRect = legend.getBoundingClientRect()
      const canvasRect = canvas.getBoundingClientRect()
      return {
        centerDelta: Math.abs(
          legendRect.left +
            legendRect.width / 2 -
            (canvasRect.left + canvasRect.width / 2)
        ),
      }
    })
}

test.describe('plugin diagnostics call graph', () => {
  test('reads real audit data and supports graph, table, and filters', async ({
    userDataDir,
    rpcPort,
  }) => {
    await seedCallGraph(userDataDir)
    const app = await launchMotrix({ userDataDir, rpcPort })
    try {
      const page = await openMain(app)
      await openCallGraph(page)
      await expect(
        page.getByRole('group', { name: 'Call volume legend' })
      ).toBeVisible()
      const legendGeometry = await readLegendGeometry(page)
      expect(legendGeometry).not.toBeNull()
      expect(legendGeometry?.centerDelta).toBeLessThanOrEqual(2)

      for (const pluginId of [
        'motrix.filename-template',
        'motrix.scraper-hook',
        'motrix.url-resolver',
        'historical.missing',
      ]) {
        await expect(
          page.locator(`[data-testid="rf__node-${pluginId}"]`)
        ).toBeVisible()
      }
      await expect(page.getByTestId('edge-label')).toHaveCount(1)
      await expect(page.getByTestId('edge-label')).toHaveText(
        '2 successful calls'
      )

      const multiCommandEdge = page.locator(
        '.react-flow__edge[aria-label="motrix.filename-template called motrix.scraper-hook 2 times through 2 commands"]'
      )
      await expect(multiCommandEdge).toHaveAttribute('role', 'button')
      await expect(multiCommandEdge).toHaveAttribute('aria-pressed', 'false')
      await multiCommandEdge.focus()
      await page.keyboard.press('Enter')
      await expect(multiCommandEdge).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('edge-label')).toHaveCount(1)
      await expect(
        page.getByTestId('edge-label').filter({
          hasText: '2 successful calls · 2 commands',
        })
      ).toHaveCount(1)
      const inspector = page.getByRole('complementary', {
        name: 'Call graph selection details',
      })
      await expect(
        inspector.getByRole('heading', { name: 'Connection details' })
      ).toBeVisible()
      await expect(inspector.getByText(COMMANDS.scrape)).toBeVisible()
      await expect(inspector.getByText(COMMANDS.archive)).toBeVisible()

      await page.getByRole('tab', { name: 'Table' }).click()
      await expect(
        page.getByRole('group', { name: 'Call volume legend' })
      ).toHaveCount(0)
      const table = page.getByRole('table', {
        name: 'Plugin command relationships',
      })
      await expect(table.locator('tbody > tr')).toHaveCount(5)
      for (const commandId of Object.values(COMMANDS)) {
        await expect(table.getByText(commandId)).toBeVisible()
      }

      const search = page.getByRole('combobox', {
        name: 'Search relationships',
      })
      await expect(search).toHaveValue('')
      await expect(table.locator('tbody > tr')).toHaveCount(5)
      await search.fill(COMMANDS.missing)
      await page.keyboard.press('Escape')
      await expect(search).toHaveValue(COMMANDS.missing)
      await expect(table.locator('tbody > tr')).toHaveCount(1)
      await expect(
        table.getByText('historical.missing', { exact: true })
      ).toBeVisible()
      await page.getByRole('button', { name: 'Clear search' }).click()
      await expect(search).toHaveValue('')
      await expect(table.locator('tbody > tr')).toHaveCount(5)

      await search.fill('filename')
      await page
        .getByRole('option', {
          name: /Motrix Filename Template.*motrix\.filename-template/,
        })
        .click()
      await expect(search).toHaveValue('Motrix Filename Template')
      await expect(table.locator('tbody > tr')).toHaveCount(4)
      const refresh = page.getByRole('button', { name: 'Refresh' })
      await expect(refresh).toBeVisible()
      await expect(refresh).toHaveText('')
      await expect(refresh.locator('svg')).toHaveAttribute(
        'aria-hidden',
        'true'
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('supports keyboard navigation and keeps compact content bounded', async ({
    userDataDir,
    rpcPort,
  }) => {
    await seedCallGraph(userDataDir)
    const app = await launchMotrix({ userDataDir, rpcPort })
    try {
      const page = await openMain(app)
      await openCallGraph(page)

      const graphTab = page.getByRole('tab', { name: 'Graph' })
      const tableTab = page.getByRole('tab', { name: 'Table' })
      await expect(graphTab).toHaveText('')
      await expect(tableTab).toHaveText('')
      await expect(graphTab.locator('svg')).toHaveAttribute(
        'aria-hidden',
        'true'
      )
      await expect(tableTab.locator('svg')).toHaveAttribute(
        'aria-hidden',
        'true'
      )
      await graphTab.focus()
      await page.keyboard.press('ArrowRight')
      await expect(tableTab).toBeFocused()
      await expect(graphTab).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Space')
      await expect(tableTab).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowLeft')
      await expect(graphTab).toBeFocused()
      await expect(tableTab).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Enter')
      await expect(graphTab).toHaveAttribute('aria-selected', 'true')

      const filenameNode = page.locator(
        '[data-testid="rf__node-motrix.filename-template"]'
      )
      await filenameNode.focus()
      await page.keyboard.press('Enter')
      await expect(filenameNode).toHaveAttribute('aria-pressed', 'true')
      const openPlugin = page.getByRole('button', { name: 'Open plugin' })
      await openPlugin.focus()
      await page.keyboard.press('Enter')
      await expect
        .poll(() => page.url())
        .toContain('#/plugins/motrix.filename-template')
      await expect(
        page.getByRole('heading', {
          name: 'Motrix Filename Template',
          level: 1,
        })
      ).toBeVisible()

      await page.goBack()
      await expect(
        page.getByRole('heading', {
          name: 'Diagnostics',
          exact: true,
          level: 1,
        })
      ).toBeVisible()
      await expect(
        page.getByTestId('plugin-call-graph-container')
      ).toBeVisible()

      const search = page.getByRole('combobox', {
        name: 'Search relationships',
      })
      await search.focus()
      await expect(search).toBeFocused()

      const observedLayouts = new Set<'same-row' | 'two-row'>()
      for (const width of [1024, 914, 768]) {
        await page.setViewportSize({ width, height: 672 })
        await expect
          .poll(async () => (await readToolbarGeometry(page))?.toolbarFits)
          .toBe(true)
        const geometry = await readToolbarGeometry(page)
        expect(geometry).not.toBeNull()
        if (!geometry) {
          throw new Error('Call graph toolbar geometry is unavailable')
        }

        if (geometry.containerWidth >= 640) {
          observedLayouts.add('same-row')
          expect(geometry.sameRow).toBe(true)
        } else {
          observedLayouts.add('two-row')
          expect(geometry.actionsBelow).toBe(true)
        }
        expect(geometry.actionsEndAligned).toBe(true)
        expect(geometry.inputHeight).toBe(36)
        expect(geometry.tabsListHeight).toBe(36)
        expect(geometry.refreshButtonHeight).toBe(36)
        expect(geometry.toolbarGap).toBe(8)
        expect(geometry.actionsGap).toBe(8)
        expect(geometry.containerOverflow).toBe('visible')
        expect(geometry.pageOverflow).toBe('hidden')
        expect(geometry.activePanelOverflow).toBe('hidden')
        expect(geometry.focusRingClearance).toBeGreaterThanOrEqual(3)
        expect(geometry.noDocumentScroll).toBe(true)
        if (width === 768) expect(geometry.contentInsideInset).toBe(true)
      }
      expect(observedLayouts).toEqual(new Set(['same-row', 'two-row']))
    } finally {
      await app.close().catch(() => {})
    }
  })
})
