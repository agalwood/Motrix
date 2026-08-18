import type { CDPSession, ElectronApplication, Page } from '@playwright/test'
import type { SupportedLocale } from '@shared/constants/locales'
import { expect, test } from './fixtures/electron-app'

interface ActivitySpan {
  w: 1 | 2 | 3 | 4
  h: 1 | 2
}

interface RendererProfile {
  canvasCount: number
  tooltipCount: number
  virtualCellCount: number
  ariaRows: string | null
  ariaColumns: string | null
  calendarClientWidth: number
  calendarScrollWidth: number
  canvasCssWidth: number
  monthLabels: string[]
  weekdayLabels: string[]
}

interface PointerProfile {
  elapsedMs: number
  repaintCount: number
  pixelsStable: boolean
  tooltipCountAfterSettle: number
  tooltipMountedFrames: number
  tooltipPositionChanges: number
  tooltipTextChanges: number
  resizeObserverLoopErrors: string[]
}

interface ResizeFrameProfile {
  p95Ms: number
  coalescedFrames: number
  measuredFrames: number
}

interface DprTransitionProfile {
  p95Ms: number
  handlerP95Ms: number
  measuredFrames: number
  listenerCounts: number[]
}

interface ActivitySeedEvent {
  taskId: string
  kind: 'submitted' | 'download_completed'
  occurredAt: number
  accuracy: 'exact' | 'recovered'
}

interface RichActivitySeed {
  trackingStartedAt: number
  events: ActivitySeedEvent[]
}

interface ActivityFixtureProfile {
  activeDays: number
  submittedOnlyDays: number
  recoveredCompletions: number
  depthDays: [number, number, number, number]
}

interface FixtureSqliteRunResult {
  changes: number
}

interface FixtureSqliteStatement {
  run(...values: Array<string | number>): FixtureSqliteRunResult
}

interface FixtureSqliteDatabase {
  pragma(source: string): unknown
  prepare(sql: string): FixtureSqliteStatement
  transaction<T>(callback: () => T): () => T
  close(): void
}

type FixtureSqliteConstructor = new (filename: string) => FixtureSqliteDatabase

const SUPPORTED_SPANS: readonly ActivitySpan[] = [
  { w: 1, h: 1 },
  { w: 2, h: 1 },
  { w: 3, h: 1 },
  { w: 4, h: 1 },
  { w: 2, h: 2 },
  { w: 3, h: 2 },
  { w: 4, h: 2 },
]

const ENFORCE_REFERENCE_BUDGETS =
  process.env.MOTRIX_ACTIVITY_PROFILE_GATE === '1'

function expectedWeeks(span: ActivitySpan): 13 | 26 | 53 {
  if (span.w === 1 || (span.w === 2 && span.h === 1)) return 13
  if (span.w === 3 && span.h === 1) return 26
  if (span.w === 2 && span.h === 2) return 26
  return 53
}

function buildRichActivitySeed(now = new Date()): RichActivitySeed {
  const completionLevels = [1, 2, 4, 8] as const
  const events: ActivitySeedEvent[] = []
  const todayNoon = new Date(now)
  todayNoon.setHours(12, 0, 0, 0)

  // Offset -1 is a rollover guard: if this test crosses local midnight, the
  // newly current day and its ArrowLeft anchor remain deterministic.
  for (let offset = -1; offset < 364; offset += 1) {
    const day = new Date(todayNoon)
    day.setDate(day.getDate() - offset)
    const weekday = day.getDay()
    const signal = (offset * 37 + Math.floor(offset / 7) * 11 + 17) % 29
    const submittedOnly = offset > 0 && offset % 61 === 0
    const recentWeekdayStreak =
      offset >= 14 && offset <= 42 && weekday >= 1 && weekday <= 5
    const seasonalBurst =
      (offset >= 138 && offset <= 166 && offset % 3 !== 0) ||
      (offset >= 276 && offset <= 296 && weekday % 2 === 0)
    const active =
      !submittedOnly &&
      (offset === -1 ||
        offset === 0 ||
        offset === 6 ||
        offset === 7 ||
        recentWeekdayStreak ||
        seasonalBurst ||
        signal < (offset < 120 ? 8 : 5))

    let completed = active
      ? completionLevels[(Math.floor(offset / 7) + weekday) % 4]
      : 0
    if (offset === -1 || offset === 0) completed = 8
    if (offset === 6 || offset === 7) completed = 4

    const submitted =
      offset === -1 || offset === 0
        ? 10
        : completed > 0
          ? completed + ((offset * 7 + 3) % 3)
          : submittedOnly
            ? 2
            : 0
    const recovered =
      completed > 0
        ? offset === -1 || offset === 0
          ? 2
          : offset % 23 === 0
            ? 1
            : 0
        : 0
    const dayNoon = day.getTime()
    const dayStart = new Date(day)
    dayStart.setHours(0, 0, 0, 0)
    const submittedAt =
      offset === -1
        ? dayStart.getTime()
        : offset === 0
          ? Math.min(now.getTime(), dayNoon - 3_600_000)
          : dayNoon - 3_600_000
    const completedAt =
      offset === -1
        ? dayStart.getTime()
        : offset === 0
          ? Math.min(now.getTime(), dayNoon)
          : dayNoon

    for (let taskIndex = 0; taskIndex < submitted; taskIndex += 1) {
      const taskId = `e2e-activity-${offset}-${taskIndex}`
      events.push({
        taskId,
        kind: 'submitted',
        occurredAt:
          offset === -1 || offset === 0
            ? submittedAt
            : submittedAt + taskIndex * 1_000,
        accuracy: 'exact',
      })
      if (taskIndex < completed) {
        events.push({
          taskId,
          kind: 'download_completed',
          occurredAt:
            offset === -1 || offset === 0
              ? completedAt
              : completedAt + taskIndex * 1_000,
          accuracy: taskIndex < recovered ? 'recovered' : 'exact',
        })
      }
    }
  }

  const trackingStart = new Date(todayNoon)
  trackingStart.setDate(trackingStart.getDate() - 364)
  trackingStart.setHours(0, 0, 0, 0)
  return { trackingStartedAt: trackingStart.getTime(), events }
}

