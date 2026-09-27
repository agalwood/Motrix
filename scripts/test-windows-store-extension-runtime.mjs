import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runBoundedProbeProcess } from './test-windows-store-native-messaging-alias.mjs'
import {
  browserInventory,
  killOwnedProcess,
  validateBrowserInventory,
} from './test-windows-store-native-messaging-browser.mjs'

const fail = (code) => {
  throw new Error(code)
}

/** Hash the complete verified build, including maps, without following links. */
export async function fingerprintExtensionBuild(directory) {
  const digest = createHash('sha256')
  let files = 0
  let bytes = 0
  async function visit(relative) {
    const target = path.join(directory, relative)
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) fail('extension-build-link')
    if (stat.isDirectory()) {
      for (const name of (await readdir(target)).sort()) {
        await visit(relative ? `${relative}/${name}` : name)
      }
    } else if (stat.isFile()) {
      files += 1
      bytes += stat.size
      if (files > 256 || bytes > 64 * 1024 * 1024) fail('extension-build-limit')
      const content = await readFile(target)
      digest
        .update(JSON.stringify([relative, content.length]))
        .update('\n')
        .update(content)
    } else fail('extension-build-type')
  }
  await visit('')
  const manifest = JSON.parse(
    await readFile(path.join(directory, 'manifest.json'), 'utf8')
  )
  if (
    manifest.manifest_version !== 3 ||
    manifest.action?.default_popup !== 'popup.html' ||
    typeof manifest.background?.service_worker !== 'string' ||
    !manifest.permissions?.includes('storage') ||
    !manifest.permissions?.includes('nativeMessaging')
  )
    fail('extension-build-manifest')
  return { sha256: digest.digest('hex'), files, bytes }
}

/** Never let a Playwright error serialize a pairing code, page text or profile. */
export function extensionFailure(stage) {
  const allowed = new Set([
    'preflight',
    'build-before',
    'browser-launch',
    'store-selection',
    'candidate-selection',
    'pairing-dialog',
    'code-entry',
    'authenticated-pairing',
    'browser-restart',
    'authenticated-reconnect',
    'application-close',
    'protocol-confirmation',
    'protocol-identity',
    'protocol-reconnect',
    'build-after',
    'cleanup',
  ])
  return allowed.has(stage)
    ? `extension-${stage}-failed`
    : 'extension-operation-failed'
}

async function bounded(promise, milliseconds = 10000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('extension-timeout')),
          milliseconds
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Only a redacted projection leaves the extension page. No storage, nonce,
// endpoint, credential or raw exception is read back by the test controller.
async function state(page) {
  return bounded(
    page.evaluate(async () => {
      const result = await chrome.runtime.sendMessage({ kind: 'bg.getState' })
      return {
        store: result?.endpoint?.activeEndpointId === 'local-windows-store',
        connected: result?.state === 'connected',
        prompt: result?.pairingCode != null,
        error: typeof result?.error === 'string',
      }
    })
  )
}

async function waitConnected(page) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await state(page)
    if (!value.store || value.error) fail('extension-target-mismatch')
    if (value.connected && !value.prompt) return
    await delay(250)
  }
  fail('extension-connect-timeout')
}

async function protocolConfirmation(mode, browserName, pid, hash, startTicks) {
  const result = await runBoundedProbeProcess({
    executable: path.win32.join(
      process.env.SystemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    ),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fileURLToPath(
        new URL('./confirm-windows-store-browser-protocol.ps1', import.meta.url)
      ),
      '-Mode',
      mode,
      '-TargetPid',
      String(pid),
      '-Browser',
      browserName,
      '-ExecutableHash',
      hash,
      ...(startTicks ? ['-StartTicks', startTicks] : []),
    ],
    timeoutMs: 20000,
    maxStdoutBytes: 512,
  })
  if (result.exitCode !== 0 || result.stderr.length)
    fail('protocol-confirmation-failed')
  const value = JSON.parse(result.stdout.toString('utf8'))
  if (mode === 'identity') {
    if (
      typeof value.startTicks !== 'string' ||
      !/^\d{15,20}$/.test(value.startTicks)
    )
      fail('protocol-browser-identity')
    return value.startTicks
  }
  if (
    typeof value.confirmed !== 'boolean' ||
    value.processIdentityVerified !== true ||
    ['ownedWindows', 'openButtons', 'eligibleDialogs'].some(
      (key) =>
        !Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100
    )
  )
    fail('protocol-confirmation-failed')
  return {
    confirmed: value.confirmed,
    processIdentityVerified: true,
    ownedWindows: value.ownedWindows,
    openButtons: value.openButtons,
    eligibleDialogs: value.eligibleDialogs,
  }
}

