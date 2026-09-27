import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { fingerprintExtensionBuild } from './test-windows-store-extension-runtime.mjs'
import {
  browserInventory,
  openFirefoxRemote,
  validateBrowserInventory,
} from './test-windows-store-native-messaging-browser.mjs'

const EXTENSION_ID = 'motrix-extension@motrix.app'
const fail = (code) => {
  throw new Error(code)
}

/** Use the observed runtime UUID, never a profile preference seeded by a test. */
export function validateFirefoxExtensionIdentity(result, sourceUrl, version) {
  if (!Array.isArray(result?.extensions)) fail('firefox-extension-identity')
  const entries = result.extensions.filter(
    (entry) => entry?.id === EXTENSION_ID
  )
  if (!Array.isArray(entries) || entries.length !== 1)
    fail('firefox-extension-identity')
  const entry = entries[0]
  const policy = entry.policy
  const expectedSource = new URL(sourceUrl)
  if (
    expectedSource.protocol !== 'file:' ||
    !expectedSource.pathname.endsWith('/') ||
    entry.isActive !== true ||
    entry.isSystem !== false ||
    entry.hidden !== false ||
    entry.manifestVersion !== 3 ||
    entry.version !== version ||
    entry.temporarilyInstalled !== true ||
    entry.sourceURL !== expectedSource.href ||
    policy?.baseURL !== expectedSource.href ||
    typeof policy.uuid !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(policy.uuid) ||
    policy.extensionURL !== `moz-extension://${policy.uuid}/`
  )
    fail('firefox-extension-identity')
  return {
    popupUrl: `${policy.extensionURL}popup.html`,
    extensionId: EXTENSION_ID,
  }
}

export function firefoxExtensionFailure(stage) {
  return new Set([
    'preflight',
    'build-before',
    'browser-launch',
    'extension-install',
    'extension-identity',
    'popup',
    'store-selection',
    'candidate-selection',
    'code-entry',
    'authenticated-pairing',
    'popup-reopen',
    'build-after',
    'cleanup',
  ]).has(stage)
    ? `firefox-extension-${stage}-failed`
    : 'firefox-extension-operation-failed'
}