async function seedRichActivityHistory(
  electronApp: ElectronApplication,
  userDataDir: string,
  seed: RichActivitySeed
): Promise<number> {
  return electronApp.evaluate(
    ({ app }, payload) => {
      const { createRequire } = process.getBuiltinModule('module')
      const path = process.getBuiltinModule('path')
      const requireFromApp = createRequire(
        path.join(app.getAppPath(), 'package.json')
      )
      const Database = requireFromApp(
        'better-sqlite3'
      ) as FixtureSqliteConstructor
      const database = new Database(path.join(payload.userDataDir, 'motrix.db'))

      try {
        database.pragma('busy_timeout = 5000')
        const clearFixture = database.prepare(
          "DELETE FROM task_activity_events WHERE motrix_id GLOB 'e2e-activity-*'"
        )
        const insertEvent = database.prepare(
          `INSERT INTO task_activity_events (
            motrix_id,
            kind,
            occurred_at,
            accuracy
          ) VALUES (?, ?, ?, ?)`
        )
        const updateMeta = database.prepare(
          `UPDATE task_activity_meta
           SET
             tracking_started_at = ?,
             coverage_gap_at = NULL,
             revision = revision + ?
           WHERE id = 1`
        )
        const applyFixture = database.transaction(() => {
          clearFixture.run()
          let inserted = 0
          for (const event of payload.events) {
            inserted += insertEvent.run(
              event.taskId,
              event.kind,
              event.occurredAt,
              event.accuracy
            ).changes
          }
          if (
            updateMeta.run(payload.trackingStartedAt, inserted).changes !== 1
          ) {
            throw new Error('Task activity metadata singleton is missing')
          }
          return inserted
        })
        return applyFixture()
      } finally {
        database.close()
      }
    },
    { userDataDir, ...seed }
  )
}

async function readActivityFixtureProfile(
  page: Page
): Promise<ActivityFixtureProfile> {
  return page.evaluate(async () => {
    const api = (
      window as unknown as {
        motrix?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        }
      }
    ).motrix
    if (!api) throw new Error('Motrix preload API is unavailable')

    const cursor = new Date()
    cursor.setHours(0, 0, 0, 0)
    cursor.setDate(cursor.getDate() - 370)
    const days: Array<{ dateKey: string; fromMs: number; toMs: number }> = []
    for (let index = 0; index < 371; index += 1) {
      const fromMs = cursor.getTime()
      const year = String(cursor.getFullYear()).padStart(4, '0')
      const month = String(cursor.getMonth() + 1).padStart(2, '0')
      const day = String(cursor.getDate()).padStart(2, '0')
      cursor.setDate(cursor.getDate() + 1)
      days.push({
        dateKey: `${year}-${month}-${day}`,
        fromMs,
        toMs: cursor.getTime(),
      })
    }
    const snapshot = (await api.invoke('query:getTaskActivity', {
      days,
    })) as {
      days: Array<{
        submitted: number
        downloadCompleted: number
        recoveredDownloadCompleted: number
      }>
    }
    const profile: ActivityFixtureProfile = {
      activeDays: 0,
      submittedOnlyDays: 0,
      recoveredCompletions: 0,
      depthDays: [0, 0, 0, 0],
    }
    for (const day of snapshot.days) {
      if (day.downloadCompleted === 0) {
        if (day.submitted > 0) profile.submittedOnlyDays += 1
        continue
      }
      profile.activeDays += 1
      profile.recoveredCompletions += day.recoveredDownloadCompleted
      if (day.downloadCompleted === 1) profile.depthDays[0] += 1
      else if (day.downloadCompleted <= 3) profile.depthDays[1] += 1
      else if (day.downloadCompleted <= 7) profile.depthDays[2] += 1
      else profile.depthDays[3] += 1
    }
    return profile
  })
}