/** Branded browsers only; Firefox uses a different automation/identity path. */
export function productionChromiumTarget(browserName) {
  if (browserName !== 'chrome' && browserName !== 'edge')
    fail('extension-browser-unsupported')
  return {
    browserName,
    channel: browserName === 'chrome' ? 'chrome' : 'msedge',
    scope: `installed-appx-production-${browserName}-extension`,
  }
}

/** The selected cold-launch case runs last because it closes the application. */
export function productionBrowserOrder(protocolBrowser) {
  productionChromiumTarget(protocolBrowser)
  return [protocolBrowser === 'chrome' ? 'edge' : 'chrome', protocolBrowser]
}

/**
 * Production Chromium build, normal UI and PAKE, disposable CI profile.
 * Optional cold launch exercises normal protocol consent, never Store identity.
 * The caller owns the installed application's identity/port and code renderer.
 */
export async function runStoreExtensionRuntime({
  browserName,
  extensionDirectory,
  sourceCommit,
  profileDirectory,
  appPort,
  readPairingCode,
  coldLaunch,
}) {
  const report = {
    scope: 'installed-appx-production-extension',
    ok: false,
    firstPairVerified: false,
    browserRestartReconnectVerified: false,
    cleanupVerified: false,
    protocolActivationVerified: false,
    firefoxVerified: false,
    windows11AcceptanceVerified: false,
    ...(coldLaunch ? { protocolLaunch: coldLaunch.report } : {}),
  }
  let stage = 'preflight'
  let context
  let ownedPid
  let profileCreated = false
  async function closeBrowser() {
    if (!context) return
    try {
      await bounded(context.close())
    } catch {
      if (!ownedPid) fail('extension-cleanup-failed')
      await killOwnedProcess(ownedPid)
    }
    context = undefined
    ownedPid = undefined
  }
  try {
    const target = productionChromiumTarget(browserName)
    report.scope = target.scope
    report.browserName = target.browserName
    if (
      process.platform !== 'win32' ||
      !/^[0-9a-f]{40}$/.test(sourceCommit) ||
      !path.isAbsolute(extensionDirectory) ||
      !path.isAbsolute(profileDirectory) ||
      !Number.isInteger(appPort) ||
      appPort < 1 ||
      appPort > 65535
    )
      fail('extension-invalid-input')
    // Refuse pre-existing profiles; an unsuccessful mkdir never gives ownership.
    await mkdir(profileDirectory)
    profileCreated = true
    report.sourceCommit = sourceCommit
    stage = 'build-before'
    const build = await fingerprintExtensionBuild(extensionDirectory)
    report.build = build
    const inventory = await browserInventory(target.browserName)
    report.browser = validateBrowserInventory({
      browser: target.browserName,
      inventory,
    })
    const { chromium } = await import('playwright')
    async function launch() {
      context = await chromium.launchPersistentContext(profileDirectory, {
        executablePath: inventory.executable,
        channel: target.channel,
        headless: false,
        locale: 'en-US',
        timeout: 30000,
        viewport: { width: 400, height: 600 },
        ignoreDefaultArgs: ['--disable-extensions'],
        args: ['--enable-unsafe-extension-debugging'],
      })
      context.setDefaultTimeout(10000)
      const cdp = await bounded(context.browser().newBrowserCDPSession())
      const processes = await bounded(cdp.send('SystemInfo.getProcessInfo'))
      const roots = processes.processInfo.filter(
        (entry) => entry.type === 'browser'
      )
      if (roots.length !== 1 || !Number.isInteger(roots[0].id))
        fail('extension-browser-identity')
      ownedPid = roots[0].id
      const runtime = await bounded(cdp.send('Browser.getVersion'))
      report.browser = validateBrowserInventory({
        browser: target.browserName,
        inventory,
        runtimeVersion: runtime.product.replace(/^[^/]+\//, ''),
      })
      const loaded = await bounded(
        cdp.send('Extensions.loadUnpacked', { path: extensionDirectory })
      )
      if (!/^[a-p]{32}$/.test(loaded.id)) fail('extension-id-invalid')
      if (report.extensionId && loaded.id !== report.extensionId)
        fail('extension-id-changed')
      report.extensionId = loaded.id
      const page = await context.newPage()
      await page.goto(`chrome-extension://${loaded.id}/popup.html`, {
        timeout: 10000,
      })
      if ((await bounded(page.evaluate(() => chrome.runtime.id))) !== loaded.id)
        fail('extension-id-invalid')
      return page
    }
    stage = 'browser-launch'
    let page = await launch()
    stage = 'store-selection'
    await page.getByRole('button', { name: /^Choose Motrix backend:/ }).click()
    await page
      .getByRole('menuitemradio', {
        name: 'Motrix · Microsoft Store',
        exact: true,
      })
      .click()
    for (let attempt = 0; !(await state(page)).store; attempt++) {
      if (attempt >= 40) fail('extension-target-timeout')
      await delay(100)
    }
    // Radio menu selection keeps the popup menu open. Dismiss it normally
    // before interacting with the underlying pairing action.
    await page.keyboard.press('Escape')
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    stage = 'pairing-dialog'
    await page.getByRole('button', { name: 'Pair', exact: true }).click()
    stage = 'candidate-selection'
    const dialog = page.getByRole('dialog')
    const row = dialog
      .getByRole('listitem')
      .filter({ has: page.getByText(`Port ${appPort}`, { exact: true }) })
    await row.getByRole('button', { name: 'Choose', exact: true }).click()
    stage = 'code-entry'
    // The code comes only from the owned AppX renderer's normal pairing UI.
    // No console logging, screenshots, tracing, storage seeding or IPC calls.
    const code = await readPairingCode()
    if (!/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code))
      fail('extension-code-invalid')
    await dialog
      .getByRole('textbox', { name: 'Pairing code', exact: true })
      .fill(code.replace('-', ''))
    await dialog.getByRole('button', { name: 'Pair', exact: true }).click()
    stage = 'authenticated-pairing'
    await waitConnected(page)
    report.firstPairVerified = true
    stage = 'browser-restart'
    await closeBrowser()
    page = await launch()
    stage = 'authenticated-reconnect'
    // Autostart must use the saved credential. Do not submit another code or
    // reconnect message that could silently turn this into a new first pair.
    await waitConnected(page)
    report.browserRestartReconnectVerified = true
    if (coldLaunch) {
      stage = 'application-close'
      await coldLaunch.stop()
      for (let attempt = 0; ; attempt++) {
        const current = await state(page)
        if (!current.store || current.prompt) fail('extension-target-mismatch')
        if (!current.connected) break
        if (attempt >= 40) fail('extension-disconnect-timeout')
        await delay(250)
      }
      const browserStart = await protocolConfirmation(
        'identity',
        browserName,
        ownedPid,
        inventory.executableSha256
      )
      stage = 'protocol-confirmation'
      await page.bringToFront()
      await page.getByRole('button', { name: /^(Connect|View tasks)$/ }).click()
      report.protocolConfirmation = await protocolConfirmation(
        'confirm',
        browserName,
        ownedPid,
        inventory.executableSha256,
        browserStart
      )
      if (!report.protocolConfirmation.confirmed)
        fail('protocol-confirmation-failed')
      stage = 'protocol-identity'
      await coldLaunch.observe()
      stage = 'protocol-reconnect'
      await waitConnected(page)
      report.protocolActivationVerified = true
    }
    stage = 'build-after'
    if (
      JSON.stringify(await fingerprintExtensionBuild(extensionDirectory)) !==
      JSON.stringify(build)
    )
      fail('extension-build-changed')
    report.ok = true
  } catch {
    report.failureCode = extensionFailure(stage)
  } finally {
    try {
      if (coldLaunch) await coldLaunch.cleanup()
    } catch {
      report.ok = false
      report.failureCode = extensionFailure('cleanup')
    }
    try {
      await closeBrowser()
      if (profileCreated)
        await rm(profileDirectory, {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 250,
        })
      report.cleanupVerified = true
    } catch {
      report.ok = false
      report.failureCode = extensionFailure('cleanup')
    }
  }
  report.ok &&= report.cleanupVerified
  if (coldLaunch) report.ok &&= coldLaunch.report.cleanupVerified
  return report
}
