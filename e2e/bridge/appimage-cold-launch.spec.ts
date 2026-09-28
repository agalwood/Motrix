import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  test,
} from '@playwright/test'
import { CURRENT_SETTINGS_VERSION } from '../../src/core/settings/migrations'
import {
  type ExtensionPage,
  launchNativeFirefox,
} from '../helpers/firefox-native-extension'
import { getFreePort } from '../helpers/free-port'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

async function extensionState(
  page: ExtensionPage
): Promise<{ state?: string; pairingCode?: unknown }> {
  return page.evaluate(async () => {
    const runtime = (
      globalThis as typeof globalThis & {
        chrome: {
          runtime: {
            sendMessage(
              message: unknown
            ): Promise<{ state?: string; pairingCode?: unknown }>
          }
        }
      }
    ).chrome.runtime
    return runtime.sendMessage({ kind: 'bg.getState' })
  })
}
async function credentialIds(page: ExtensionPage): Promise<string[]> {
  return page.evaluate(async () => {
    const browser = (
      globalThis as typeof globalThis & {
        chrome: { storage: { local: { get(key: string): Promise<unknown> } } }
      }
    ).chrome
    const stored = await browser.storage.local.get('motrix.mbp1.credentials')
    const ids = new Set<string>()
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (key === 'credentialId' && typeof child === 'string') ids.add(child)
        else visit(child)
      }
    }
    visit(stored)
    return [...ids].sort()
  })
}

/** Only processes carrying this test's unique profile are eligible for cleanup. */
async function stopProfile(profile: string): Promise<void> {
  // The owner-only endpoint was created inside this test's private profile.
  // Some Electron processes restrict reading their environment after startup.
  try {
    const endpoint = JSON.parse(
      await readFile(join(profile, 'bridge/endpoint.json'), 'utf8')
    ) as { pid?: number }
    if (Number.isInteger(endpoint.pid) && endpoint.pid! > 1)
      process.kill(endpoint.pid!, 'SIGTERM')
  } catch {
    /* The bridge has already stopped. */
  }
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/u.test(name)) continue
    try {
      const env = await readFile(`/proc/${name}/environ`, 'utf8')
      if (env.split('\0').includes(`MOTRIX_USER_DATA=${profile}`))
        process.kill(Number(name), 'SIGTERM')
    } catch {
      /* Process exited, or belongs to another user. */
    }
  }
}