async function installDprChangeProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface ResolutionRecord {
      native: MediaQueryList
      proxy: MediaQueryList
      listeners: Set<EventListenerOrEventListenerObject>
    }

    const nativeMatchMedia = window.matchMedia.bind(window)
    const activeResolutionRecords = new Set<ResolutionRecord>()

    window.matchMedia = ((query: string) => {
      const native = nativeMatchMedia(query)
      if (!query.startsWith('(resolution:')) return native

      const record = {
        native,
        proxy: native,
        listeners: new Set<EventListenerOrEventListenerObject>(),
      }
      const proxy = new Proxy(native, {
        get(target, property) {
          if (property === 'addEventListener') {
            return (
              type: string,
              listener: EventListenerOrEventListenerObject | null,
              options?: boolean | AddEventListenerOptions
            ) => {
              if (!listener) return
              if (type === 'change') {
                record.listeners.add(listener)
                activeResolutionRecords.add(record)
              }
              target.addEventListener(type, listener, options)
            }
          }
          if (property === 'removeEventListener') {
            return (
              type: string,
              listener: EventListenerOrEventListenerObject | null,
              options?: boolean | EventListenerOptions
            ) => {
              if (!listener) return
              if (type === 'change') {
                record.listeners.delete(listener)
                if (record.listeners.size === 0) {
                  activeResolutionRecords.delete(record)
                }
              }
              target.removeEventListener(type, listener, options)
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      record.proxy = proxy
      return proxy
    }) as typeof window.matchMedia

    Object.defineProperty(window, '__motrixActivityDprProbe', {
      configurable: true,
      value: {
        trigger(): number {
          const records = Array.from(activeResolutionRecords)
          let listenerCount = 0
          for (const record of records) {
            const event = new Event('change') as MediaQueryListEvent
            for (const listener of Array.from(record.listeners)) {
              listenerCount += 1
              if (typeof listener === 'function') {
                listener.call(record.proxy, event)
              } else {
                listener.handleEvent(event)
              }
            }
          }
          return listenerCount
        },
      },
    })
  })
}

async function updateActivityLayout(
  page: Page,
  span: ActivitySpan
): Promise<void> {
  await page.evaluate(async ({ w, h }) => {
    const api = (
      window as unknown as {
        motrix?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
        }
      }
    ).motrix
    if (!api) throw new Error('Motrix preload API is unavailable')

    const settings = (await api.invoke('query:getSettings')) as {
      dashboard: {
        version: 1
        columns: 4
        tiles: Array<{
          id: string
          enabled: boolean
          x: number
          y: number
          w: number
          h: number
        }>
      }
    }
    const tiles = settings.dashboard.tiles.map((tile) =>
      tile.id === 'activity'
        ? { ...tile, enabled: true, x: 0, y: 0, w, h }
        : { ...tile, enabled: false }
    )
    await api.invoke('command:updateSettings', {
      dashboard: {
        version: 1,
        columns: 4,
        tiles,
      },
    })
  }, span)
}

async function updateAppearance(
  page: Page,
  theme: 'system' | 'light' | 'dark',
  language: SupportedLocale
): Promise<void> {
  await page.evaluate(
    async ({ nextTheme, nextLanguage }) => {
      const api = (
        window as unknown as {
          motrix?: {
            invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).motrix
      if (!api) throw new Error('Motrix preload API is unavailable')
      await api.invoke('command:updateSettings', {
        app: { theme: nextTheme, language: nextLanguage },
      })
    },
    { nextTheme: theme, nextLanguage: language }
  )
}

async function reloadActivity(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveClass(/window-main/, {
    timeout: 15_000,
  })
  await expect(page.getByTestId('dashboard-tile-activity')).toBeVisible()
  await expect(page.getByTestId('activity-calendar')).toBeVisible()
}

async function readRendererProfile(page: Page): Promise<RendererProfile> {
  return page.getByTestId('dashboard-tile-activity').evaluate((tile) => {
    const calendar = tile.querySelector<HTMLElement>(
      '[data-testid="activity-calendar"]'
    )
    const canvas = tile.querySelector<HTMLCanvasElement>(
      '[data-testid="activity-canvas"]'
    )
    if (!calendar || !canvas) {
      throw new Error('Activity calendar did not render')
    }

    const directLabels = Array.from(calendar.children).filter(
      (element): element is HTMLSpanElement =>
        element instanceof HTMLSpanElement &&
        element.getAttribute('aria-hidden') === 'true'
    )
    const monthLabels = directLabels
      .filter((element) => element.style.left !== '')
      .map((element) => element.textContent?.trim() ?? '')
      .filter(Boolean)
    const weekdayLabels = directLabels
      .filter((element) => element.style.top !== '')
      .map((element) => element.textContent?.trim() ?? '')
      .filter(Boolean)

    return {
      canvasCount: tile.querySelectorAll(
        'canvas[data-testid="activity-canvas"]'
      ).length,
      tooltipCount: document.querySelectorAll('[role="tooltip"]').length,
      virtualCellCount: calendar.querySelectorAll('[role="gridcell"]').length,
      ariaRows: calendar.getAttribute('aria-rowcount'),
      ariaColumns: calendar.getAttribute('aria-colcount'),
      calendarClientWidth: calendar.clientWidth,
      calendarScrollWidth: calendar.scrollWidth,
      canvasCssWidth: Number.parseFloat(canvas.style.width),
      monthLabels,
      weekdayLabels,
    }
  })
}

async function pointerProfile(page: Page): Promise<PointerProfile> {
  return page.getByTestId('activity-calendar').evaluate(async (calendar) => {
    const canvas = calendar.querySelector<HTMLCanvasElement>(
      '[data-testid="activity-canvas"]'
    )
    if (!canvas) throw new Error('Activity Canvas is unavailable')

    const contextPrototype = CanvasRenderingContext2D.prototype
    const originalClearRect = contextPrototype.clearRect
    let repaintCount = 0
    const resizeObserverLoopErrors: string[] = []
    const captureResizeObserverLoopError = (event: ErrorEvent) => {
      if (event.message.includes('ResizeObserver loop')) {
        resizeObserverLoopErrors.push(event.message)
      }
    }
    contextPrototype.clearRect = function patchedClearRect(...args) {
      if (this.canvas === canvas) repaintCount += 1
      return originalClearRect.apply(this, args)
    }
    window.addEventListener('error', captureResizeObserverLoopError)

    try {
      const calendarElement = calendar as HTMLElement
      calendarElement.focus()
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')
      const anchor = calendar.querySelector<HTMLElement>(
        '[data-testid="activity-tooltip-anchor"]'
      )
      if (!tooltip || !anchor) {
        throw new Error('Activity tooltip did not open before pointer sweep')
      }
      const pointAtAnchor = () => {
        const anchorRect = anchor.getBoundingClientRect()
        return {
          x: anchorRect.left + anchorRect.width / 2,
          y: anchorRect.top + anchorRect.height / 2,
        }
      }
      const firstPoint = pointAtAnchor()
      calendar.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' })
      )
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      const secondPoint = pointAtAnchor()
      if (firstPoint.x === secondPoint.x && firstPoint.y === secondPoint.y) {
        throw new Error('Activity keyboard navigation did not move the anchor')
      }

      const before = canvas.toDataURL()
      const startedAt = performance.now()
      const points = [firstPoint, secondPoint]
      let tooltipMountedFrames = 0
      let tooltipPositionChanges = 0
      let tooltipTextChanges = 0
      let previousTooltipText = tooltip.textContent
      let previousTooltipRect = tooltip.getBoundingClientRect()
      for (let frame = 0; frame < 120; frame += 1) {
        for (let step = 0; step < 7; step += 1) {
          const point = points[(frame + step) % points.length]
          if (!point) throw new Error('Activity pointer target is unavailable')
          calendar.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              clientX: point.x,
              clientY: point.y,
              pointerType: 'mouse',
            })
          )
        }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
        const currentTooltip =
          document.querySelector<HTMLElement>('[role="tooltip"]')
        if (currentTooltip === tooltip) tooltipMountedFrames += 1
        const currentTooltipText = tooltip.textContent
        if (currentTooltipText !== previousTooltipText) {
          tooltipTextChanges += 1
        }
        previousTooltipText = currentTooltipText
        const currentTooltipRect = tooltip.getBoundingClientRect()
        if (
          currentTooltipRect.left !== previousTooltipRect.left ||
          currentTooltipRect.top !== previousTooltipRect.top
        ) {
          tooltipPositionChanges += 1
        }
        previousTooltipRect = currentTooltipRect
      }
      calendar.dispatchEvent(
        new PointerEvent('pointerout', {
          bubbles: true,
          pointerType: 'mouse',
          relatedTarget: document.body,
        })
      )
      const elapsedMs = performance.now() - startedAt
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      await new Promise<void>((resolve) => window.setTimeout(resolve, 350))
      return {
        elapsedMs,
        repaintCount,
        pixelsStable: before === canvas.toDataURL(),
        tooltipCountAfterSettle:
          document.querySelectorAll('[role="tooltip"]').length,
        tooltipMountedFrames,
        tooltipPositionChanges,
        tooltipTextChanges,
        resizeObserverLoopErrors,
      }
    } finally {
      contextPrototype.clearRect = originalClearRect
      window.removeEventListener('error', captureResizeObserverLoopError)
    }
  })
}

