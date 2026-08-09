import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  expect,
  findAddTaskWindow,
  launchMotrix,
  test,
  waitForEngineReady,
} from './fixtures/electron-app'
import { type HttpFixture, startHttpFixture } from './fixtures/http-server'
import {
  configureTaskInspectorWindow,
  publishTaskInspectorPresentation,
  publishTaskInspectorRevision,
  seedTaskInspectorActivity,
  setTaskInspectorContentSize,
  TASK_INSPECTOR_ACTIVITY_IDS,
  TASK_INSPECTOR_ACTIVITY_NAMES,
  TASK_INSPECTOR_ACTIVITY_NOW,
  updateTaskInspectorAppearance,
} from './fixtures/task-inspector-activity'
import { getFreePort } from './helpers/free-port'

const SCREENSHOT_DIR = path.resolve('e2e/test-results/task-inspector-activity')

interface RuntimeTask {
  id: string
  name: string
  status: string
}

interface InspectorSnapshot {
  revision: number
  timeline: {
    events: Array<{ eventKey: string; kind: string }>
  }
  lifetime: {
    points: Array<{ t: number; down: number; up: number; flags: number }>
  }
}

async function waitForQueryIngress(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async (channel) => {
          try {
            const api = (
              window as unknown as {
                motrix?: {
                  invoke: (
                    channel: string,
                    ...args: unknown[]
                  ) => Promise<unknown>
                }
              }
            ).motrix
            if (!api) return false
            await api.invoke(channel)
            return true
          } catch {
            return false
          }
        }, Queries.ListTasks),
      { timeout: 30_000 }
    )
    .toBe(true)
}

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('html')).toHaveClass(/window-main/, {
    timeout: 20_000,
  })
  await waitForQueryIngress(page)
  return page
}

async function runtimeTasks(page: Page): Promise<RuntimeTask[]> {
  return page.evaluate(async (channel) => {
    const api = (
      window as unknown as {
        motrix?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        }
      }
    ).motrix
    if (!api) throw new Error('Motrix preload API is unavailable')
    return (await api.invoke(channel)) as RuntimeTask[]
  }, Queries.ListTasks)
}

async function runtimeTask(
  page: Page,
  taskId: string
): Promise<RuntimeTask | undefined> {
  return (await runtimeTasks(page)).find((task) => task.id === taskId)
}

