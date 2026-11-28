// Disposable extension page. Only its Playwright binding can reach the local
// candidate client; the test file origin has no RPC or operator endpoint.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { build } from 'vite'

export async function confirmLocalHandoff({
  root,
  extensionRoot,
  origin,
  submit,
  requestCount,
}) {
  const base = path.join(root, 'output/playwright/manual/download-handoff')
  await mkdir(base, { recursive: true })
  const dir = await mkdtemp(path.join(base, 'run-'))
  const ext = path.join(dir, 'extension')
  const sources = [
    ['release-click-content', 'content.js'],
    ['local-host-handoff', 'runner.js'],
  ]
  for (const [entry, filename] of sources) {
    await build({
      root: extensionRoot,
      configFile: false,
      publicDir: false,
      logLevel: 'error',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: { '@': path.join(extensionRoot, 'src') } },
      build: {
        outDir: ext,
        emptyOutDir: false,
        lib: {
          entry: path.join(extensionRoot, 'scripts/fixtures', `${entry}.ts`),
          name: 'fixture',
          formats: ['iife'],
          fileName: () => filename,
        },
      },
    })
  }
  await writeFile(
    path.join(ext, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Local candidate handoff acceptance',
      version: '1',
      permissions: ['storage', 'tabs', 'downloads'],
      host_permissions: ['http://127.0.0.1/*'],
      background: { service_worker: 'worker.js' },
      content_scripts: [
        {
          matches: ['http://127.0.0.1/*'],
          js: ['content.js'],
          run_at: 'document_start',
        },
      ],
    })
  )
  await writeFile(
    path.join(ext, 'worker.js'),
    'chrome.runtime.onInstalled.addListener(()=>{})'
  )
  // Use the packaged popup's layout so the driver exercises pointer hit testing.
  const shipped = path.join(extensionRoot, 'dist/chromium')
  const popup = await readFile(path.join(shipped, 'popup.html'), 'utf8')
  const css = popup.match(
    /<link rel="stylesheet"[^>]+href="(\/assets\/[\w.-]+\.css)"/
  )?.[1]
  assert.ok(css, 'Build the Chromium extension before browser acceptance')
  const assets = path.join(ext, 'assets')
  await mkdir(assets, { recursive: true })
  for (const file of await readdir(path.join(shipped, 'assets'))) {
    if (file === path.basename(css) || /\.woff2?$/.test(file))
      await copyFile(
        path.join(shipped, 'assets', file),
        path.join(assets, file)
      )
  }
  await writeFile(
    path.join(ext, 'runner.html'),
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${css}"><body><script src="runner.js"></script></body>`
  )
  const ctx = await chromium.launchPersistentContext(
    path.join(dir, 'profile'),
    {
      channel: 'chromium',
      executablePath: process.env.CHROME_BINARY,
      headless: true,
      viewport: { width: 400, height: 600 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--load-extension=${ext}`, `--disable-extensions-except=${ext}`],
    }
  )
  try {
    const sw =
      ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
    const runner = ctx.pages()[0]
    const runnerUrl = new URL('runner.html', sw.url()).href
    let submissions = 0,
      taskId
    await runner.exposeBinding(
      'submitLocalCandidate',
      async (source, download) => {
        assert.equal(source.frame.url(), runnerUrl)
        assert.equal(++submissions, 1)
        assert.equal(
          download.selection.primary.url,
          `${origin}/download/click-live`
        )
        assert.equal(download.meta.suggestedFilename, 'handoff.bin')
        assert.equal(
          download.selection.primary.headers['X-Motrix-Test-Context'],
          'fixture'
        )
        const result = await submit(download)
        taskId = result.taskId
        return result
      }
    )
    await runner.goto(runnerUrl)
    await runner.evaluate(
      (origin) => window.installLocalCandidate(origin),
      origin
    )
    const site = await ctx.newPage()
    await site.goto(`${origin}/start/click-live`)
    const link = site.getByRole('link', { name: 'Download' })
    await link.focus()
    await site.waitForSelector('html[data-fixture-ready]')
    await link.click()
    await runner.bringToFront()
    const dialog = runner.getByRole('dialog')
    await dialog.waitFor()
    const browserItems = () =>
      runner.evaluate(async () => (await chrome.downloads.search({})).length)
    assert.equal(requestCount(), 0)
    assert.equal(await browserItems(), 0)
    await dialog.locator('input[id$="-filename"]').fill('handoff.bin')
    await dialog.locator('summary').click()
    await dialog
      .locator('textarea[id$="-headers"]')
      .fill('X-Motrix-Test-Context: fixture')
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 60000 })
    assert.ok(taskId)
    assert.equal(submissions, 1)
    assert.equal(await browserItems(), 0)
    return {
      browser: ctx.browser().version(),
      extensionRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: extensionRoot,
        encoding: 'utf8',
      }).trim(),
      requestsAtConfirmation: 0,
      nativeItems: 0,
      submissions,
      taskId,
    }
  } finally {
    await ctx.close()
  }
}