async function resizeFrameProfile(page: Page): Promise<ResizeFrameProfile> {
  return page.getByTestId('activity-calendar').evaluate(async (calendar) => {
    const canvas = calendar.querySelector<HTMLCanvasElement>(
      '[data-testid="activity-canvas"]'
    )
    if (!canvas) throw new Error('Activity Canvas is unavailable')

    const contextPrototype = CanvasRenderingContext2D.prototype
    const originalClearRect = contextPrototype.clearRect
    const originalRequestAnimationFrame = window.requestAnimationFrame
    const samples: number[] = []
    let clearCount = 0

    contextPrototype.clearRect = function patchedClearRect(...args) {
      if (this.canvas === canvas) clearCount += 1
      return originalClearRect.apply(this, args)
    }
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      originalRequestAnimationFrame.call(window, (timestamp) => {
        const clearsBefore = clearCount
        const startedAt = performance.now()
        callback(timestamp)
        if (clearCount > clearsBefore) {
          samples.push(performance.now() - startedAt)
        }
      })

    const waitForFrame = () =>
      new Promise<void>((resolve) => {
        originalRequestAnimationFrame.call(window, () => resolve())
      })
    const waitForDraw = async (previousCount: number) => {
      for (let frame = 0; frame < 12; frame += 1) {
        await waitForFrame()
        if (samples.length > previousCount) return
      }
      throw new Error('Activity calendar did not redraw after a size change')
    }
    const originalWidth = (calendar as HTMLElement).style.width
    const baseWidth = calendar.clientWidth

    try {
      await waitForFrame()
      await waitForFrame()
      for (let index = 0; index < 20; index += 1) {
        ;(calendar as HTMLElement).style.width =
          `${baseWidth - 10 - (index % 10)}px`
      }
      void calendar.getBoundingClientRect().width
      await waitForDraw(0)
      await waitForFrame()
      await waitForFrame()
      const coalescedFrames = samples.length
      samples.length = 0

      for (let index = 0; index < 40; index += 1) {
        const previousCount = samples.length
        ;(calendar as HTMLElement).style.width =
          `${baseWidth - 10 - (index % 2) * 10}px`
        void calendar.getBoundingClientRect().width
        await waitForDraw(previousCount)
      }

      samples.sort((left, right) => left - right)
      return {
        p95Ms:
          samples[Math.floor(samples.length * 0.95)] ??
          Number.POSITIVE_INFINITY,
        coalescedFrames,
        measuredFrames: samples.length,
      }
    } finally {
      ;(calendar as HTMLElement).style.width = originalWidth
      await waitForFrame()
      await waitForFrame()
      contextPrototype.clearRect = originalClearRect
      window.requestAnimationFrame = originalRequestAnimationFrame
    }
  })
}

async function dprTransitionProfile(page: Page): Promise<DprTransitionProfile> {
  return page.getByTestId('activity-calendar').evaluate(async (calendar) => {
    const canvas = calendar.querySelector<HTMLCanvasElement>(
      '[data-testid="activity-canvas"]'
    )
    if (!canvas) throw new Error('Activity Canvas is unavailable')

    const probe = (
      window as unknown as {
        __motrixActivityDprProbe?: { trigger: () => number }
      }
    ).__motrixActivityDprProbe
    if (!probe) throw new Error('DPR change probe is unavailable')

    const contextPrototype = CanvasRenderingContext2D.prototype
    const originalClearRect = contextPrototype.clearRect
    const originalRequestAnimationFrame = window.requestAnimationFrame
    const frameSamples: number[] = []
    const handlerSamples: number[] = []
    const workSamples: number[] = []
    const listenerCounts: number[] = []
    let clearCount = 0

    contextPrototype.clearRect = function patchedClearRect(...args) {
      if (this.canvas === canvas) clearCount += 1
      return originalClearRect.apply(this, args)
    }
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      originalRequestAnimationFrame.call(window, (timestamp) => {
        const clearsBefore = clearCount
        const startedAt = performance.now()
        callback(timestamp)
        if (clearCount > clearsBefore) {
          frameSamples.push(performance.now() - startedAt)
        }
      })

    const waitForFrame = () =>
      new Promise<void>((resolve) => {
        originalRequestAnimationFrame.call(window, () => resolve())
      })
    const waitForDraw = async (previousCount: number) => {
      for (let frame = 0; frame < 12; frame += 1) {
        await waitForFrame()
        if (frameSamples.length > previousCount) return
      }
      throw new Error('DPR change did not redraw the Activity calendar')
    }

    try {
      for (let index = 0; index < 40; index += 1) {
        const previousCount = frameSamples.length
        const handlerStartedAt = performance.now()
        const listenerCount = probe.trigger()
        const handlerMs = performance.now() - handlerStartedAt
        listenerCounts.push(listenerCount)
        handlerSamples.push(handlerMs)
        await waitForDraw(previousCount)
        await waitForFrame()
        await waitForFrame()
        if (frameSamples.length !== previousCount + 1) {
          throw new Error('DPR change must schedule exactly one render frame')
        }
        workSamples.push(
          handlerMs + (frameSamples[previousCount] ?? Number.POSITIVE_INFINITY)
        )
      }

      handlerSamples.sort((left, right) => left - right)
      workSamples.sort((left, right) => left - right)
      return {
        p95Ms:
          workSamples[Math.floor(workSamples.length * 0.95)] ??
          Number.POSITIVE_INFINITY,
        handlerP95Ms:
          handlerSamples[Math.floor(handlerSamples.length * 0.95)] ??
          Number.POSITIVE_INFINITY,
        measuredFrames: frameSamples.length,
        listenerCounts,
      }
    } finally {
      contextPrototype.clearRect = originalClearRect
      window.requestAnimationFrame = originalRequestAnimationFrame
    }
  })
}