async function invokeTaskCommand(
  page: Page,
  channel: string,
  taskId: string
): Promise<void> {
  await page.evaluate(
    async ({ channel, taskId }) => {
      const api = (
        window as unknown as {
          motrix?: {
            invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).motrix
      if (!api) throw new Error('Motrix preload API is unavailable')
      await api.invoke(channel, taskId)
    },
    { channel, taskId }
  )
}

async function sessionHistory(
  page: Page,
  taskId: string
): Promise<Array<{ t: number; down: number; up: number }>> {
  return page.evaluate(
    async ({ channel, taskId }) => {
      const api = (
        window as unknown as {
          motrix?: {
            invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).motrix
      if (!api) throw new Error('Motrix preload API is unavailable')
      return (await api.invoke(channel, { taskId })) as Array<{
        t: number
        down: number
        up: number
      }>
    },
    { channel: Queries.GetTaskSpeedHistory, taskId }
  )
}

async function addLiveDownload(
  app: ElectronApplication,
  page: Page,
  fileUrl: string
): Promise<RuntimeTask> {
  await page.getByRole('button', { name: 'New task', exact: true }).click()
  const addTaskPage = await findAddTaskWindow(app)
  await addTaskPage.getByRole('textbox', { name: 'URLs' }).fill(fileUrl)
  await addTaskPage.getByRole('button', { name: 'Download' }).click()
  await page.getByRole('link', { name: 'Downloads' }).click()
  await expect.poll(() => page.url()).toContain('#/downloads')
  await expect
    .poll(
      async () =>
        (await runtimeTasks(page)).find((task) =>
          task.name.includes('activity-live.bin')
        )?.status,
      { timeout: 20_000 }
    )
    .toBe('downloading')
  const created = (await runtimeTasks(page)).find((task) =>
    task.name.includes('activity-live.bin')
  )
  if (!created) throw new Error('Live Activity fixture task was not created')
  return created
}

async function launchSeededApp(
  userDataDir: string,
  options: { failAfterFirstQuery?: boolean } = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const preparation = await launchMotrix({
    userDataDir,
    rpcPort: await getFreePort(),
    commandLineArgs: ['--force-device-scale-factor=1'],
  })
  try {
    await firstWindow(preparation)
    await seedTaskInspectorActivity(preparation, userDataDir)
  } finally {
    await preparation.close().catch(() => {})
  }

  const app = await launchMotrix({
    userDataDir,
    rpcPort: await getFreePort(),
    commandLineArgs: ['--force-device-scale-factor=1'],
    extraEnv: {
      MOTRIX_E2E_ACTIVITY_WALL_NOW: String(TASK_INSPECTOR_ACTIVITY_NOW),
      MOTRIX_E2E_ACTIVITY_MONOTONIC_NOW: '100000',
      ...(options.failAfterFirstQuery
        ? { MOTRIX_E2E_ACTIVITY_FAIL_AFTER_FIRST_QUERY: '1' }
        : {}),
    },
  })
  const page = await firstWindow(app)
  const geometry = await configureTaskInspectorWindow(app, page, {
    width: 914,
    height: 900,
    sidebarExpanded: true,
  })
  expect(geometry.width).toBe(914)
  expect(geometry.zoomFactor).toBe(1)
  expect(geometry.dpr).toBe(1)
  await updateTaskInspectorAppearance(page, 'light', 'en-US')
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
  return { app, page }
}

async function openActivityForTask(
  page: Page,
  taskName: string
): Promise<void> {
  if (!page.url().includes('#/downloads')) {
    await page.getByRole('link', { name: 'Downloads' }).click()
    await expect.poll(() => page.url()).toContain('#/downloads')
  }
  const openDrawer = page.getByRole('dialog', {
    name: /^(Downloads|下载)$/i,
  })
  if (await openDrawer.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
    await expect(openDrawer).toBeHidden()
  }
  const row = page.getByRole('option', { name: new RegExp(taskName, 'i') })
  await expect(row).toBeVisible()
  await row.click()
  const tabs = page.getByRole('tab')
  await expect(tabs.last()).toBeVisible()
  await tabs.last().click()
  await expect(page.getByTestId('task-inspector-activity-root')).toBeVisible()
}

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true })
  // Interaction assertions intentionally leave focus on the control that
  // regained ownership. Visual-reference captures represent the resting
  // surface, so remove that transient focus-visible treatment first.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  })
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, name),
    animations: 'disabled',
  })
}

async function expectStatusPillContained(page: Page): Promise<void> {
  const drawer = page.getByRole('dialog', {
    name: /^(Downloads|下载)$/i,
  })
  const statusPill = drawer.getByTestId('task-status-pill')
  await expect(statusPill).toBeVisible()
  const geometry = await statusPill.evaluate((pill) => {
    const owningDrawer = pill.closest('[role="dialog"]')
    if (!(owningDrawer instanceof HTMLElement)) {
      throw new Error('Status pill has no owning inspector dialog')
    }
    const drawerBox = owningDrawer.getBoundingClientRect()
    const pillBox = pill.getBoundingClientRect()
    return {
      drawerLeft: drawerBox.left,
      drawerRight: drawerBox.right,
      pillLeft: pillBox.left,
      pillRight: pillBox.right,
    }
  })
  expect.soft(geometry.pillLeft).toBeGreaterThanOrEqual(geometry.drawerLeft)
  expect.soft(geometry.pillRight).toBeLessThanOrEqual(geometry.drawerRight)
}

