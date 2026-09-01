import { createHash, X509Certificate } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import type { BrowserContext, Page } from '@playwright/test'
import { chromium, expect, test } from '@playwright/test'
import type { ServerBridgeRuntime } from '../../src/server/bridge/bootstrap'
import { getFreePort } from '../helpers/free-port'
import {
  PUBLIC_HOST,
  pendingPairingCode,
  ROUTE_PREFIX,
  startRuntime,
  startTlsProxy,
} from './remote-extension-harness'

function certificateSpkiPin(certificatePem: string): string {
  const certificate = new X509Certificate(certificatePem)
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('base64')
}

async function launchExtension(input: {
  extensionBuild: string
  profileDir: string
  spkiPin: string
}): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext(input.profileDir, {
    ...(process.env.MOTRIX_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.MOTRIX_CHROMIUM_EXECUTABLE }
      : {}),
    headless: false,
    locale: 'en-US',
    args: [
      `--disable-extensions-except=${input.extensionBuild}`,
      `--load-extension=${input.extensionBuild}`,
      `--host-resolver-rules=MAP ${PUBLIC_HOST} 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${input.spkiPin}`,
      '--lang=en-US',
      '--no-proxy-server',
    ],
  })
  const serviceWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }))
  return {
    context,
    extensionId: new URL(serviceWorker.url()).hostname,
  }
}