async function canvasDprRatio(page: Page): Promise<number> {
  return page.getByTestId('activity-canvas').evaluate((canvas) => {
    const cssWidth = Number.parseFloat(
      (canvas as HTMLCanvasElement).style.width
    )
    return (canvas as HTMLCanvasElement).width / cssWidth
  })
}

async function themeFrameP95(page: Page): Promise<number> {
  return page.getByTestId('activity-calendar').evaluate(async (calendar) => {
    const canvas = calendar.querySelector<HTMLCanvasElement>(
      '[data-testid="activity-canvas"]'
    )
    if (!canvas) throw new Error('Activity Canvas is unavailable')

    const contextPrototype = CanvasRenderingContext2D.prototype
    const originalClearRect = contextPrototype.clearRect
    const originalRequestAnimationFrame = window.requestAnimationFrame
    const samples: number[] = []
    let clearCount = 0

    contextPrototype.clearRect = function patchedClearRect(...args) {
      if (this.canvas === canvas) clearCount += 1
      return originalClearRect.apply(this, args)
    }
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      originalRequestAnimationFrame.call(window, (timestamp) => {
        const clearsBefore = clearCount
        const startedAt = performance.now()
        callback(timestamp)
        if (clearCount > clearsBefore) {
          samples.push(performance.now() - startedAt)
        }
      })

    const waitForThreeFrames = () =>
      new Promise<void>((resolve) => {
        originalRequestAnimationFrame.call(window, () => {
          originalRequestAnimationFrame.call(window, () => {
            originalRequestAnimationFrame.call(window, () => resolve())
          })
        })
      })
    const originalTheme = localStorage.getItem('theme') ?? 'system'
    const setTheme = (theme: 'light' | 'dark' | 'system') => {
      const oldValue = localStorage.getItem('theme')
      localStorage.setItem('theme', theme)
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'theme',
          oldValue,
          newValue: theme,
        })
      )
    }

    try {
      for (let index = 0; index < 20; index += 1) {
        setTheme(index % 2 === 0 ? 'dark' : 'light')
        await waitForThreeFrames()
      }
      samples.sort((left, right) => left - right)
      return (
        samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY
      )
    } finally {
      setTheme(
        originalTheme === 'dark' || originalTheme === 'light'
          ? originalTheme
          : 'system'
      )
      await waitForThreeFrames()
      contextPrototype.clearRect = originalClearRect
      window.requestAnimationFrame = originalRequestAnimationFrame
    }
  })
}

async function nudgeCalendarSize(page: Page): Promise<void> {
  await page.getByTestId('activity-calendar').evaluate(async (calendar) => {
    const element = calendar as HTMLElement
    const originalWidth = element.style.width
    const width = element.clientWidth
    const waitForFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    element.style.width = `${Math.max(1, width - 1)}px`
    await waitForFrame()
    await waitForFrame()
    element.style.width = originalWidth
    await waitForFrame()
    await waitForFrame()
  })
}

async function heapUsed(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage')
  const usage = await cdp.send('Runtime.getHeapUsage')
  return usage.usedSize
}