async function expectYAxisSpeedLabelsSingleLine(page: Page): Promise<void> {
  const labels = page
    .getByTestId('task-inspector-activity-transfer-card')
    .locator('svg text')
    .filter({ hasText: /\/s/ })
  await expect(labels.first()).toBeVisible()
  const metrics = await labels.evaluateAll((nodes) =>
    nodes.map((node) => ({
      text: node.textContent ?? '',
      lineCount: node.querySelectorAll('tspan').length,
      fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
    }))
  )

  expect(metrics.some(({ text }) => text.includes('/s'))).toBe(true)
  expect(metrics.every(({ lineCount }) => lineCount === 1)).toBe(true)
  expect(metrics.every(({ fontSize }) => fontSize <= 10)).toBe(true)
}

async function inspectorSnapshot(
  page: Page,
  taskId: string
): Promise<InspectorSnapshot> {
  return page.evaluate(
    async ({ channel, taskId }) => {
      const api = (
        window as unknown as {
          motrix?: {
            invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).motrix
      if (!api) throw new Error('Motrix preload API is unavailable')
      const envelope = (await api.invoke(channel, { taskId })) as {
        ok: boolean
        value?: InspectorSnapshot
        error?: { message: string }
      }
      if (!envelope.ok || !envelope.value) {
        throw new Error(envelope.error?.message ?? 'Inspector query failed')
      }
      return envelope.value
    },
    { channel: Queries.GetTaskInspectorActivity, taskId }
  )
}

async function presentActiveReference(
  app: ElectronApplication,
  page: Page,
  taskId: string,
  options: { onlyTask?: boolean } = {}
): Promise<void> {
  await publishTaskInspectorPresentation(app, page, {
    taskId,
    status: 'downloading',
    downloadSpeed: 384 * 1024,
    uploadSpeed: 72 * 1024,
    onlyTask: options.onlyTask,
  })
  const summary = page.getByTestId('task-inspector-activity-summary-card')
  await expect(summary.getByText('384 KB/s', { exact: true })).toBeVisible()
  await expect(summary.getByText('72.0 KB/s', { exact: true })).toBeVisible()
}

test.describe('Task Inspector Activity', () => {
  test.setTimeout(180_000)

  test('fits Activity inside the minimum 914 by 672 window without vertical scrolling', async ({
    userDataDir,
  }) => {
    const { app, page } = await launchSeededApp(userDataDir)
    try {
      const viewport = await setTaskInspectorContentSize(app, page, 914, 672)
      expect(viewport).toEqual({ width: 914, height: 672 })

      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.rich)

      const geometry = await page
        .getByTestId('task-inspector-drawer-content')
        .evaluate((element) => {
          const surface = element.querySelector<HTMLElement>(
            '[data-testid="task-inspector-activity-transfer-surface"]'
          )
          const chartFrame = element.querySelector<HTMLElement>(
            '[data-testid="activity-transfer-chart-frame"]'
          )
          if (!surface || !chartFrame) {
            throw new Error('Activity transfer surface is incomplete')
          }
          const surfaceBox = surface.getBoundingClientRect()
          const chartFrameBox = chartFrame.getBoundingClientRect()
          const surfaceStyle = getComputedStyle(surface)
          return {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            overflowY: getComputedStyle(element).overflowY,
            surfaceInnerLeft:
              surfaceBox.left + Number.parseFloat(surfaceStyle.borderLeftWidth),
            surfaceInnerRight:
              surfaceBox.right -
              Number.parseFloat(surfaceStyle.borderRightWidth),
            chartFrameLeft: chartFrameBox.left,
            chartFrameRight: chartFrameBox.right,
          }
        })

      expect(geometry.overflowY).toBe('auto')
      expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight)
      expect(geometry.chartFrameLeft).toBeCloseTo(geometry.surfaceInnerLeft, 0)
      expect(geometry.chartFrameRight).toBeCloseTo(
        geometry.surfaceInnerRight,
        0
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('renders durable states, exact container boundaries, accessibility, and visual variants', async ({
    userDataDir,
  }) => {
    const { app, page } = await launchSeededApp(userDataDir)
    try {
      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.rich)

      const root = page.getByTestId('task-inspector-activity-root')
      const layout = page.getByTestId('task-inspector-activity-layout')
      const timeline = page.getByTestId('task-inspector-activity-timeline')
      const transfer = page.getByTestId('task-inspector-activity-transfer-card')
      const summary = page.getByTestId('task-inspector-activity-summary-card')
      await expect(timeline).toBeVisible()
      await expect(transfer).toBeVisible()
      await expect(summary).toBeVisible()
      await expect(
        transfer.getByText(/Adaptive resolution.*48 samples/i)
      ).toBeVisible()

      const normalGeometry = await root.evaluate((element) => {
        const layout = element.querySelector<HTMLElement>(
          '[data-testid="task-inspector-activity-layout"]'
        )
        if (!layout) throw new Error('Activity layout is missing')
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          columns: getComputedStyle(layout).gridTemplateColumns,
        }
      })
      expect(normalGeometry.scrollWidth).toBeLessThanOrEqual(
        normalGeometry.clientWidth
      )
      expect(normalGeometry.columns.split(' ')).toHaveLength(2)

      const group = transfer.getByRole('radiogroup', {
        name: /Transfer time range/i,
      })
      const lifetime = group.getByRole('radio', { name: /Lifetime/i })
      await expect(lifetime).toHaveAttribute('aria-checked', 'true')
      await lifetime.focus()
      await lifetime.press('Home')
      await expect(
        group.getByRole('radio', { name: /Session/i })
      ).toHaveAttribute('aria-checked', 'true')
      await group.getByRole('radio', { name: /Session/i }).press('End')
      await expect(
        group.getByRole('radio', { name: /Lifetime/i })
      ).toHaveAttribute('aria-checked', 'true')

      const pauseNode = timeline.getByRole('button', { name: /Paused/i })
      await pauseNode.click()
      const detail = page.getByRole('dialog', { name: /Paused details/i })
      await expect(detail).toBeVisible()
      const detailSurface = await detail.evaluate((element) => {
        const style = getComputedStyle(element)
        const alphaMatch = style.backgroundColor.match(
          /rgba?\([^)]*?(?:,\s*([\d.]+))?\)/
        )
        return {
          background: style.backgroundColor,
          opacity: style.opacity,
          alpha: alphaMatch?.[1] ? Number(alphaMatch[1]) : 1,
        }
      })
      expect(detailSurface.opacity).toBe('1')
      expect(detailSurface.alpha).toBe(1)
      await page.keyboard.press('Escape')
      await expect(detail).toBeHidden()
      await expect(pauseNode).toBeFocused()

      await root.evaluate((element) => {
        element.style.width = '639px'
      })
      await expect
        .poll(async () => {
          const [first, second] = await layout
            .locator(':scope > *')
            .evaluateAll((children) =>
              children.map((child) => child.getBoundingClientRect().top)
            )
          return Math.abs((first ?? 0) - (second ?? 0)) < 2
        })
        .toBe(false)
      await root.evaluate((element) => {
        element.style.width = '640px'
      })
      await expect
        .poll(async () => {
          const [first, second] = await layout
            .locator(':scope > *')
            .evaluateAll((children) =>
              children.map((child) => child.getBoundingClientRect().top)
            )
          return Math.abs((first ?? 0) - (second ?? 0)) < 2
        })
        .toBe(true)

      await transfer.evaluate((element) => {
        element.style.width = '419px'
      })
      await expect
        .poll(() =>
          transfer
            .getByTestId('task-inspector-activity-transfer-surface')
            .locator(':scope > div')
            .first()
            .evaluate((element) => getComputedStyle(element).flexDirection)
        )
        .toBe('column')
      await transfer.evaluate((element) => {
        element.style.width = '420px'
      })
      await expect
        .poll(() =>
          transfer
            .getByTestId('task-inspector-activity-transfer-surface')
            .locator(':scope > div')
            .first()
            .evaluate((element) => getComputedStyle(element).flexDirection)
        )
        .toBe('row')
      await root.evaluate((element) => element.style.removeProperty('width'))
      await transfer.evaluate((element) =>
        element.style.removeProperty('width')
      )

      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(
        await group
          .getByRole('radio', { name: /Lifetime/i })
          .evaluate((element) => getComputedStyle(element).transitionProperty)
      ).toBe('none')
      await presentActiveReference(app, page, TASK_INSPECTOR_ACTIVITY_IDS.rich)
      await capture(page, 'reference-en-US-light-914.png')

      const narrowViewport = await setTaskInspectorContentSize(
        app,
        page,
        620,
        900
      )
      expect(narrowViewport).toEqual({ width: 620, height: 900 })
      await presentActiveReference(app, page, TASK_INSPECTOR_ACTIVITY_IDS.rich)
      await expect
        .poll(async () => {
          const [first, second] = await layout
            .locator(':scope > *')
            .evaluateAll((children) =>
              children.map((child) => child.getBoundingClientRect().top)
            )
          return Math.abs((first ?? 0) - (second ?? 0))
        })
        .toBeGreaterThanOrEqual(2)
      const narrowGeometry = await root.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      expect(narrowGeometry.scrollWidth).toBeLessThanOrEqual(
        narrowGeometry.clientWidth
      )
      await capture(page, 'reference-en-US-light-620.png')

      const referenceViewport = await setTaskInspectorContentSize(
        app,
        page,
        1462,
        1076
      )
      expect(referenceViewport).toEqual({ width: 1462, height: 1076 })
      await presentActiveReference(
        app,
        page,
        TASK_INSPECTOR_ACTIVITY_IDS.rich,
        {
          onlyTask: true,
        }
      )
      await capture(page, 'approved-reference-match-en-US-light-1462x1076.png')
      await configureTaskInspectorWindow(app, page, {
        width: 914,
        height: 900,
        sidebarExpanded: true,
      })

      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.error)
      const failedNode = page
        .getByTestId('task-inspector-activity-timeline')
        .getByRole('button', { name: /^Failed\b/i })
      await failedNode.click()
      await expect(
        page.getByText(/remote server closed the connection/i)
      ).toBeVisible()
      await page.keyboard.press('Escape')
      await capture(page, 'error-en-US-light-914.png')

      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.zero)
      await expect(page.getByText('No network traffic right now')).toBeVisible()
      await capture(page, 'all-zero-en-US-light-914.png')

      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.empty)
      await expect(
        page.getByText('Lifetime history is not available yet')
      ).toBeVisible()

      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.single)
      await expect(
        page
          .getByTestId('task-inspector-activity-transfer-card')
          .locator('.recharts-dot')
      ).toHaveCount(2)

      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.compacted)
      await expect(
        page.getByText(/Adaptive resolution.*72 samples/i)
      ).toBeVisible()
      await capture(page, 'completed-en-US-light-914.png')

      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.truncated)
      const truncated = page.getByRole('button', {
        name: /Earlier history truncated.*2 events/i,
      })
      await expect(truncated).toBeVisible()
      await truncated.click()
      await expect(
        page.getByRole('dialog', {
          name: /Earlier history truncated.*details/i,
        })
      ).toBeVisible()
      await page.keyboard.press('Escape')
      await capture(page, 'truncated-en-US-light-914.png')

      for (const variant of [
        { theme: 'dark', language: 'en-US' },
        { theme: 'light', language: 'zh-CN' },
        { theme: 'dark', language: 'zh-CN' },
      ] as const) {
        await updateTaskInspectorAppearance(
          page,
          variant.theme,
          variant.language
        )
        await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.rich)
        await presentActiveReference(
          app,
          page,
          TASK_INSPECTOR_ACTIVITY_IDS.rich
        )
        await capture(
          page,
          `reference-${variant.language}-${variant.theme}-914.png`
        )
      }
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('keeps the last good snapshot visible when the deterministic query seam fails', async ({
    userDataDir,
  }) => {
    const { app, page } = await launchSeededApp(userDataDir, {
      failAfterFirstQuery: true,
    })
    try {
      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.rich)
      await expect(
        page.getByText(/Adaptive resolution.*48 samples/i)
      ).toBeVisible()
      await publishTaskInspectorRevision(
        app,
        TASK_INSPECTOR_ACTIVITY_IDS.rich,
        Number.MAX_SAFE_INTEGER
      )

      await expect(page.getByText(/Data may be out of date/i)).toBeVisible()
      await expect(
        page.getByText(/Adaptive resolution.*48 samples/i)
      ).toBeVisible()
      await expect(page.getByRole('button', { name: /Retry/i })).toBeVisible()
      await capture(page, 'stale-en-US-light-914.png')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('shows unavailable before any good snapshot when the deterministic query seam fails', async ({
    userDataDir,
  }) => {
    const { app, page } = await launchSeededApp(userDataDir, {
      failAfterFirstQuery: true,
    })
    try {
      await inspectorSnapshot(page, TASK_INSPECTOR_ACTIVITY_IDS.rich)
      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.rich)

      await expect(
        page.getByText(/Lifetime activity is unavailable/i)
      ).toBeVisible()
      await expect(
        page.getByRole('radio', { name: /Session/i })
      ).toHaveAttribute('aria-checked', 'true')
      await expect(
        page.getByRole('radio', { name: /Lifetime/i })
      ).toBeDisabled()
      await expect(page.getByRole('button', { name: /Retry/i })).toBeVisible()
      await capture(page, 'unavailable-en-US-light-914.png')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('keeps live Y-axis speed labels on one line', async ({
    userDataDir,
  }) => {
    let fixture: HttpFixture | undefined
    let app: ElectronApplication | undefined
    try {
      fixture = await startHttpFixture({
        pathname: '/activity-live.bin',
        size: 16 * 1024 * 1024,
        throttleBytesPerSecond: 128 * 1024,
      })
      app = await launchMotrix({
        userDataDir,
        rpcPort: await getFreePort(),
        commandLineArgs: ['--force-device-scale-factor=1'],
      })
      const page = await firstWindow(app)
      await configureTaskInspectorWindow(app, page, {
        width: 914,
        height: 900,
        sidebarExpanded: true,
      })
      await updateTaskInspectorAppearance(page, 'light', 'en-US')
      await waitForEngineReady(page)
      const task = await addLiveDownload(app, page, fixture.fileUrl)

      await expect
        .poll(async () => (await sessionHistory(page, task.id)).length, {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(3)

      await invokeTaskCommand(page, Commands.PauseTask, task.id)
      await expect
        .poll(async () => (await runtimeTask(page, task.id))?.status)
        .toBe('paused')
      await invokeTaskCommand(page, Commands.ResumeTask, task.id)
      await expect
        .poll(async () => (await runtimeTask(page, task.id))?.status)
        .toBe('downloading')
      await expect
        .poll(
          async () =>
            (await inspectorSnapshot(page, task.id)).lifetime.points.length
        )
        .toBeGreaterThan(0)

      await openActivityForTask(page, task.name)
      await presentActiveReference(app, page, task.id)
      await expectStatusPillContained(page)
      await expectYAxisSpeedLabelsSingleLine(page)
      await capture(page, 'active-live-en-US-light-914.png')
      await invokeTaskCommand(page, Commands.PauseTask, task.id)
      await expect
        .poll(async () => (await runtimeTask(page, task.id))?.status)
        .toBe('paused')
    } finally {
      if (app) await app.close().catch(() => {})
      if (fixture) await fixture.close().catch(() => {})
    }
  })

  test('records repeated live Pause and Resume transitions and restores Lifetime while Session resets', async ({
    userDataDir,
  }) => {
    let fixture: HttpFixture | undefined
    let app: ElectronApplication | undefined
    try {
      fixture = await startHttpFixture({
        pathname: '/activity-live.bin',
        size: 16 * 1024 * 1024,
        throttleBytesPerSecond: 128 * 1024,
      })
      app = await launchMotrix({
        userDataDir,
        rpcPort: await getFreePort(),
        commandLineArgs: ['--force-device-scale-factor=1'],
      })
      let page = await firstWindow(app)
      await configureTaskInspectorWindow(app, page, {
        width: 914,
        height: 900,
        sidebarExpanded: true,
      })
      await waitForEngineReady(page)
      const task = await addLiveDownload(app, page, fixture.fileUrl)

      await expect
        .poll(async () => (await sessionHistory(page, task.id)).length, {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(3)

      for (let cycle = 0; cycle < 2; cycle += 1) {
        await invokeTaskCommand(page, Commands.PauseTask, task.id)
        await expect
          .poll(async () => (await runtimeTask(page, task.id))?.status)
          .toBe('paused')
        await page.waitForTimeout(250)
        await invokeTaskCommand(page, Commands.ResumeTask, task.id)
        await expect
          .poll(async () => (await runtimeTask(page, task.id))?.status)
          .toBe('downloading')
        await page.waitForTimeout(1_250)
      }

      await openActivityForTask(page, task.name)
      await expect(
        page.getByTestId('task-inspector-activity-root')
      ).toBeVisible()
      await presentActiveReference(app, page, task.id)
      await expectStatusPillContained(page)
      await capture(page, 'active-live-en-US-light-914.png')

      await invokeTaskCommand(page, Commands.PauseTask, task.id)
      await expect
        .poll(async () => (await runtimeTask(page, task.id))?.status)
        .toBe('paused')

      let beforeLifetime: InspectorSnapshot | undefined
      await expect
        .poll(async () => {
          beforeLifetime = await inspectorSnapshot(page, task.id)
          const kinds = beforeLifetime.timeline.events.map(
            (event) => event.kind
          )
          return {
            pauses: kinds.filter((kind) => kind === 'paused').length,
            resumes: kinds.filter((kind) => kind === 'resumed').length,
            points: beforeLifetime.lifetime.points.length,
          }
        })
        .toMatchObject({ pauses: 3, resumes: 2 })
      expect(beforeLifetime?.lifetime.points.length ?? 0).toBeGreaterThan(0)
      const beforeSession = await sessionHistory(page, task.id)
      expect(beforeSession.length).toBeGreaterThanOrEqual(3)

      await app.close()
      app = undefined
      const restartedAt = Date.now()
      app = await launchMotrix({
        userDataDir,
        rpcPort: await getFreePort(),
        commandLineArgs: ['--force-device-scale-factor=1'],
      })
      page = await firstWindow(app)
      await configureTaskInspectorWindow(app, page, {
        width: 914,
        height: 900,
        sidebarExpanded: true,
      })
      await waitForEngineReady(page)
      await expect
        .poll(async () => (await runtimeTask(page, task.id))?.id, {
          timeout: 20_000,
        })
        .toBe(task.id)

      const afterLifetime = await inspectorSnapshot(page, task.id)
      const durableKeys = new Set(
        afterLifetime.timeline.events.map((event) => event.eventKey)
      )
      for (const event of beforeLifetime?.timeline.events ?? []) {
        expect(durableKeys.has(event.eventKey)).toBe(true)
      }
      expect(afterLifetime.lifetime.points.length).toBeGreaterThanOrEqual(
        beforeLifetime?.lifetime.points.length ?? 0
      )

      const afterSession = await sessionHistory(page, task.id)
      expect(
        afterSession.every((point) => point.t >= restartedAt - 2_000)
      ).toBe(true)
      expect(afterSession.length).toBeLessThan(beforeSession.length)

      await openActivityForTask(page, task.name)
      await expectStatusPillContained(page)
      await capture(page, 'paused-restarted-en-US-light-914.png')
    } finally {
      if (app) await app.close().catch(() => {})
      if (fixture) await fixture.close().catch(() => {})
    }
  })

  test('forwards the inspector event channel without duplicating listeners', async ({
    userDataDir,
  }) => {
    const { app, page } = await launchSeededApp(userDataDir)
    try {
      await openActivityForTask(page, TASK_INSPECTOR_ACTIVITY_NAMES.rich)
      const before = await inspectorSnapshot(
        page,
        TASK_INSPECTOR_ACTIVITY_IDS.rich
      )
      await publishTaskInspectorRevision(
        app,
        TASK_INSPECTOR_ACTIVITY_IDS.rich,
        before.revision + 1
      )
      await expect(
        page.getByTestId('task-inspector-activity-root')
      ).toBeVisible()
      expect(before.revision).toBeGreaterThan(0)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
