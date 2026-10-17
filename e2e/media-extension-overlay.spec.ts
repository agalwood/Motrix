import { existsSync } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
} from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations'
import {
  type DownloadTask,
  TaskKind,
  TaskStatus,
} from '../src/shared/types/task'
import {
  launchMotrix,
  test,
  waitForEngineReady,
  waitForQueryHandlers,
} from './fixtures/electron-app'

/**
 * Real Chromium + the built Motrix extension on a real YouTube video — the
 * browser-only path: no Add-Task window, everything driven from the page.
 *
 * Opt-in because it needs a built extension, a Chromium binary, and outbound
 * network access to YouTube:
 *
 *   MOTRIX_EXTENSION_BUILD=<repo>/dist/chromium \
 *   MOTRIX_CHROMIUM_EXECUTABLE=/path/to/chrome \
 *   MOTRIX_LIVE_NETWORK_TESTS=1 \
 *   pnpm exec playwright test e2e/media-extension-overlay.spec.ts --headed
 *
 * Leg 1 proves the in-page grab overlay renders and anchors to the playing
 * <video> (the "download this video" popup on the player) with no backend.
 * Leg 2 pairs the extension with the freshly launched App, then submits a real
 * download from the overlay and waits for the desktop to finish it.
 *
 * The overlay lives in a CLOSED shadow root by design, so its internals are
 * unreachable from page JS and from Playwright's locators. Both legs therefore
 * pierce the shadow tree through the Chrome DevTools Protocol.
 */

const extensionBuild = process.env.MOTRIX_EXTENSION_BUILD?.trim() ?? ''
const liveNetwork = process.env.MOTRIX_LIVE_NETWORK_TESTS === '1'
const YOUTUBE_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'

function chromiumExecutable(): string | undefined {
  const configured = process.env.MOTRIX_CHROMIUM_EXECUTABLE?.trim()
  if (configured) return configured
  try {
    return chromium.executablePath()
  } catch {
    return undefined
  }
}

const chrome = chromiumExecutable()
const extensionReady =
  extensionBuild.length > 0 &&
  existsSync(path.join(extensionBuild, 'manifest.json'))
const browserReady = chrome !== undefined && existsSync(chrome)