// Only coordinates or a boolean state projection leave the extension page.
// Input is delivered by normal BiDi pointer/key actions, not internal UI handlers.
export function firefoxUiTargetExpression(action, appPort) {
  const selectors = {
    backend: 'button[aria-label^="Choose Motrix backend:"]',
    store: '[role="menuitemradio"]',
    pair: 'button',
    candidate: '[role="dialog"] [role="listitem"]',
    code: '#pairing-code-input',
    submit: '[role="dialog"] button',
  }
  if (
    !Object.hasOwn(selectors, action) ||
    !Number.isInteger(appPort) ||
    appPort < 1 ||
    appPort > 65535
  )
    fail('firefox-ui-target')
  const labels = {
    store: 'Motrix · Microsoft Store',
    pair: 'Pair',
    submit: 'Pair',
  }
  return `(() => {
    let elements = [...document.querySelectorAll(${JSON.stringify(selectors[action])})];
    ${labels[action] ? `elements = elements.filter(e => e.textContent.trim() === ${JSON.stringify(labels[action])});` : ''}
    ${action === 'candidate' ? `elements = elements.filter(e => [...e.querySelectorAll('*')].some(n => n.textContent.trim() === 'Port ${appPort}')).flatMap(e => [...e.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Choose'));` : ''}
    elements = elements.filter(e => !e.disabled && e.getAttribute('aria-disabled') !== 'true' && e.getClientRects().length);
    if (elements.length !== 1) return 'null';
    const e = elements[0]; const r = e.getBoundingClientRect();
    const x = Math.floor(r.x + r.width / 2), y = Math.floor(r.y + r.height / 2);
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === e || e.contains(top))) return 'null';
    return JSON.stringify({x, y});
  })()`
}

export async function runFirefoxStoreExtension({
  extensionDirectory,
  sourceCommit,
  profileDirectory,
  appPort,
  readPairingCode,
}) {
  const report = {
    scope: 'installed-appx-production-firefox-temporary-extension',
    browserName: 'firefox',
    ok: false,
    firstPairVerified: false,
    popupReopenReconnectVerified: false,
    temporaryInstallationVerified: false,
    runtimeIdentityVerified: false,
    cleanupVerified: false,
    browserRestartReconnectVerified: false,
    signedPersistentInstallationVerified: false,
    installationConsentVerified: false,
    protocolActivationVerified: false,
    windows11AcceptanceVerified: false,
  }
  let stage = 'preflight'
  let ownedProfile = false
  let remoteCleanupFailed = false
  let session
  try {
    if (
      process.platform !== 'win32' ||
      !/^[a-f0-9]{40}$/.test(sourceCommit) ||
      !path.isAbsolute(extensionDirectory) ||
      !path.isAbsolute(profileDirectory) ||
      !Number.isInteger(appPort) ||
      appPort < 1 ||
      appPort > 65535
    )
      fail('firefox-extension-input')
    await mkdir(profileDirectory)
    ownedProfile = true
    report.sourceCommit = sourceCommit
    stage = 'build-before'
    const build = await fingerprintExtensionBuild(extensionDirectory, 'firefox')
    report.build = build
    const manifest = JSON.parse(
      await readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8')
    )
    const inventory = await browserInventory('firefox')
    report.browser = validateBrowserInventory({ browser: 'firefox', inventory })
    stage = 'browser-launch'
    session = await openFirefoxRemote({ inventory, profileDirectory })
    report.browser = validateBrowserInventory({
      browser: 'firefox',
      inventory,
      runtimeVersion: session.version,
    })
    stage = 'extension-install'
    const loaded = await session.command('webExtension.install', {
      extensionData: { type: 'path', path: extensionDirectory },
    })
    if (loaded.extension !== EXTENSION_ID) fail('firefox-extension-identity')
    stage = 'extension-identity'
    const identity = validateFirefoxExtensionIdentity(
      await session.command('webExtension.moz:listExtensions', {}),
      pathToFileURL(`${extensionDirectory}${path.sep}`).href,
      manifest.version
    )
    report.extensionId = identity.extensionId
    report.temporaryInstallationVerified = true
    let context
    async function evaluate(expression) {
      const result = await session.command('script.evaluate', {
        expression,
        target: { context },
        awaitPromise: true,
        resultOwnership: 'none',
      })
      if (
        result.type !== 'success' ||
        result.result?.type !== 'string' ||
        typeof result.result.value !== 'string' ||
        Buffer.byteLength(result.result.value) > 512
      )
        fail('firefox-extension-evaluate')
      return result.result.value
    }
    async function popup() {
      const created = await session.command('browsingContext.create', {
        type: 'tab',
      })
      context = created.context
      await session.command('browsingContext.navigate', {
        context,
        url: identity.popupUrl,
        wait: 'complete',
      })
      if ((await evaluate('browser.runtime.id')) !== EXTENSION_ID)
        fail('firefox-extension-identity')
    }
    async function click(action) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const point = JSON.parse(
          await evaluate(firefoxUiTargetExpression(action, appPort))
        )
        if (
          point &&
          Number.isInteger(point.x) &&
          Number.isInteger(point.y) &&
          point.x >= 0 &&
          point.y >= 0 &&
          point.x <= 8192 &&
          point.y <= 8192
        ) {
          await session.command('input.performActions', {
            context,
            actions: [
              {
                type: 'pointer',
                id: 'store-pointer',
                parameters: { pointerType: 'mouse' },
                actions: [
                  {
                    type: 'pointerMove',
                    x: point.x,
                    y: point.y,
                    duration: 0,
                    origin: 'viewport',
                  },
                  { type: 'pointerDown', button: 0 },
                  { type: 'pointerUp', button: 0 },
                ],
              },
            ],
          })
          return
        }
        await delay(250)
      }
      fail('firefox-extension-ui-timeout')
    }
    async function keys(value) {
      await session.command('input.performActions', {
        context,
        actions: [
          {
            type: 'key',
            id: 'store-keyboard',
            actions: [...value].flatMap((key) => [
              { type: 'keyDown', value: key },
              { type: 'keyUp', value: key },
            ]),
          },
        ],
      })
    }
    async function state() {
      const result = JSON.parse(
        await evaluate(
          `(async () => { const r = await browser.runtime.sendMessage({kind:'bg.getState'}); return JSON.stringify({store:r?.endpoint?.activeEndpointId === 'local-windows-store',connected:r?.state === 'connected',prompt:r?.pairingCode != null,error:typeof r?.error === 'string'}); })()`
        )
      )
      if (
        ['store', 'connected', 'prompt', 'error'].some(
          (key) => typeof result?.[key] !== 'boolean'
        )
      )
        fail('firefox-extension-state')
      return result
    }
    async function connected() {
      for (let attempt = 0; attempt < 80; attempt++) {
        const current = await state()
        if (!current.store || current.error) fail('firefox-extension-state')
        if (current.connected && !current.prompt) return
        await delay(250)
      }
      fail('firefox-extension-connect-timeout')
    }
    stage = 'popup'
    await popup()
    report.runtimeIdentityVerified = true
    stage = 'store-selection'
    await click('backend')
    await click('store')
    await keys('\uE00C')
    for (let attempt = 0; !(await state()).store; attempt++) {
      if (attempt >= 40) fail('firefox-extension-target-timeout')
      await delay(250)
    }
    await click('pair')
    stage = 'candidate-selection'
    await click('candidate')
    stage = 'code-entry'
    const code = await readPairingCode()
    if (!/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code))
      fail('firefox-extension-code')
    await click('code')
    await keys(code.replace('-', ''))
    await click('submit')
    stage = 'authenticated-pairing'
    await connected()
    report.firstPairVerified = true
    stage = 'popup-reopen'
    await session.command('browsingContext.close', { context })
    await popup()
    await connected()
    report.popupReopenReconnectVerified = true
    stage = 'build-after'
    if (
      JSON.stringify(build) !==
      JSON.stringify(
        await fingerprintExtensionBuild(extensionDirectory, 'firefox')
      )
    )
      fail('firefox-extension-build-changed')
    report.ok = true
  } catch (error) {
    // Session startup performs its own teardown before rejecting. Preserve a
    // failed teardown even when it never returned a session to this caller.
    remoteCleanupFailed = error?.code === 'browser-cleanup-failed'
    report.failureCode = firefoxExtensionFailure(stage)
  } finally {
    try {
      if (remoteCleanupFailed) fail('firefox-extension-cleanup')
      if (session) await session.close()
      if (ownedProfile)
        await rm(profileDirectory, {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 250,
        })
      report.cleanupVerified = true
    } catch {
      report.ok = false
      report.failureCode = firefoxExtensionFailure('cleanup')
    }
  }
  report.ok &&= report.cleanupVerified
  return report
}
