import { getLogger } from '@core/logger'
import { extractPageLinksFromCandidates } from '@core/parser/page-link-parser'
import type {
  ParsePageLinksRequest,
  ParsePageLinksResult,
} from '@shared/schemas/page-parse'
import { BrowserWindow } from 'electron'

const DEFAULT_LOAD_TIMEOUT_MS = 20_000
const DEFAULT_RENDER_TIMEOUT_MS = 40_000
const DEFAULT_MIN_SETTLE_MS = 1_500
const DEFAULT_POLL_MS = 700
// When an extension whitelist is configured, keep polling past the normal
// stable-settle point as long as no whitelisted file has appeared yet —
// heavy model-host SPAs (ModelScope) render their file lists 15-30s after
// load, long after the page's static links (favicons, avatars) stabilize.
const DEFAULT_PREFERRED_WAIT_MS = 30_000

export interface RenderedPageLinkParserOptions {
  loadTimeoutMs?: number
  renderTimeoutMs?: number
  minSettleMs?: number
  pollMs?: number
  /** Extra window during which a stable result without any whitelisted
   *  link keeps polling, waiting for SPA file lists to appear. */
  preferredWaitMs?: number
  /** Extension whitelist: only links whose path extension is in the set are
   *  surfaced. An empty/absent set yields no links (pure whitelist). */
  extensionFilter?: ReadonlySet<string>
}

/**
 * AutoParser strategy B: load the page in a hidden BrowserWindow so the
 * site's JavaScript runs, then reuse the shared static extractor on the
 * rendered DOM. Covers SPA download pages (openEuler, etc.) whose links
 * never appear in the served HTML. Lives in src/main because core must
 * not import electron.
 */
export class RenderedPageLinkParser {
  private readonly loadTimeoutMs: number
  private readonly renderTimeoutMs: number
  private readonly minSettleMs: number
  private readonly pollMs: number
  private readonly preferredWaitMs: number
  private readonly extensionFilter?: RenderedPageLinkParserOptions['extensionFilter']

  constructor(options: RenderedPageLinkParserOptions = {}) {
    this.loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
    this.renderTimeoutMs = options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
    this.minSettleMs = options.minSettleMs ?? DEFAULT_MIN_SETTLE_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.preferredWaitMs = options.preferredWaitMs ?? DEFAULT_PREFERRED_WAIT_MS
    this.extensionFilter = options.extensionFilter
  }

  async parse(request: ParsePageLinksRequest): Promise<ParsePageLinksResult> {
    const win = this.createWindow(request)
    // Never let a misbehaving page start real downloads from the hidden
    // window. will-download only exists on the session, so track the
    // listener and remove it with the window to avoid leaking onto the
    // shared session across parses.
    const denyDownload = (event: { preventDefault(): void }) => {
      event.preventDefault()
    }
    win.webContents.session.on('will-download', denyDownload)
    try {
      await this.load(win, request.url)
      return await this.extractWhenStable(win, request.url)
    } finally {
      win.webContents.session.removeListener('will-download', denyDownload)
      win.destroy()
    }
  }