test.describe('real Chromium extension overlay', () => {
  test.skip(
    !liveNetwork,
    'Live network acceptance — set MOTRIX_LIVE_NETWORK_TESTS=1'
  )
  test.skip(
    !extensionReady,
    'MOTRIX_EXTENSION_BUILD must point at a built Chromium extension'
  )
  test.skip(!browserReady, 'No Chromium executable available')

  test.setTimeout(300_000)

  test('grab overlay pill renders anchored on a playing YouTube video', async ({
    userDataDir,
  }, testInfo) => {
    const context = await launchExtension(userDataDir)
    try {
      const page = await context.newPage()
      await openYouTube(page)
      await waitForOverlay(page)

      const anchor = await expect
        .poll(() => overlayPillAnchor(page), { timeout: 30_000 })
        .not.toBeNull()
        .then(() => overlayPillAnchor(page))
      expect(anchor).not.toBeNull()
      if (!anchor) return

      // The pill sits inside the video's box (allowing the 12px inset), i.e.
      // it is painted on the player rather than floating in a page corner.
      expect(anchor.pill.left).toBeGreaterThanOrEqual(anchor.video.left - 2)
      expect(anchor.pill.right).toBeLessThanOrEqual(anchor.video.right + 2)
      expect(anchor.pill.top).toBeGreaterThanOrEqual(anchor.video.top - 2)
      expect(anchor.pill.bottom).toBeLessThanOrEqual(anchor.video.bottom + 2)
      expect(anchor.pill.width).toBeGreaterThan(40)
      await page.screenshot({
        path: testInfo.outputPath('grab-overlay-on-video.png'),
      })

      // Clicking the pill opens the popup panel ("Download with Motrix").
      expect(await openOverlayPanel(page, anchor)).toBe(true)
      await page.screenshot({
        path: testInfo.outputPath('grab-overlay-panel.png'),
      })
    } finally {
      await context.close().catch(() => undefined)
    }
  })

  test('grab overlay downloads the video through the paired Motrix App', async ({
    userDataDir,
    rpcPort,
  }, testInfo) => {
    await writeSettings(userDataDir)
    const app = await launchMotrix({ userDataDir, rpcPort })
    const context = await launchExtension(userDataDir)
    try {
      const mainWindow = await app.firstWindow()
      await mainWindow.waitForLoadState('domcontentloaded')
      await waitForQueryHandlers(mainWindow)
      const boundPort = await readBridgePort(mainWindow)
      await pairExtension(mainWindow, context, boundPort)
      await waitForEngineReady(mainWindow)

      const page = await context.newPage()
      await openYouTube(page)
      await waitForOverlay(page)

      const anchor = await overlayPillAnchor(page)
      expect(anchor).not.toBeNull()
      if (!anchor) return
      await expect(await openOverlayPanel(page, anchor)).toBe(true)

      // The panel starts with the tab's sniffed streams and gains the
      // desktop's yt-dlp quality rows a moment later (one yt-dlp spawn), so
      // wait for a quality row before clicking. Prefer the smallest video so
      // the live download stays quick.
      let task: DownloadTask | null = null
      for (let attempt = 0; attempt < 3 && task === null; attempt += 1) {
        const rows = await waitForOverlayRows(page, 90_000, (candidates) =>
          candidates.some(isQualityRow)
        )
        const chosen =
          pickSmallestVideoRow(rows) ?? pickRow(rows, () => true) ?? null
        console.log(
          `[overlay] attempt ${attempt}: heading=${JSON.stringify(
            await overlayPanelHeading(page)
          )} chosen=${JSON.stringify(chosen?.label ?? null)} rows=` +
            JSON.stringify(rows.map((entry) => entry.label))
        )
        if (!chosen?.box) break
        await page.mouse.click(chosen.box.centerX, chosen.box.centerY)
        task = await waitForMediaTask(mainWindow, 45_000)
      }
      expect(task).not.toBeNull()
      if (!task) return
      expect([TaskKind.Mux, TaskKind.Direct]).toContain(task.kind)

      const finished = await waitForTaskTerminal(mainWindow, task.id)
      await page.screenshot({
        path: testInfo.outputPath('overlay-submitted.png'),
      })
      if (finished.status !== TaskStatus.Completed) {
        console.log(
          `[overlay] task failed: status=${finished.status} ` +
            `code=${finished.errorCode ?? '-'} message=${finished.errorMessage ?? '-'}`
        )
      }
      console.log(
        `[overlay] task ${JSON.stringify({
          name: finished.name,
          filename: finished.filename,
          finalPath: finished.finalPath,
          saveDir: finished.saveDir,
          sizeWhenDone: finished.sizeWhenDone,
        })}`
      )
      expect(finished.status).toBe(TaskStatus.Completed)

      // The browser alone produced a real file on disk.
      const file = await findMediaFile(finished)
      expect(file).not.toBeNull()
      console.log(`[overlay] downloaded -> ${file}`)
    } finally {
      await context.close().catch(() => undefined)
      await app.close().catch(() => undefined)
    }
  })
})