test.describe('Activity Tile production renderer', () => {
  test('adapts every span and profiles Canvas interactions', async ({
    electronApp,
    mainWindow,
    userDataDir,
  }, testInfo) => {
    test.setTimeout(300_000)
    await mainWindow.waitForLoadState('domcontentloaded')
    await installDprChangeProbe(mainWindow)
    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (window) => !window.webContents.getURL().includes('w=add-task')
      )
      main?.setSize(1_440, 900, false)
    })
    const richActivitySeed = buildRichActivitySeed()
    expect(
      await seedRichActivityHistory(electronApp, userDataDir, richActivitySeed)
    ).toBe(richActivitySeed.events.length)
    const fixtureProfile = await readActivityFixtureProfile(mainWindow)
    expect(fixtureProfile.activeDays).toBeGreaterThan(80)
    expect(fixtureProfile.submittedOnlyDays).toBeGreaterThanOrEqual(5)
    expect(fixtureProfile.recoveredCompletions).toBeGreaterThanOrEqual(5)
    expect(fixtureProfile.depthDays.every((dayCount) => dayCount >= 10)).toBe(
      true
    )
    await updateAppearance(mainWindow, 'light', 'en-US')

    for (const span of SUPPORTED_SPANS) {
      await updateActivityLayout(mainWindow, span)
      await reloadActivity(mainWindow)
      await expect(
        mainWindow
          .getByTestId('activity-calendar')
          .getByRole('gridcell', { includeHidden: true })
      ).toHaveCount(1)

      const profile = await readRendererProfile(mainWindow)
      const placement = await mainWindow
        .getByTestId('dashboard-tile-activity')
        .evaluate((tile) => ({
          column: (tile as HTMLElement).style.getPropertyValue(
            '--dashboard-grid-column'
          ),
          row: (tile as HTMLElement).style.getPropertyValue(
            '--dashboard-grid-row'
          ),
        }))
      expect(profile.canvasCount).toBe(1)
      expect(profile.virtualCellCount).toBe(1)
      expect(profile.ariaRows).toBe('7')
      expect(Number(profile.ariaColumns)).toBe(expectedWeeks(span))
      expect(placement.column).toBe(`1 / span ${span.w}`)
      expect(placement.row).toBe(`1 / span ${span.h}`)
      expect(profile.calendarScrollWidth).toBeLessThanOrEqual(
        profile.calendarClientWidth + 1
      )
      expect(profile.canvasCssWidth).toBeLessThanOrEqual(
        profile.calendarClientWidth + 1
      )

      if (span.w === 4 && span.h === 2) {
        await expect(mainWindow.locator('html')).toHaveClass(/light/)
        expect(profile.weekdayLabels).toEqual(['Mon', 'Wed', 'Fri'])
        if (profile.monthLabels.length > 1) {
          expect(profile.monthLabels.at(-1)).not.toBe(profile.monthLabels.at(0))
        }
        await mainWindow.getByTestId('dashboard-tile-activity').screenshot({
          path: testInfo.outputPath('activity-4x2-light-en.png'),
        })
      }
    }

    const calendar = mainWindow.getByTestId('activity-calendar')
    await calendar.focus()
    await expect(mainWindow.getByRole('tooltip')).toBeVisible()
    await expect(mainWindow.getByRole('tooltip')).toContainText(
      /8 completed on/
    )
    await expect(mainWindow.getByRole('tooltip')).toContainText('10 submitted')
    await expect(mainWindow.getByRole('tooltip')).toContainText('2 recovered')
    const keyboardTooltip = await mainWindow.getByRole('tooltip').innerText()
    expect(keyboardTooltip.length).toBeLessThan(180)

    const activeOverlay = mainWindow.getByTestId('activity-focus-overlay')
    const calendarBox = await calendar.boundingBox()
    const edgeCell = await activeOverlay.evaluate((element) => ({
      left: Number.parseFloat(element.style.left),
      top: Number.parseFloat(element.style.top),
      width: Number.parseFloat(element.style.width),
      height: Number.parseFloat(element.style.height),
    }))
    expect(edgeCell.width).toBeGreaterThanOrEqual(10)
    expect(edgeCell.height).toBeGreaterThanOrEqual(10)
    await mainWindow.keyboard.press('ArrowLeft')
    await expect(mainWindow.getByRole('tooltip')).toContainText(
      /4 completed on/
    )
    const adjacentCell = await activeOverlay.evaluate((element) => ({
      left: Number.parseFloat(element.style.left),
      top: Number.parseFloat(element.style.top),
      width: Number.parseFloat(element.style.width),
      height: Number.parseFloat(element.style.height),
    }))
    await mainWindow.keyboard.press('ArrowRight')
    await expect(mainWindow.getByRole('tooltip')).toContainText(
      /8 completed on/
    )
    if (!calendarBox) throw new Error('Activity calendar is not visible')

    await calendar.evaluate((element) => (element as HTMLElement).blur())
    await mainWindow.mouse.move(1, 1)
    await expect(mainWindow.getByRole('tooltip')).toBeHidden()
    await mainWindow.mouse.move(
      calendarBox.x + edgeCell.left + edgeCell.width / 2,
      calendarBox.y + edgeCell.top + edgeCell.height / 2
    )
    await mainWindow.waitForTimeout(150)
    await expect(mainWindow.getByRole('tooltip')).toBeHidden()

    const pointerTooltip = mainWindow.getByRole('tooltip')
    await expect(pointerTooltip).toBeVisible({ timeout: 500 })
    await expect(pointerTooltip).toContainText(/completed on/)
    const pointerTooltipText = await pointerTooltip.innerText()
    await pointerTooltip.evaluate((element) => {
      element.setAttribute('data-activity-retarget-probe', 'mounted')
    })

    await mainWindow.mouse.move(
      calendarBox.x + adjacentCell.left + adjacentCell.width / 2,
      calendarBox.y + adjacentCell.top + adjacentCell.height / 2,
      { steps: 3 }
    )
    await expect(pointerTooltip).toBeVisible({ timeout: 200 })
    await expect(pointerTooltip).toHaveAttribute(
      'data-activity-retarget-probe',
      'mounted'
    )
    await expect
      .poll(() => pointerTooltip.innerText())
      .not.toBe(pointerTooltipText)
    const clickedTooltipText = await pointerTooltip.innerText()
    await mainWindow.mouse.click(
      calendarBox.x + adjacentCell.left + adjacentCell.width / 2,
      calendarBox.y + adjacentCell.top + adjacentCell.height / 2
    )
    await expect(calendar).toBeFocused()
    await expect(pointerTooltip).toHaveAttribute(
      'data-activity-retarget-probe',
      'mounted'
    )
    await mainWindow.mouse.move(
      calendarBox.x + edgeCell.left + edgeCell.width / 2,
      calendarBox.y + edgeCell.top + edgeCell.height / 2,
      { steps: 3 }
    )
    await expect(pointerTooltip).toBeVisible({ timeout: 200 })
    await expect(pointerTooltip).toHaveAttribute(
      'data-activity-retarget-probe',
      'mounted'
    )
    await expect
      .poll(() => pointerTooltip.innerText())
      .not.toBe(clickedTooltipText)
    const pointerTooltipMotion = await pointerTooltip.evaluate((element) => ({
      animationName: getComputedStyle(element).animationName,
      transitionProperty: getComputedStyle(element).transitionProperty,
      activeAnimations: element.getAnimations().length,
    }))
    expect(pointerTooltipMotion.animationName).toBe('none')
    expect(pointerTooltipMotion.transitionProperty).toBe('none')
    expect(pointerTooltipMotion.activeAnimations).toBe(0)
    await mainWindow.keyboard.press('Escape')
    await expect(pointerTooltip).toBeHidden({ timeout: 200 })
    await expect(calendar).toBeFocused()
    await expect(activeOverlay).toBeVisible()
    await mainWindow.keyboard.press('ArrowLeft')
    await expect(mainWindow.getByRole('tooltip')).toBeVisible()
    await calendar.evaluate((element) => (element as HTMLElement).blur())
    await mainWindow.mouse.move(1, 1)
    await expect(pointerTooltip).toBeHidden({ timeout: 200 })
    await expect(
      mainWindow.locator('[role="tooltip"][data-closed]')
    ).toHaveCount(0)

    await mainWindow.getByRole('button', { name: 'Configure' }).click()
    await expect(calendar).toHaveAttribute('aria-disabled', 'true')
    await expect(calendar).toHaveAttribute('tabindex', '-1')
    await expect(mainWindow.getByRole('tooltip')).toBeHidden()

    let activityTile = mainWindow.getByTestId('dashboard-tile-activity')
    await activityTile.getByRole('button', { name: 'Tile size' }).click()
    await mainWindow
      .getByRole('menuitemradio', { name: /2\s*[×x]\s*1/i })
      .click()
    await expect(calendar).toHaveAttribute('aria-colcount', '13')

    const dragHandle = activityTile.getByRole('button', { name: 'Drag tile' })
    const dragBox = await dragHandle.boundingBox()
    const gridBox = await mainWindow.getByTestId('dashboard-grid').boundingBox()
    if (!dragBox || !gridBox) throw new Error('Dashboard drag geometry missing')
    await mainWindow.mouse.move(
      dragBox.x + dragBox.width / 2,
      dragBox.y + dragBox.height / 2
    )
    await mainWindow.mouse.down()
    await mainWindow.mouse.move(
      gridBox.x + gridBox.width * 0.375,
      gridBox.y + gridBox.height * 0.5,
      { steps: 4 }
    )
    await mainWindow.waitForTimeout(100)
    await mainWindow.mouse.up()
    await expect
      .poll(() =>
        activityTile.evaluate((tile) => ({
          column: (tile as HTMLElement).style.getPropertyValue(
            '--dashboard-grid-column'
          ),
          row: (tile as HTMLElement).style.getPropertyValue(
            '--dashboard-grid-row'
          ),
        }))
      )
      .toEqual({ column: '1 / span 2', row: '2 / span 1' })

    await activityTile.getByRole('button', { name: 'Remove tile' }).click()
    await expect(activityTile).toHaveCount(0)
    await mainWindow.getByRole('button', { name: 'Add' }).click()
    await mainWindow.getByRole('menuitem', { name: /Activity/i }).click()
    activityTile = mainWindow.getByTestId('dashboard-tile-activity')
    await expect(activityTile).toBeVisible()
    await mainWindow.keyboard.press('Escape')
    await expect(mainWindow.getByRole('menu', { name: 'Add' })).toBeHidden()

    await mainWindow.getByRole('button', { name: 'Cancel' }).click()
    await expect(activityTile.getByTestId('activity-calendar')).toHaveAttribute(
      'aria-colcount',
      '53'
    )

    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (window) => !window.webContents.getURL().includes('w=add-task')
      )
      main?.setSize(920, 720, false)
    })
    await expect(mainWindow.getByTestId('activity-calendar')).toBeVisible()
    await expect
      .poll(async () => {
        const profile = await readRendererProfile(mainWindow)
        return (
          profile.calendarScrollWidth <= profile.calendarClientWidth + 1 &&
          profile.canvasCssWidth <= profile.calendarClientWidth + 1
        )
      })
      .toBe(true)
    const narrow = await readRendererProfile(mainWindow)
    expect(narrow.calendarScrollWidth).toBeLessThanOrEqual(
      narrow.calendarClientWidth + 1
    )
    const referenceCard = mainWindow
      .getByTestId('dashboard-tile-activity')
      .locator('.dashboard-tile')
    const originalReferenceStyle = await referenceCard.evaluate((element) => ({
      width: (element as HTMLElement).style.width,
      height: (element as HTMLElement).style.height,
    }))
    await referenceCard.evaluate((element) => {
      const card = element as HTMLElement
      card.style.width = '690px'
      card.style.height = '172px'
    })
    const referenceCalendar = mainWindow.getByTestId('activity-calendar')
    await expect
      .poll(() =>
        referenceCalendar.evaluate((element) => ({
          width: element.clientWidth,
          height: element.clientHeight,
        }))
      )
      .toEqual({ width: 658, height: 120 })
    await expect
      .poll(() =>
        referenceCalendar
          .getByTestId('activity-canvas')
          .evaluate((element) => ({
            width: Number.parseFloat((element as HTMLElement).style.width),
            height: Number.parseFloat((element as HTMLElement).style.height),
          }))
      )
      .toEqual({ width: 658, height: 120 })
    await referenceCalendar.focus()
    await mainWindow.keyboard.press('Escape')
    await expect(mainWindow.getByRole('tooltip')).toBeHidden()
    const referenceCellSize = await mainWindow
      .getByTestId('activity-focus-overlay')
      .evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          left: Number.parseFloat((element as HTMLElement).style.left),
          top: Number.parseFloat((element as HTMLElement).style.top),
          width: Number.parseFloat(element.style.width),
          height: Number.parseFloat(element.style.height),
          renderedWidth: rect.width,
          renderedHeight: rect.height,
          renderedRight: rect.right,
          renderedBottom: rect.bottom,
          boxSizing: getComputedStyle(element).boxSizing,
          borderRadius: getComputedStyle(element).borderRadius,
          borderWidth: getComputedStyle(element).borderWidth,
          borderStyle: getComputedStyle(element).borderStyle,
          boxShadow: getComputedStyle(element).boxShadow,
          transitionDuration: getComputedStyle(element).transitionDuration,
        }
      })
    const referenceCalendarBounds = await referenceCalendar.evaluate(
      (element) => {
        const rect = element.getBoundingClientRect()
        return { right: rect.right, bottom: rect.bottom }
      }
    )
    expect(referenceCellSize.width).toBe(9)
    expect(referenceCellSize.height).toBe(9)
    expect(referenceCellSize.renderedWidth).toBe(9)
    expect(referenceCellSize.renderedHeight).toBe(9)
    expect(referenceCellSize.left + referenceCellSize.width).toBe(657)
    expect(
      referenceCellSize.top + referenceCellSize.height
    ).toBeLessThanOrEqual(120)
    expect(referenceCellSize.renderedRight).toBeLessThanOrEqual(
      referenceCalendarBounds.right
    )
    expect(referenceCellSize.renderedBottom).toBeLessThanOrEqual(
      referenceCalendarBounds.bottom
    )
    expect(referenceCellSize.boxSizing).toBe('border-box')
    expect(referenceCellSize.borderRadius).toBe('2px')
    expect(referenceCellSize.borderWidth).toBe('1px')
    expect(referenceCellSize.borderStyle).toBe('solid')
    expect(referenceCellSize.boxShadow).toBe('none')
    expect(referenceCellSize.transitionDuration).toBe('0s')
    await referenceCard.screenshot({
      path: testInfo.outputPath('activity-690x172-focused-light-en.png'),
    })
    await referenceCalendar.evaluate((element) =>
      (element as HTMLElement).blur()
    )
    await referenceCard.screenshot({
      path: testInfo.outputPath('activity-690x172-light-en.png'),
    })
    await referenceCard.evaluate((element, style) => {
      const card = element as HTMLElement
      card.style.width = style.width
      card.style.height = style.height
    }, originalReferenceStyle)
    await expect
      .poll(() => referenceCalendar.evaluate((element) => element.clientWidth))
      .toBe(narrow.calendarClientWidth)

    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (window) => !window.webContents.getURL().includes('w=add-task')
      )
      main?.setSize(1_440, 900, false)
    })
    await updateAppearance(mainWindow, 'dark', 'zh-CN')
    await reloadActivity(mainWindow)
    await expect(
      mainWindow
        .getByTestId('dashboard-tile-activity')
        .getByText('活动', { exact: true })
    ).toBeVisible()
    await expect(mainWindow.locator('html')).toHaveClass(/dark/)
    const chinese = await readRendererProfile(mainWindow)
    expect(chinese.weekdayLabels).toEqual(['周一', '周三', '周五'])
    await mainWindow.getByTestId('dashboard-tile-activity').screenshot({
      path: testInfo.outputPath('activity-4x2-dark-zh.png'),
    })

    await updateAppearance(mainWindow, 'system', 'en-US')
    await reloadActivity(mainWindow)
    const configuredTheme = await mainWindow.evaluate(async () => {
      const api = (
        window as unknown as {
          motrix?: {
            invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
          }
        }
      ).motrix
      if (!api) throw new Error('Motrix preload API is unavailable')
      const settings = (await api.invoke('query:getSettings')) as {
        app: { theme: string }
      }
      return settings.app.theme
    })
    expect(configuredTheme).toBe('system')
    await expect(mainWindow.locator('html')).toHaveClass(/\b(?:light|dark)\b/)
    const cdp = await mainWindow.context().newCDPSession(mainWindow)
    await cdp.send('HeapProfiler.enable')
    const viewport = await mainWindow.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    const dprRatios: number[] = []
    const resizeFrameProfiles: ResizeFrameProfile[] = []
    const dprTransitionProfiles: DprTransitionProfile[] = []
    for (const deviceScaleFactor of [1, 2]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        ...viewport,
        deviceScaleFactor,
        mobile: false,
      })
      // CDP's emulated DPR does not dispatch the same MediaQueryList change
      // event as moving a real Electron window between displays. A one-pixel
      // ResizeObserver nudge exercises the same scheduled render frame with
      // the newly exposed window.devicePixelRatio.
      await nudgeCalendarSize(mainWindow)
      await expect
        .poll(() => canvasDprRatio(mainWindow))
        .toBeCloseTo(deviceScaleFactor, 1)
      dprRatios.push(await canvasDprRatio(mainWindow))
      dprTransitionProfiles.push(await dprTransitionProfile(mainWindow))
      resizeFrameProfiles.push(await resizeFrameProfile(mainWindow))
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await nudgeCalendarSize(mainWindow)
    const mountedRedrawP95Ms = Math.max(
      ...resizeFrameProfiles.map((profile) => profile.p95Ms)
    )
    const dprTransitionP95Ms = Math.max(
      ...dprTransitionProfiles.map((profile) => profile.p95Ms)
    )
    const themeP95Ms = await themeFrameP95(mainWindow)
    const heapBefore = await heapUsed(cdp)
    const pointer = await pointerProfile(mainWindow)
    const heapAfter = await heapUsed(cdp)
    const finalProfile = await readRendererProfile(mainWindow)
    const retainedHeapBytes = Math.max(0, heapAfter - heapBefore)

    expect(pointer.repaintCount).toBe(0)
    expect(pointer.pixelsStable).toBe(true)
    expect(pointer.tooltipCountAfterSettle).toBe(0)
    expect(pointer.tooltipMountedFrames).toBe(120)
    expect(pointer.tooltipPositionChanges).toBeGreaterThan(0)
    expect(pointer.tooltipTextChanges).toBe(120)
    expect(pointer.resizeObserverLoopErrors).toEqual([])
    expect(
      resizeFrameProfiles.every((profile) => profile.coalescedFrames === 1)
    ).toBe(true)
    expect(
      resizeFrameProfiles.every((profile) => profile.measuredFrames >= 35)
    ).toBe(true)
    expect(
      dprTransitionProfiles.every((profile) => profile.measuredFrames === 40)
    ).toBe(true)
    expect(
      dprTransitionProfiles.every((profile) =>
        profile.listenerCounts.every((count) => count === 1)
      )
    ).toBe(true)
    expect(finalProfile.canvasCount).toBe(1)
    expect(finalProfile.tooltipCount).toBeLessThanOrEqual(1)
    expect(
      Number(finalProfile.ariaRows) * Number(finalProfile.ariaColumns)
    ).toBe(371)

    // Reference-machine budgets are opt-in, not portable CI assertions.
    if (ENFORCE_REFERENCE_BUDGETS) {
      // The mounted render-frame measurement includes production
      // drawActivityCanvas, geometry selection, and state scheduling.
      expect(mountedRedrawP95Ms).toBeLessThan(4)
      expect(mountedRedrawP95Ms).toBeLessThan(8)
      // This additionally includes the production matchMedia change handler
      // and resolution-query rebind before its exactly-one mounted draw.
      expect(dprTransitionP95Ms).toBeLessThan(8)
      expect(themeP95Ms).toBeLessThan(8)
      expect(retainedHeapBytes).toBeLessThanOrEqual(1_048_576)
    }

    console.log(
      `[activity-renderer-profile] ${JSON.stringify({
        mountedRedrawP95Ms,
        resizeFrameP95Ms: resizeFrameProfiles.map((profile) => profile.p95Ms),
        dprTransitionP95Ms: dprTransitionProfiles.map(
          (profile) => profile.p95Ms
        ),
        dprHandlerP95Ms: dprTransitionProfiles.map(
          (profile) => profile.handlerP95Ms
        ),
        themeFrameP95Ms: themeP95Ms,
        coalescedResizeFrames: resizeFrameProfiles.map(
          (profile) => profile.coalescedFrames
        ),
        pointerSweepMs: pointer.elapsedMs,
        retainedHeapBytes,
        dprRatios,
        ariaDays:
          Number(finalProfile.ariaRows) * Number(finalProfile.ariaColumns),
      })}`
    )
  })
})