  private createWindow(request: ParsePageLinksRequest): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Pure link extraction: images are noise, but DOM/script execution
        // must stay enabled or SPA download lists never render.
        images: false,
      },
    })
    const userAgent = this.pickUserAgent(request)
    if (userAgent) win.webContents.setUserAgent(userAgent)
    win.webContents.setAudioMuted(true)
    // No popups, no plugin child windows.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return win
  }

  private pickUserAgent(request: ParsePageLinksRequest): string | undefined {
    return request.headers.find(
      (h) => h.name.toLowerCase() === 'user-agent' && h.value.trim().length > 0
    )?.value
  }

  private load(win: BrowserWindow, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        // Soft timeout: slow hosts (anti-bot throttling) can outrun the
        // load event while the DOM is already usable — fall through to
        // the bounded render-polling phase instead of failing the parse.
        getLogger('autoparser').warn(
          'page load exceeded %sms, continuing with rendered polling',
          this.loadTimeoutMs
        )
        resolve()
      }, this.loadTimeoutMs)

      const onFail = (_event: unknown, code: number, desc: string) => {
        // -3 is an aborted navigation (e.g., redirect chains); let it ride.
        if (code === -3) return
        cleanup()
        reject(new Error(`page load failed: ${desc} (${code})`))
      }

      // Late events can fire after the window is destroyed (renderer crash,
      // timeout + destroy); touching webContents then throws.
      const cleanup = () => {
        clearTimeout(timer)
        if (!win.isDestroyed()) {
          win.webContents.removeListener('did-fail-load', onFail)
        }
      }

      win.webContents.once('did-finish-load', () => {
        cleanup()
        resolve()
      })
      win.webContents.on('did-fail-load', onFail)

      win.loadURL(url).catch((error) => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /**
   * Poll the rendered DOM until the discovered link count stabilizes (two
   * consecutive identical non-zero counts after the minimum settle time),
   * or until the render timeout expires. Keeps fast pages fast while
   * giving SPAs time to finish fetching their download lists.
   *
   * With a configured extension whitelist, stability alone is not enough
   * while no whitelisted file has appeared: static page chrome (favicons,
   * avatars) stabilizes immediately and would mask file lists that model
   * hosts fetch 15-30s after load. In that case keep polling until the
   * preferred-wait window closes before accepting a stable result.
   *
   * A page that stays empty past the preferred-wait window is accepted as
   * genuinely having no matching files — otherwise a whitelist-only parse
   * of the wrong page would always burn the full render timeout.
   */
  private async extractWhenStable(
    win: BrowserWindow,
    pageUrl: string
  ): Promise<ParsePageLinksResult> {
    const startedAt = Date.now()
    let lastCount = -1
    let lastResult: ParsePageLinksResult | null = null

    for (;;) {
      const snapshot = await this.snapshot(win)
      lastResult = extractPageLinksFromCandidates({
        pageUrl,
        finalUrl: snapshot.url,
        candidates: snapshot.candidates,
        title: snapshot.title,
        extensionFilter: this.extensionFilter,
      })
      const elapsed = Date.now() - startedAt
      const countStable = lastResult.links.length === lastCount
      const stable =
        elapsed >= this.minSettleMs &&
        lastResult.links.length > 0 &&
        countStable
      const waitingForPreferred =
        this.extensionFilter !== undefined &&
        !this.hasPreferredLink(lastResult) &&
        elapsed < this.preferredWaitMs
      if (stable && !waitingForPreferred) return lastResult
      if (
        countStable &&
        lastResult.links.length === 0 &&
        elapsed >= this.preferredWaitMs
      ) {
        return lastResult
      }

      lastCount = lastResult.links.length
      if (elapsed >= this.renderTimeoutMs) {
        return (
          lastResult ?? {
            pageUrl,
            finalUrl: pageUrl,
            title: null,
            links: [],
          }
        )
      }
      await sleep(Math.min(this.pollMs, this.renderTimeoutMs - elapsed))
    }
  }

  private hasPreferredLink(result: ParsePageLinksResult): boolean {
    const whitelist = this.extensionFilter
    if (!whitelist || whitelist.size === 0) return true
    return result.links.some((link) =>
      link.extension ? whitelist.has(link.extension) : false
    )
  }

  private async snapshot(win: BrowserWindow): Promise<{
    url: string
    title: string | null
    candidates: string[]
  }> {
    // Collect content-shaped links only: anchors (browser-resolved to
    // absolute URLs via .href) plus explicit download data-attributes.
    // Scanning the full outerHTML would feed page chrome into the
    // extractor — e.g. ModelScope's `<script src="…alicdn.com/…
    // /modelscope-fe.json">` app manifest matches a user-whitelisted
    // .json and made the settle loop accept the empty app shell before
    // the real file table rendered.
    const raw = await win.webContents.executeJavaScript(
      "(function(){var out={url:location.href,title:document.title,links:[]};var nodes=document.querySelectorAll('a[href],[data-url],[data-href],[data-file],[data-download]');for(var i=0;i<nodes.length;i++){var n=nodes[i];var v=n.tagName==='A'?n.href:(n.getAttribute('data-url')||n.getAttribute('data-href')||n.getAttribute('data-file')||n.getAttribute('data-download'));if(v)out.links.push(v);}return JSON.stringify(out)})()"
    )
    try {
      const parsed = JSON.parse(raw) as {
        url: string
        title: string
        links: string[]
      }
      return {
        url: parsed.url,
        title: parsed.title,
        candidates: Array.isArray(parsed.links) ? parsed.links : [],
      }
    } catch (error) {
      getLogger('autoparser').warn(
        'failed to decode rendered snapshot: %s',
        error
      )
      return { url: win.webContents.getURL(), title: null, candidates: [] }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}