async function launchExtension(userDataDir: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(
    path.join(userDataDir, 'chromium-profile'),
    {
      executablePath: chrome,
      headless: false,
      locale: 'en-US',
      args: [
        `--disable-extensions-except=${extensionBuild}`,
        `--load-extension=${extensionBuild}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--lang=en-US',
        '--no-proxy-server',
        // The overlay anchors to a playing video, so let playback start
        // without a user gesture.
        '--autoplay-policy=no-user-gesture-required',
      ],
    }
  )
  // Wait until the MV3 service worker is up; without it the content script
  // never receives a snapshot and the overlay stays hidden.
  await (context.serviceWorkers()[0] ??
    context.waitForEvent('serviceworker', { timeout: 30_000 }))
  return context
}

async function writeSettings(userDataDir: string): Promise<void> {
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: { autofillClipboardLinks: false, browserBridgeEnabled: true },
      tracker: { autoSync: false },
      onboarding: { disclaimerAccepted: true },
      // Let the bridge take the first free candidate port; the test reads the
      // port it actually bound, so an unrelated local Motrix on an earlier
      // candidate does not break the run.
      bridge: { fixedPort: 'auto', instanceId: 'e2e-overlay' },
    }),
    { encoding: 'utf8', flag: 'wx' }
  )
}

/** The port the freshly launched bridge actually bound. */
async function readBridgePort(page: Page): Promise<number> {
  const status = await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const api = (
            window as unknown as {
              motrix: { invoke: (channel: string) => Promise<unknown> }
            }
          ).motrix
          try {
            return (await api.invoke('bridge:getStatus')) as {
              port: number | null
            }
          } catch {
            return null
          }
        }),
      { timeout: 30_000 }
    )
    .not.toBeNull()
    .then(() =>
      page.evaluate(async () => {
        const api = (
          window as unknown as {
            motrix: { invoke: (channel: string) => Promise<unknown> }
          }
        ).motrix
        return (await api.invoke('bridge:getStatus')) as { port: number | null }
      })
    )
  if (status.port === null) throw new Error('the bridge did not bind a port')
  return status.port
}

async function openYouTube(page: Page): Promise<void> {
  await page.goto(YOUTUBE_VIDEO, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  })
  await page.waitForSelector('video', { timeout: 90_000 })
  await page
    .evaluate(() => {
      const video = document.querySelector('video')
      if (!video) return
      video.muted = true
      void video.play().catch(() => undefined)
    })
    .catch(() => undefined)
}

async function waitForOverlay(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Boolean(document.getElementById('motrix-grab-overlay'))
        ),
      { timeout: 60_000 }
    )
    .toBe(true)
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  centerX: number
  centerY: number
}

interface OverlayAnchor {
  video: Box
  pill: Box
}

/**
 * Read the pill's box and the video's box from the CLOSED shadow tree via CDP.
 * `DOM.getDocument({pierce:true})` flattens shadow roots the page cannot see.
 */
async function overlayPillAnchor(page: Page): Promise<OverlayAnchor | null> {
  const pill = await findOverlayBox(page, (attrs) => attrs.class === 'pill')
  if (pill === null) return null
  const video = await page.evaluate(() => {
    const v = document.querySelector('video')
    if (!v) return null
    const r = v.getBoundingClientRect()
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      centerX: r.left + r.width / 2,
      centerY: r.top + r.height / 2,
    }
  })
  return video ? { video, pill } : null
}

async function overlayPanelVisible(page: Page): Promise<boolean> {
  return (
    (await findOverlayBox(page, (attrs) => attrs.class === 'panel')) !== null
  )
}

/**
 * Click the pill until the panel opens. The overlay re-renders on its 2s poll
 * (`wrap.replaceChildren()`) and repositions itself, so the pill's box is
 * re-read on every attempt and a lost click is retried.
 */
async function openOverlayPanel(
  page: Page,
  anchor: OverlayAnchor
): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await overlayPanelVisible(page)) return true
    const pill =
      (await findOverlayBox(page, (attrs) => attrs.class === 'pill')) ??
      anchor.pill
    await page.mouse.click(pill.centerX, pill.centerY)
    if (await overlayPanelVisible(page)) return true
    await page.waitForTimeout(1_000)
  }
  return false
}

interface CdpNode {
  nodeId: number
  attributes?: string[]
  children?: CdpNode[]
  shadowRoots?: CdpNode[]
  contentDocument?: CdpNode
}

function attrMap(raw: readonly string[] | undefined): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!raw) return attrs
  for (let i = 0; i + 1 < raw.length; i += 2) attrs[raw[i]] = raw[i + 1]
  return attrs
}

function childNodes(node: CdpNode): CdpNode[] {
  return [
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
    ...(node.contentDocument ? [node.contentDocument] : []),
  ]
}

function findByAttr(
  node: CdpNode,
  name: string,
  predicate: (value: string) => boolean
): CdpNode | null {
  const attrs = attrMap(node.attributes)
  if (attrs[name] !== undefined && predicate(attrs[name])) return node
  for (const child of childNodes(node)) {
    const hit = findByAttr(child, name, predicate)
    if (hit) return hit
  }
  return null
}

function collectByClass(
  node: CdpNode,
  predicate: (attrs: Record<string, string>) => boolean,
  out: CdpNode[]
): void {
  const attrs = attrMap(node.attributes)
  if (predicate(attrs)) out.push(node)
  for (const child of childNodes(node)) collectByClass(child, predicate, out)
}

function isRow(attrs: Record<string, string>): boolean {
  const classes = (attrs.class ?? '').split(' ')
  return classes.includes('row') && !classes.includes('note')
}

/** A `720p`-style desktop quality row (the MP3 row matches `audio`). */
function isQualityRow(row: OverlayRow): boolean {
  return /^(?:\d{3,4}p|MP3)\b/.test(row.label)
}

/** The smallest enabled video quality row (the list is tallest-first). */
function pickSmallestVideoRow(rows: OverlayRow[]): OverlayRow | null {
  return (
    [...rows]
      .reverse()
      .find((row) => /^\d{3,4}p\b/.test(row.label) && isClickable(row)) ?? null
  )
}

function isClickable(row: OverlayRow): boolean {
  return row.box !== null && !row.disabled
}

function pickRow(
  rows: OverlayRow[],
  predicate: (row: OverlayRow) => boolean
): OverlayRow | null {
  return (
    [...rows].reverse().find((row) => predicate(row) && isClickable(row)) ??
    null
  )
}

/**
 * Poll for the panel's rows until one satisfies `ready` (any laid-out row by
 * default), returning the very snapshot that satisfied the check — the overlay
 * re-renders every 2s, so a second read could observe a detached tree.
 */
async function waitForOverlayRows(
  page: Page,
  timeoutMs: number,
  ready: (rows: OverlayRow[]) => boolean = (rows) =>
    rows.some((row) => row.box !== null)
): Promise<OverlayRow[]> {
  const deadline = Date.now() + timeoutMs
  let rows: OverlayRow[] = []
  do {
    rows = await overlayRows(page)
    if (ready(rows)) return rows
    await page.waitForTimeout(500)
  } while (Date.now() < deadline)
  return rows
}

/**
 * The actionable rows in the open panel: label text plus layout box, read in
 * ONE CDP session (node ids are session-scoped). Quality rows are ordered
 * tallest first, so the last row is the smallest download (the MP3 row when
 * FFmpeg is present). Non-actionable `.note` rows are skipped.
 */
interface OverlayRow {
  label: string
  disabled: boolean
  box: Box | null
}

async function overlayRows(page: Page): Promise<OverlayRow[]> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('DOM.enable')
    const { root } = (await session.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    })) as { root: CdpNode }
    const host = findByAttr(
      root,
      'id',
      (value) => value === 'motrix-grab-overlay'
    )
    if (host === null) return []
    const matches: CdpNode[] = []
    collectByClass(host, isRow, matches)
    const rows: OverlayRow[] = []
    for (const node of matches) {
      const { outerHTML } = (await session
        .send('DOM.getOuterHTML', { nodeId: node.nodeId })
        .catch(() => ({ outerHTML: '' }))) as { outerHTML: string }
      const label = outerHTML
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const disabled = /\sdisabled(?:=""|\s|>)/.test(outerHTML)
      const model = (await session
        .send('DOM.getBoxModel', { nodeId: node.nodeId })
        .catch(() => null)) as { model?: { content: number[] } } | null
      const q = model?.model?.content
      rows.push({ label, disabled, box: q ? boxFromQuad(q) : null })
    }
    return rows
  } catch {
    return []
  } finally {
    await session.detach().catch(() => undefined)
  }
}

/** The panel's heading text — "Download with Motrix" vs the not-connected note. */
async function overlayPanelHeading(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('DOM.enable')
    const { root } = (await session.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    })) as { root: CdpNode }
    const host = findByAttr(
      root,
      'id',
      (value) => value === 'motrix-grab-overlay'
    )
    if (host === null) return ''
    const matches: CdpNode[] = []
    collectByClass(host, (attrs) => attrs.class === 'panel', matches)
    const panel = matches[0]
    if (panel === undefined) return ''
    const { outerHTML } = (await session.send('DOM.getOuterHTML', {
      nodeId: panel.nodeId,
    })) as { outerHTML: string }
    return /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(outerHTML)?.[1]?.trim() ?? ''
  } catch {
    return ''
  } finally {
    await session.detach().catch(() => undefined)
  }
}

function boxFromQuad(q: number[]): Box {
  const xs = [q[0], q[2], q[4], q[6]]
  const ys = [q[1], q[3], q[5], q[7]]
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  }
}

/**
 * Walk the CDP DOM snapshot (shadow roots included) in ONE session and return
 * the box of the first node inside the overlay host matching `predicate`.
 * Node ids are session-scoped, so the lookup and the box measurement must not
 * be split across two `DOM` sessions.
 */
async function findOverlayBox(
  page: Page,
  predicate: (attrs: Record<string, string>) => boolean
): Promise<Box | null> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('DOM.enable')
    const { root } = (await session.send('DOM.getDocument', {
      depth: -1,
      pierce: true,
    })) as { root: CdpNode }
    const host = findByAttr(
      root,
      'id',
      (value) => value === 'motrix-grab-overlay'
    )
    if (host === null) return null
    const matches: CdpNode[] = []
    collectByClass(host, predicate, matches)
    const node = matches[0]
    if (node === undefined) return null
    const model = (await session.send('DOM.getBoxModel', {
      nodeId: node.nodeId,
    })) as { model?: { content: number[] } }
    const q = model.model?.content
    return q ? boxFromQuad(q) : null
  } catch {
    // A node that lost its layout box (e.g. the panel closed mid-measure)
    // simply has no box to report.
    return null
  } finally {
    await session.detach().catch(() => undefined)
  }
}

/** Read the desktop's pending MBP1 extension pairing code, if any. */
async function readPairingCode(mainWindow: Page): Promise<string | null> {
  const pending = (await mainWindow.evaluate(async () => {
    const api = (
      window as unknown as {
        motrix: { invoke: (channel: string) => Promise<unknown> }
      }
    ).motrix
    return api.invoke('bridge:listPendingPairRequests')
  })) as Array<{ kind: string; code?: string }>
  return pending.find((request) => request.kind === 'extension')?.code ?? null
}

/**
 * Drive the extension options page to pair with the freshly launched desktop
 * App. Under MBP1 the desktop displays a code and the extension types it, so
 * the code is read from the desktop's Settings → Integration inbox.
 *
 * When other Motrix instances share the discovery range the extension shows an
 * instance picker; the test chooses the row for the port the launched App
 * actually bound.
 */
async function pairExtension(
  mainWindow: Page,
  context: BrowserContext,
  boundPort: number
): Promise<void> {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }))
  const extensionId = new URL(worker.url()).hostname

  // The desktop delivers the pairing code to its Settings → Integration
  // "pending approvals" inbox, so open it before starting the handshake.
  await mainWindow.getByRole('link', { name: 'Settings', exact: true }).click()
  await mainWindow.getByText('Integration', { exact: true }).first().click()

  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  await page.getByRole('tab', { name: 'Integration' }).click()
  await expect(
    page.getByRole('list', { name: 'Available Motrix backends' })
  ).toBeVisible()

  const pairButton = page.getByRole('button', { name: 'Pair', exact: true })
  await expect(pairButton).toBeEnabled({ timeout: 30_000 })
  await pairButton.click()

  // Choose our instance when the picker lists more than one; a single
  // candidate auto-proceeds.
  const row = page
    .getByRole('list', { name: 'Discovered Motrix instances' })
    .getByRole('listitem')
    .filter({ hasText: `Port ${boundPort}` })
  await row
    .getByRole('button', { name: 'Choose' })
    .click({ timeout: 20_000 })
    .catch(() => undefined)

  const code = await expect
    .poll(() => readPairingCode(mainWindow), { timeout: 60_000 })
    .not.toBeNull()
    .then(() => readPairingCode(mainWindow))
  if (code === null) throw new Error('the desktop did not issue a code')

  const dialog = page.getByRole('dialog', { name: 'Pair with Motrix' })
  await dialog.getByLabel(/Pairing code/i).fill(code.replace('-', ''))
  await dialog.getByRole('button', { name: 'Pair' }).click()
  await expect(page.getByText('Connected')).toBeVisible({ timeout: 60_000 })
  await page.close()
}

async function listTasks(page: Page): Promise<DownloadTask[]> {
  return (await page.evaluate(async () => {
    const api = (
      window as unknown as {
        motrix?: { invoke: (channel: string) => Promise<unknown> }
      }
    ).motrix
    if (!api) return []
    return api.invoke('query:listTasks')
  })) as DownloadTask[]
}

async function findMediaTask(page: Page): Promise<DownloadTask | null> {
  const tasks = await listTasks(page)
  return (
    tasks.find(
      (task) => task.kind === TaskKind.Mux || task.kind === TaskKind.Direct
    ) ?? null
  )
}

/** Wait for the desktop to create a media task for the overlay submission. */
async function waitForMediaTask(
  page: Page,
  timeoutMs = 120_000
): Promise<DownloadTask | null> {
  return expect
    .poll(() => findMediaTask(page), {
      timeout: timeoutMs,
      intervals: [1_000, 2_000, 5_000],
    })
    .not.toBeNull()
    .then(() => findMediaTask(page))
    .catch(() => null)
}

/** Wait for that task to reach a terminal state. */
async function waitForTaskTerminal(
  page: Page,
  taskId: string
): Promise<DownloadTask> {
  let latest: DownloadTask | undefined
  await expect
    .poll(
      async () => {
        latest = (await listTasks(page)).find((task) => task.id === taskId)
        return latest?.status ?? 'missing'
      },
      { timeout: 280_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toMatch(/^(completed|error)$/)
  return latest as DownloadTask
}

/**
 * The file the finished task left on disk. Prefers the task's final path,
 * then any non-incomplete entry in its save directory — a sniffed stream may
 * land without a media extension, so this does not require one.
 */
async function findMediaFile(task: DownloadTask): Promise<string | null> {
  if (task.finalPath) {
    const stats = await stat(task.finalPath).catch(() => null)
    if (stats?.isFile()) return task.finalPath
  }
  const entries = await readdir(task.saveDir).catch(() => [] as string[])
  console.log(`[overlay] saveDir ${task.saveDir}: ${JSON.stringify(entries)}`)
  const match = entries.find(
    (name) => !name.endsWith('.motrix') && !name.endsWith('.aria2')
  )
  return match ? path.join(task.saveDir, match) : null
}