async function openIntegration(
  context: BrowserContext,
  extensionId: string
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/options.html`)
  await page.getByRole('tab', { name: 'Integration' }).click()
  await expect(
    page.getByRole('list', { name: 'Available Motrix backends' })
  ).toBeVisible()
  return page
}

async function pairFromOptions(
  page: Page,
  runtime: ServerBridgeRuntime
): Promise<void> {
  const pairButton = page.getByRole('button', { name: 'Pair', exact: true })
  await expect(pairButton).toBeEnabled()
  await pairButton.click()
  const dialog = page.getByRole('dialog', { name: 'Pair with Motrix' })
  try {
    await expect(dialog).toBeVisible({ timeout: 5_000 })
  } catch {
    const state = await page.evaluate(async () => {
      const extensionGlobal = globalThis as typeof globalThis & {
        chrome: {
          runtime: {
            sendMessage(message: unknown): Promise<unknown>
          }
        }
      }
      return extensionGlobal.chrome.runtime.sendMessage({
        kind: 'bg.getState',
      })
    })
    throw new Error(
      `pairing did not reach code entry: ${JSON.stringify(state)}`
    )
  }
  await expect.poll(() => pendingPairingCode(runtime)).not.toBeNull()
  const code = await pendingPairingCode(runtime)
  if (code === null) throw new Error('remote pairing code was not queued')
  await dialog.getByLabel('Pairing code').fill(code.replace('-', ''))
  await dialog.getByRole('button', { name: 'Pair' }).click()
  await expect(page.getByText('Pairing ready')).toBeVisible()
  await expect(page.getByText('Connected')).toBeVisible()
}

async function addServerFromOptions(
  page: Page,
  name: string,
  url: string
): Promise<void> {
  await page.getByRole('button', { name: 'Add server' }).click()
  const editor = page.getByRole('dialog', { name: 'Add Motrix Server' })
  await editor.getByLabel('Server name').fill(name)
  await editor.getByLabel('WebSocket URL').fill(url)
  await editor.getByRole('button', { name: 'Save server' }).click()
}

async function submitFromExtension(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const extensionGlobal = globalThis as typeof globalThis & {
      chrome: {
        runtime: {
          sendMessage(message: unknown): Promise<unknown>
        }
      }
    }
    const response = await extensionGlobal.chrome.runtime.sendMessage({
      kind: 'bg.submitDownload',
      payload: {
        source: {
          pageUrl: 'https://example.com/watch',
          pageTitle: 'Remote browser E2E',
          detectedAt: Date.now(),
        },
        selection: {
          kind: 'direct',
          primary: {
            url: 'https://cdn.example.com/video.mp4',
            headers: {
              Authorization: 'Bearer must-not-cross-without-consent',
              Referer: 'https://example.com/watch',
            },
            cookies: [
              {
                name: 'session',
                value: 'must-not-cross-without-consent',
                domain: 'example.com',
              },
            ],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
        },
        meta: {
          suggestedFilename: 'video.mp4',
          qualityLabel: 'source',
        },
      },
    })
    return response
  })
}

async function actionBadgeText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const extensionGlobal = globalThis as typeof globalThis & {
      chrome: {
        action: {
          getBadgeText(details: Record<string, never>): Promise<string>
        }
      }
    }
    return extensionGlobal.chrome.action.getBadgeText({})
  })
}

for (const routePrefix of [ROUTE_PREFIX, ''])
  test(`real Chromium: pair, consent, submit, restart, revoke, and re-pair over WSS (${routePrefix || 'root path'})`, async () => {
    const extensionBuild = process.env.MOTRIX_EXTENSION_BUILD
    if (!extensionBuild || !existsSync(join(extensionBuild, 'manifest.json'))) {
      throw new Error(
        'MOTRIX_EXTENSION_BUILD must point to a built Chromium Extension directory'
      )
    }

    const fixtureRoot = join(process.cwd(), 'src/server/bridge/__fixtures__')
    const [cert, key] = await Promise.all([
      readFile(join(fixtureRoot, 'motrix.test-cert.pem'), 'utf8'),
      readFile(join(fixtureRoot, 'motrix.test-key.pem'), 'utf8'),
    ])
    const root = await mkdtemp(join(tmpdir(), 'motrix-remote-browser-e2e-'))
    const serverDataDir = join(root, 'server')
    const profileDir = join(root, 'chromium-profile')
    const [bridgePort, proxyPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
    ])
    const submissions: DownloadSubmitParams[] = []
    let runtime: ServerBridgeRuntime | null = null
    let context: BrowserContext | null = null
    let closeProxy: (() => Promise<void>) | null = null

    try {
      runtime = await startRuntime({
        dataDir: serverDataDir,
        bridgePort,
        proxyPort,
        submissions,
        routePrefix,
      })
      closeProxy = await startTlsProxy({
        listenPort: proxyPort,
        upstreamPort: bridgePort,
        key,
        cert,
      })
      const launch = await launchExtension({
        extensionBuild,
        profileDir,
        spkiPin: certificateSpkiPin(cert),
      })
      context = launch.context
      let extensionId = launch.extensionId
      let page = await openIntegration(context, extensionId)

      const discoveryProbe = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url, {
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
          })
          return { status: response.status, body: await response.json() }
        } catch (cause) {
          return {
            error: cause instanceof Error ? cause.message : String(cause),
          }
        }
      }, `https://${PUBLIC_HOST}:${proxyPort}${routePrefix}/discovery`)
      expect(discoveryProbe).toMatchObject({
        status: 200,
        body: { runtime: 'server' },
      })

      await page.getByRole('button', { name: 'Add server' }).click()
      const editor = page.getByRole('dialog', { name: 'Add Motrix Server' })
      await editor.getByLabel('Server name').fill('Remote E2E')
      await editor
        .getByLabel('WebSocket URL')
        .fill(`wss://${PUBLIC_HOST}:${proxyPort}${routePrefix}`)
      await editor.getByRole('button', { name: 'Save server' }).click()
      await page.getByRole('button', { name: 'Use Remote E2E' }).click()
      await pairFromOptions(page, runtime)

      await expect(submitFromExtension(page)).resolves.toMatchObject({
        error: expect.stringMatching(
          /remote (?:download )?data boundary consent is required/i
        ),
      })
      await page.getByRole('button', { name: 'Allow remote downloads' }).click()
      await expect(
        page.getByRole('switch', { name: 'Send request headers' })
      ).toBeVisible()
      await page.reload()
      await page.getByRole('tab', { name: 'Integration' }).click()
      await expect(page.getByText('Connected')).toBeVisible()
      await expect(submitFromExtension(page)).resolves.toEqual({
        taskId: 'browser-task-1',
      })
      await expect.poll(() => actionBadgeText(page)).toBe('↓')
      expect(submissions).toHaveLength(1)
      expect(submissions[0]?.selection.kind).toBe('direct')
      if (submissions[0]?.selection.kind !== 'direct') {
        throw new Error('expected direct submission')
      }
      expect(submissions[0].selection.primary.headers).toEqual({})
      expect(submissions[0].selection.primary.cookies).toEqual([])

      await context.close()
      context = null
      const relaunched = await launchExtension({
        extensionBuild,
        profileDir,
        spkiPin: certificateSpkiPin(cert),
      })
      context = relaunched.context
      extensionId = relaunched.extensionId
      page = await openIntegration(context, extensionId)
      await expect(page.getByText('Pairing ready')).toBeVisible()
      await expect(page.getByText('Connected')).toBeVisible()
      await expect(submitFromExtension(page)).resolves.toEqual({
        taskId: 'browser-task-2',
      })

      await runtime.shutdown()
      runtime = await startRuntime({
        dataDir: serverDataDir,
        bridgePort,
        proxyPort,
        submissions,
        routePrefix,
      })
      await expect
        .poll(() => submitFromExtension(page), { timeout: 20_000 })
        .toEqual({
          taskId: 'browser-task-3',
        })

      const paired = (await runtime.bridgeQueryHandlers[
        'bridge:listPaired'
      ]()) as Array<{
        kind: string
        id: string
        browser?: 'chromium' | 'firefox'
      }>
      const pairedExtension = paired.find(
        (client) => client.kind === 'extension' && client.id === extensionId
      )
      if (!pairedExtension?.browser) {
        throw new Error('paired Extension was not projected by Server')
      }
      await runtime.bridgeCommandHandlers['bridge:revokePair']({
        identity: {
          kind: 'extension',
          browser: pairedExtension.browser,
          extensionId: pairedExtension.id,
        },
      })
      await page.reload()
      await page.getByRole('tab', { name: 'Integration' }).click()
      await expect(page.getByText('Not paired')).toBeVisible()
      await pairFromOptions(page, runtime)
      await expect(page.getByText('Pairing ready')).toBeVisible()
    } finally {
      if (context !== null) await context.close()
      if (closeProxy !== null) await closeProxy()
      if (runtime !== null) await runtime.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })

test('real Chromium: local profile keeps two remote Servers paired and policy-isolated', async () => {
  const extensionBuild = process.env.MOTRIX_EXTENSION_BUILD
  if (!extensionBuild || !existsSync(join(extensionBuild, 'manifest.json'))) {
    throw new Error(
      'MOTRIX_EXTENSION_BUILD must point to a built Chromium Extension directory'
    )
  }

  const fixtureRoot = join(process.cwd(), 'src/server/bridge/__fixtures__')
  const [cert, key] = await Promise.all([
    readFile(join(fixtureRoot, 'motrix.test-cert.pem'), 'utf8'),
    readFile(join(fixtureRoot, 'motrix.test-key.pem'), 'utf8'),
  ])
  const root = await mkdtemp(join(tmpdir(), 'motrix-two-server-e2e-'))
  const profileDir = join(root, 'chromium-profile')
  const serverDataDirA = join(root, 'server-a')
  const serverDataDirB = join(root, 'server-b')
  const [bridgePortA, proxyPortA, bridgePortB, proxyPortB] = await Promise.all([
    getFreePort(),
    getFreePort(),
    getFreePort(),
    getFreePort(),
  ])
  const submissionsA: DownloadSubmitParams[] = []
  const submissionsB: DownloadSubmitParams[] = []
  let runtimeA: ServerBridgeRuntime | null = null
  let runtimeB: ServerBridgeRuntime | null = null
  let context: BrowserContext | null = null
  let closeProxyA: (() => Promise<void>) | null = null
  let closeProxyB: (() => Promise<void>) | null = null

  try {
    runtimeA = await startRuntime({
      dataDir: serverDataDirA,
      bridgePort: bridgePortA,
      proxyPort: proxyPortA,
      submissions: submissionsA,
      routePrefix: ROUTE_PREFIX,
    })
    runtimeB = await startRuntime({
      dataDir: serverDataDirB,
      bridgePort: bridgePortB,
      proxyPort: proxyPortB,
      submissions: submissionsB,
      routePrefix: ROUTE_PREFIX,
    })
    closeProxyA = await startTlsProxy({
      listenPort: proxyPortA,
      upstreamPort: bridgePortA,
      key,
      cert,
    })
    closeProxyB = await startTlsProxy({
      listenPort: proxyPortB,
      upstreamPort: bridgePortB,
      key,
      cert,
    })
    const launched = await launchExtension({
      extensionBuild,
      profileDir,
      spkiPin: certificateSpkiPin(cert),
    })
    context = launched.context
    const page = await openIntegration(context, launched.extensionId)

    await addServerFromOptions(
      page,
      'Server A',
      `wss://${PUBLIC_HOST}:${proxyPortA}${ROUTE_PREFIX}`
    )
    await page.getByRole('button', { name: 'Use Server A' }).click()
    await pairFromOptions(page, runtimeA)
    await page.getByRole('button', { name: 'Allow remote downloads' }).click()
    await page.reload()
    await page.getByRole('tab', { name: 'Integration' }).click()
    await expect(page.getByText('Connected')).toBeVisible()
    await expect(submitFromExtension(page)).resolves.toEqual({
      taskId: 'browser-task-1',
    })

    await addServerFromOptions(
      page,
      'Server B',
      `wss://${PUBLIC_HOST}:${proxyPortB}${ROUTE_PREFIX}`
    )
    await page.getByRole('button', { name: 'Use Server B' }).click()
    await pairFromOptions(page, runtimeB)
    await expect(submitFromExtension(page)).resolves.toMatchObject({
      error: expect.stringMatching(/remote (?:download )?data boundary/i),
    })
    expect(submissionsA).toHaveLength(1)
    expect(submissionsB).toHaveLength(0)

    await page.getByRole('button', { name: 'Allow remote downloads' }).click()
    await page.reload()
    await page.getByRole('tab', { name: 'Integration' }).click()
    await expect(page.getByText('Connected')).toBeVisible()
    await expect(submitFromExtension(page)).resolves.toEqual({
      taskId: 'browser-task-1',
    })
    expect(submissionsB).toHaveLength(1)

    await page.getByRole('button', { name: 'Use Server A' }).click()
    await expect(page.getByText('Pairing ready')).toBeVisible()
    await expect
      .poll(() => submitFromExtension(page), { timeout: 20_000 })
      .toEqual({ taskId: 'browser-task-2' })
    expect(submissionsA).toHaveLength(2)
    expect(submissionsB).toHaveLength(1)

    for (const runtime of [runtimeA, runtimeB]) {
      const paired = (await runtime.bridgeQueryHandlers[
        'bridge:listPaired'
      ]()) as Array<{ kind: string; id: string }>
      expect(paired).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'extension',
            id: launched.extensionId,
            browser: 'chromium',
            identityTrust: 'attested-non-official',
            status: 'ready',
            pairedAt: expect.any(Number),
          }),
        ])
      )
    }

    // An authority-changing URL edit is a fresh trust boundary even when the
    // proxy reaches the same durable Server identity. Retire A's old
    // credential/policy, re-pair on the root route, and prove B remains
    // untouched.
    await runtimeA.shutdown()
    runtimeA = await startRuntime({
      dataDir: serverDataDirA,
      bridgePort: bridgePortA,
      proxyPort: proxyPortA,
      submissions: submissionsA,
      routePrefix: '',
    })
    await page.getByRole('button', { name: 'Edit Server A' }).click()
    const editor = page.getByRole('dialog', { name: 'Edit Motrix Server' })
    const urlInput = editor.getByLabel('WebSocket URL')
    await urlInput.fill(`wss://${PUBLIC_HOST}:${proxyPortA}`)
    await editor.getByRole('button', { name: 'Save server' }).click()
    await expect(page.getByText('Not paired')).toBeVisible()

    await pairFromOptions(page, runtimeA)
    await expect(submitFromExtension(page)).resolves.toMatchObject({
      error: expect.stringMatching(/remote (?:download )?data boundary/i),
    })
    await page.getByRole('button', { name: 'Allow remote downloads' }).click()
    await page.reload()
    await page.getByRole('tab', { name: 'Integration' }).click()
    await expect(page.getByText('Connected')).toBeVisible()
    await expect(submitFromExtension(page)).resolves.toEqual({
      taskId: 'browser-task-3',
    })
    expect(submissionsA).toHaveLength(3)
    expect(submissionsB).toHaveLength(1)
  } finally {
    if (context !== null) await context.close()
    if (closeProxyB !== null) await closeProxyB()
    if (closeProxyA !== null) await closeProxyA()
    if (runtimeB !== null) await runtimeB.shutdown()
    if (runtimeA !== null) await runtimeA.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