for (const browserName of ['chromium', 'firefox'] as const) {
  test(`real ${browserName} + AppImage: consent, pair, unmount, browser wake, original-credential reconnect and download`, async () => {
    test.skip(
      process.platform !== 'linux',
      'AppImage requires a Linux kernel and FUSE'
    )
    const artifact = process.env.MOTRIX_APPIMAGE_ARTIFACT
    const extension =
      browserName === 'firefox'
        ? process.env.MOTRIX_FIREFOX_EXTENSION_BUILD
        : process.env.MOTRIX_EXTENSION_BUILD
    test.skip(
      !artifact || !extension,
      'Requires real AppImage and extension builds'
    )
    if (!artifact || !extension)
      throw new Error(
        'Set MOTRIX_APPIMAGE_ARTIFACT and MOTRIX_EXTENSION_BUILD to actual build artifacts'
      )
    // The download contract requires a DNS hostname. Map this reserved test
    // domain to 127.0.0.1 in the Linux test machine's hosts file.
    const downloadHost = 'appimage.motrix.test'
    expect((await lookup(downloadHost)).address).toBe('127.0.0.1')
    const root = await realpath(
      await mkdtemp(join(homedir(), '.motrix-appimage-e2e-'))
    )
    await chmod(root, 0o700)
    const profile = join(root, 'app-profile')
    let image = join(root, 'Motrix 中文 test.AppImage')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: join(root, '.local/share'),
      XDG_CONFIG_HOME: join(root, '.config'),
      LANG: 'en_US.UTF-8',
    }
    delete env.CHROME_CONFIG_HOME
    delete env.MOTRIX_USER_DATA
    delete env.MOTRIX_BRIDGE_DATA_DIR
    await mkdir(profile, { mode: 0o700 })
    await copyFile(artifact, image)
    await chmod(image, 0o500)
    await writeFile(
      join(profile, 'settings.json'),
      JSON.stringify({
        version: CURRENT_SETTINGS_VERSION,
        bridge: { instanceId: randomUUID() },
        engine: { dnsMode: 'system' },
        onboarding: { disclaimerAccepted: true },
        app: {
          language: 'en-US',
          checkForUpdatesOnLaunch: false,
          warnBeforeQuit: false,
          defaultSaveDir: join(root, 'downloads'),
        },
      })
    )
    // Desktop integration is independent; the test explicitly enables only browser launch.
    await writeFile(
      join(profile, 'appimage-integration.json'),
      JSON.stringify({ decision: 'declined', nmConsent: 'declined' })
    )
    const debugPort = await getFreePort()
    const endpointPath = join(profile, 'bridge/endpoint.json')
    const nativeConfig = join(
      root,
      '.local/share/motrix/native-messaging/appimage/appimage.json'
    )
    const appSession: {
      browser: Browser | null
      process: ReturnType<typeof spawn> | null
    } = { browser: null, process: null }
    let browser: BrowserContext | null = null
    let firefoxSession: Awaited<ReturnType<typeof launchNativeFirefox>> | null =
      null
    const downloadServer = createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': 1024,
      })
      res.end(Buffer.alloc(1024, 42))
    })
    await new Promise<void>((resolve) =>
      downloadServer.listen(0, '127.0.0.1', resolve)
    )
    const address = downloadServer.address()
    if (address === null || typeof address === 'string')
      throw new Error('No download fixture port')
    const openImage = async () => {
      // Chromium's renderer debugging switch does not require weakening the
      // packaged Electron fuses or enabling Node inspector arguments.
      appSession.process = spawn(
        image,
        [`--remote-debugging-port=${debugPort}`],
        {
          env: {
            ...env,
            MOTRIX_USER_DATA: profile,
            MOTRIX_RPC_PORT: String(await getFreePort()),
          },
          stdio: 'ignore',
        }
      )
      await expect
        .poll(async () => {
          try {
            return (await fetch(`http://127.0.0.1:${debugPort}/json/version`))
              .ok
          } catch {
            return false
          }
        })
        .toBe(true)
      appSession.browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${debugPort}`
      )
      const appContext = appSession.browser.contexts()[0]
      if (!appContext) throw new Error('No application browser context')
      await expect
        .poll(() => appContext.pages().some((p) => p.url().includes('w=main')))
        .toBe(true)
      const main = appContext.pages().find((p) => p.url().includes('w=main'))
      if (!main) throw new Error('No main window')
      await main.getByRole('link', { name: 'Settings', exact: true }).click()
      await main.getByText('Integration', { exact: true }).first().click()
      return main
    }
    try {
      const main = await openImage()
      await expect(readFile(nativeConfig)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await main
        .getByRole('button', { name: 'Enable browser launch', exact: true })
        .click()
      await expect(
        main.getByTestId('appimage-native-host').getByRole('status')
      ).toContainText('Local installation checks passed')
      console.info('AppImage E2E: browser launch explicitly installed')
      const config = JSON.parse(await readFile(nativeConfig, 'utf8')) as {
        appImagePath: string
        bridgeDataDir: string
      }
      expect(config.appImagePath).toBe(image)
      expect(config.bridgeDataDir).toBe(join(profile, 'bridge'))
      const warmEndpoint = JSON.parse(await readFile(endpointPath, 'utf8')) as {
        port: number
        generation: string
      }
      const discovery = await fetch(
        `http://127.0.0.1:${warmEndpoint.port}/discovery`
      )
      expect(discovery.ok).toBe(true)
      expect(await discovery.json()).toMatchObject({
        app: 'motrix-bridge',
        instanceId: expect.stringMatching(/\S/u),
      })
      const mountsBefore = await readFile('/proc/self/mountinfo', 'utf8')
      const originalMount = mountsBefore
        .split('\n')
        .find((line) => line.includes('.mount_') && line.includes('Motrix'))
        ?.split(' ')[4]
      if (!originalMount)
        throw new Error(
          'The test requires a mounted AppImage, not an extracted directory'
        )
      let page: ExtensionPage
      if (browserName === 'firefox') {
        const firefoxProfile = join(root, 'firefox-profile')
        await mkdir(firefoxProfile, { mode: 0o700 })
        firefoxSession = await launchNativeFirefox({
          profile: firefoxProfile,
          extension,
          env,
        })
        page = firefoxSession.page
      } else {
        browser = await chromium.launchPersistentContext(
          join(root, '.config/chromium'),
          {
            headless: false,
            chromiumSandbox: true,
            locale: 'en-US',
            env,
            ...(process.env.MOTRIX_CHROMIUM_EXECUTABLE
              ? { executablePath: process.env.MOTRIX_CHROMIUM_EXECUTABLE }
              : {}),
            args: [
              `--disable-extensions-except=${extension}`,
              `--load-extension=${extension}`,
              '--lang=en-US',
              '--no-proxy-server',
            ],
          }
        )
        const worker =
          browser.serviceWorkers()[0] ??
          (await browser.waitForEvent('serviceworker'))
        const id = new URL(worker.url()).hostname
        // Unpacked builds have a local ID. Register it through the shipped UI,
        // with the same trust level as any user-added extension.
        await main.getByRole('button', { name: /Trusted extensions/u }).click()
        await main
          .getByRole('textbox', { name: 'Extension ID', exact: true })
          .fill(id)
        await main.getByRole('button', { name: 'Add', exact: true }).click()
        await expect(
          main.getByRole('textbox', { name: 'Extension ID', exact: true })
        ).toHaveValue('')
        const chromiumPage = await browser.newPage()
        await chromiumPage.goto(`chrome-extension://${id}/options.html`)
        page = chromiumPage
      }
      const click = async (
        name: string,
        selector = 'button',
        dialogOnly = false
      ) => {
        await expect
          .poll(() =>
            page.evaluate(
              ({ name, selector, dialogOnly }) => {
                const scope = dialogOnly
                  ? document.querySelector('[role="dialog"]')
                  : document
                const button = [
                  ...(scope?.querySelectorAll<HTMLElement>(selector) ?? []),
                ].find(
                  (node) =>
                    (node.getAttribute('aria-label') ??
                      node.textContent?.trim()) === name
                )
                if (!button || button.matches(':disabled')) return false
                button.click()
                return true
              },
              { name, selector, dialogOnly }
            )
          )
          .toBe(true)
      }
      await click('Integration', '[role="tab"]')
      await click('Pair')
      await expect
        .poll(async () => {
          await page.evaluate((port) => {
            const candidate = [
              ...document.querySelectorAll('[role="listitem"]'),
            ].find((node) => node.textContent?.includes(String(port)))
            const choose = [
              ...(candidate?.querySelectorAll('button') ?? []),
            ].find((button) => button.textContent?.trim() === 'Choose')
            choose?.click()
          }, warmEndpoint.port)
          return Boolean((await extensionState(page)).pairingCode)
        })
        .toBe(true)
      let pairingCode: string | null = null
      await expect
        .poll(async () => {
          pairingCode = await main
            .locator('span.font-mono')
            .evaluateAll(
              (nodes) =>
                nodes
                  .map((n) => n.textContent?.trim() ?? '')
                  .find((s) =>
                    /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u.test(s)
                  ) ?? null
            )
          return pairingCode !== null
        })
        .toBe(true)
      // Keep the password out of Playwright action logs and assertion output.
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(document.querySelector('#pairing-code-input'))
          )
        )
        .toBe(true)
      await page.evaluate((value: string | null) => {
        const input = document.querySelector<HTMLInputElement>(
          '#pairing-code-input'
        )
        if (!input || !value) throw new Error('Pairing input unavailable')
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )?.set?.call(input, value.replace('-', ''))
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }, pairingCode)
      pairingCode = null
      await click('Pair', 'button', true)
      await expect
        .poll(async () => (await extensionState(page)).state)
        .toBe('connected')
      console.info('AppImage E2E: first pairing authenticated')
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.querySelectorAll('button')].some(
              (button) =>
                button.textContent?.trim() === 'Reconnect' && !button.disabled
            )
          )
        )
        .toBe(true)
      const retainedIds = await credentialIds(page)
      expect(retainedIds.length).toBeGreaterThan(0)
      appSession.process?.kill('SIGTERM')
      await stopProfile(profile)
      await expect
        .poll(async () => {
          try {
            await fetch(`http://127.0.0.1:${warmEndpoint.port}/discovery`)
            return false
          } catch {
            return true
          }
        })
        .toBe(true)
      await expect
        .poll(async () =>
          (await readFile('/proc/self/mountinfo', 'utf8')).includes(
            originalMount
          )
        )
        .toBe(false)
      await expect
        .poll(async () => (await extensionState(page)).state)
        .toBe('disconnected')
      await click('Reconnect')
      await expect
        .poll(async () => (await extensionState(page)).state)
        .toBe('connected')
      console.info('AppImage E2E: browser cold launch reconnected')
      expect((await extensionState(page)).pairingCode).toBeUndefined()
      expect(await credentialIds(page)).toEqual(retainedIds)
      const coldEndpoint = JSON.parse(await readFile(endpointPath, 'utf8')) as {
        generation: string
        port: number
      }
      expect(coldEndpoint.generation).not.toBe(warmEndpoint.generation)
      const response = await page.evaluate(async (url) => {
        const runtime = (
          globalThis as typeof globalThis & {
            chrome: {
              runtime: { sendMessage(message: unknown): Promise<unknown> }
            }
          }
        ).chrome.runtime
        return runtime.sendMessage({
          kind: 'bg.submitDownload',
          payload: {
            source: {
              pageUrl: url,
              pageTitle: 'AppImage cold launch E2E',
              detectedAt: Date.now(),
            },
            selection: { kind: 'direct', primary: { url } },
            meta: {
              suggestedFilename: 'appimage-e2e.bin',
              qualityLabel: 'source',
            },
          },
        })
      }, `http://${downloadHost}:${address.port}/appimage-e2e.bin`)
      expect(response).toMatchObject({ taskId: expect.any(String) })
      await expect
        .poll(async () => {
          try {
            return (await readFile(join(root, 'downloads/appimage-e2e.bin')))
              .length
          } catch {
            return 0
          }
        })
        .toBe(1024)
      console.info('AppImage E2E: download completed with retained credentials')
      expect(await readFile(join(root, 'downloads/appimage-e2e.bin'))).toEqual(
        Buffer.alloc(1024, 42)
      )

      await stopProfile(profile)
      await expect
        .poll(async () => {
          try {
            await fetch(`http://127.0.0.1:${coldEndpoint.port}/discovery`)
            return false
          } catch {
            return true
          }
        })
        .toBe(true)
      const moved = join(root, 'Moved 中文 "AppImage".AppImage')
      await rename(image, moved)
      image = moved
      const settings = await openImage()
      const section = settings.getByTestId('appimage-native-host')
      await section
        .getByRole('button', { name: 'Use this AppImage', exact: true })
        .click()
      await expect(section.getByRole('status')).toContainText(
        'Local installation checks passed'
      )
      expect(
        JSON.parse(await readFile(nativeConfig, 'utf8')).appImagePath
      ).toBe(moved)
      console.info('AppImage E2E: moved image repaired explicitly')

      await settings
        .getByRole('switch', {
          name: 'Send downloads from browser extensions',
          exact: true,
        })
        .click()
      await settings.getByRole('button', { name: 'Save', exact: true }).click()
      await expect
        .poll(
          async () => JSON.parse(await readFile(nativeConfig, 'utf8')).enabled
        )
        .toBe(false)
      await settings.getByText('Integration', { exact: true }).first().click()
      await settings
        .getByRole('switch', {
          name: 'Send downloads from browser extensions',
          exact: true,
        })
        .click()
      await settings.getByRole('button', { name: 'Save', exact: true }).click()
      await expect
        .poll(
          async () => JSON.parse(await readFile(nativeConfig, 'utf8')).enabled
        )
        .toBe(true)
      await settings.getByText('Integration', { exact: true }).first().click()
      await settings
        .getByTestId('appimage-native-host')
        .getByRole('button', { name: 'Remove browser launch', exact: true })
        .click()
      await expect
        .poll(
          async () => JSON.parse(await readFile(nativeConfig, 'utf8')).consent
        )
        .toBe('declined')
      const removedConfig = JSON.parse(
        await readFile(nativeConfig, 'utf8')
      ) as { enabled: boolean; manifests: { path: string }[] }
      expect(removedConfig.enabled).toBe(false)
      for (const manifest of removedConfig.manifests) {
        await expect(readFile(manifest.path)).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
      await expect(
        readFile(
          join(
            root,
            '.local/share/motrix/native-messaging/appimage/motrix-appimage-native-host'
          )
        )
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await credentialIds(page)).toEqual(retainedIds)
      console.info(
        'AppImage E2E: disable, re-enable and removal preserve pairing'
      )
    } finally {
      await browser?.close().catch(() => {})
      await firefoxSession?.close().catch(() => {})
      await appSession.browser?.close().catch(() => {})
      await stopProfile(profile)
      appSession.process?.kill('SIGTERM')
      await new Promise<void>((resolve) =>
        downloadServer.close(() => resolve())
      )
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      })
    }
  })
}
