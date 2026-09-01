import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { expect, test } from '@playwright/test'
import WebSocket from 'ws'
import type { ServerBridgeRuntime } from '../../src/server/bridge/bootstrap'
import { getFreePort } from '../helpers/free-port'
import {
  PUBLIC_HOST,
  pendingPairingCode,
  ROUTE_PREFIX,
  startRuntime,
  startTlsProxy,
} from './remote-extension-harness'

const FIREFOX_UUID = '4d239095-47b4-4e18-a828-03c827da0a62'

interface BidiResponse {
  type: 'success' | 'error'
  id: number
  result?: unknown
  error?: string
  message?: string
}

class BidiClient {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void }
  >()

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.receive(JSON.parse(String(data))))
  }

  static async connect(url: string): Promise<BidiClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return new BidiClient(socket)
  }

  command(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve())
      this.socket.close()
    })
  }

  private receive(message: BidiResponse): void {
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    if (message.type === 'error') {
      waiter.reject(
        new Error(`${message.error ?? 'BiDi error'}: ${message.message ?? ''}`)
      )
    } else {
      waiter.resolve(message.result)
    }
  }
}

interface FirefoxSession {
  client: BidiClient
  context: string
  process: ChildProcess
}

async function connectBidi(url: string): Promise<BidiClient> {
  const deadline = Date.now() + 20_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      return await BidiClient.connect(url)
    } catch (cause) {
      lastError = cause
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('Firefox BiDi did not start', { cause: lastError })
}

function remoteValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const remote = value as { type?: string; value?: unknown }
  if (remote.type === 'undefined' || remote.type === 'null') return null
  if (remote.type === 'object' && Array.isArray(remote.value)) {
    return Object.fromEntries(
      remote.value.map(([key, item]) => [key, remoteValue(item)])
    )
  }
  if (remote.type === 'array' && Array.isArray(remote.value)) {
    return remote.value.map(remoteValue)
  }
  return remote.value
}

async function launchFirefox(input: {
  executable: string
  extensionBuild: string
  profileDir: string
}): Promise<FirefoxSession> {
  const port = await getFreePort()
  await writeFile(
    join(input.profileDir, 'user.js'),
    [
      `user_pref("extensions.webextensions.uuids", "{\\"motrix-extension@motrix.app\\":\\"${FIREFOX_UUID}\\"}");`,
      `user_pref("network.dns.localDomains", "${PUBLIC_HOST}");`,
      'user_pref("network.dns.forceResolve", "127.0.0.1");',
      'user_pref("intl.locale.requested", "en-US");',
    ].join('\n')
  )
  const firefox = spawn(
    input.executable,
    [
      '--headless',
      '--no-remote',
      '--profile',
      input.profileDir,
      '--remote-debugging-port',
      String(port),
      '--remote-allow-system-access',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const client = await connectBidi(`ws://127.0.0.1:${port}/session`)
  await client.command('session.new', {
    capabilities: {
      alwaysMatch: { browserName: 'firefox', acceptInsecureCerts: true },
    },
  })
  await client.command('webExtension.install', {
    extensionData: { type: 'path', path: input.extensionBuild },
  })
  const tree = (await client.command('browsingContext.getTree', {})) as {
    contexts: Array<{ context: string }>
  }
  const context = tree.contexts[0]?.context
  if (!context) throw new Error('Firefox did not expose a browsing context')
  await client.command('browsingContext.navigate', {
    context,
    url: `moz-extension://${FIREFOX_UUID}/options.html`,
    wait: 'complete',
  })
  return { client, context, process: firefox }
}

async function stopFirefox(session: FirefoxSession): Promise<void> {
  await session.client.command('session.end', {}).catch(() => {})
  await session.client.close()
  if (session.process.exitCode === null) session.process.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    if (session.process.exitCode !== null) return resolve()
    session.process.once('exit', () => resolve())
  })
}

async function evaluate(
  session: FirefoxSession,
  expression: string
): Promise<unknown> {
  const response = (await session.client.command('script.evaluate', {
    expression,
    target: { context: session.context },
    awaitPromise: true,
    resultOwnership: 'none',
  })) as { type: string; result?: unknown; exceptionDetails?: unknown }
  if (response.type !== 'success') {
    throw new Error(`Firefox script failed: ${JSON.stringify(response)}`)
  }
  return remoteValue(response.result)
}

async function clickText(
  session: FirefoxSession,
  text: string,
  selector = 'button'
): Promise<void> {
  await expect
    .poll(() =>
      evaluate(
        session,
        `(() => { const el = [...document.querySelectorAll(${JSON.stringify(
          selector
        )})].find((node) => node.getAttribute('aria-label') === ${JSON.stringify(
          text
        )} || node.textContent?.trim() === ${JSON.stringify(
          text
        )}); if (!(el instanceof HTMLElement)) return false; if (('disabled' in el && Boolean(el.disabled)) || el.getAttribute('aria-disabled') === 'true') return false; el.click(); return true })()`
      )
    )
    .toBe(true)
}

async function fillLabel(
  session: FirefoxSession,
  labelText: string,
  value: string
): Promise<void> {
  await expect
    .poll(() =>
      evaluate(
        session,
        `(() => { const label = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim() === ${JSON.stringify(
          labelText
        )}); const input = label?.control ?? document.getElementById(label?.htmlFor ?? ''); if (!(input instanceof HTMLInputElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, ${JSON.stringify(
          value
        )}); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(
          value
        )} })); input.dispatchEvent(new Event('change', { bubbles: true })); return true })()`
      )
    )
    .toBe(true)
}

async function bodyIncludes(
  session: FirefoxSession,
  text: string
): Promise<boolean> {
  return Boolean(
    await evaluate(
      session,
      `document.body.innerText.includes(${JSON.stringify(text)})`
    )
  )
}

async function openIntegration(session: FirefoxSession): Promise<void> {
  await expect.poll(() => bodyIncludes(session, 'Integration')).toBe(true)
  await clickText(session, 'Integration', '[role="tab"]')
  await expect
    .poll(() =>
      evaluate(
        session,
        `document.querySelector('[aria-label="Available Motrix backends"]') !== null`
      )
    )
    .toBe(true)
}

async function pair(
  session: FirefoxSession,
  runtime: ServerBridgeRuntime
): Promise<void> {
  // A previous prompt projection must have reached its terminal transition
  // before a new click. Otherwise observing "some pending code" can mistake
  // stale Server state for this attempt and race the same-Origin busy gate.
  await expect
    .poll(() => pendingPairingCode(runtime), { timeout: 10_000 })
    .toBeNull()
  await clickText(session, 'Pair')
  let ready:
    | {
        code: string
        state: unknown
        hasInput: boolean
        body: unknown
      }
    | undefined
  try {
    await expect
      .poll(
        async () => {
          const code = await pendingPairingCode(runtime)
          const ui = (await evaluate(
            session,
            `(async () => { const state = await browser.runtime.sendMessage({kind:'bg.getState'}); const label = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim() === 'Pairing code'); const input = label?.control ?? document.getElementById(label?.htmlFor ?? ''); return {state,hasInput:input instanceof HTMLInputElement,body:document.body.innerText} })()`
          )) as { state: unknown; hasInput: boolean; body: unknown }
          ready = code === null ? undefined : { code, ...ui }
          return {
            hasCode: code !== null,
            state: (ui.state as { state?: unknown } | null)?.state,
            hasInput: ui.hasInput,
          }
        },
        { timeout: 15_000 }
      )
      .toEqual({
        hasCode: true,
        state: 'awaiting-code',
        hasInput: true,
      })
  } catch {
    throw new Error(
      `Firefox pairing did not synchronize Server/background/UI: ${JSON.stringify(ready)}`
    )
  }
  if (ready === undefined) throw new Error('Firefox pairing state missing')
  await fillLabel(session, 'Pairing code', ready.code.replace('-', ''))
  await clickText(session, 'Pair', '[role="dialog"] button')
  await expect.poll(() => bodyIncludes(session, 'Pairing ready')).toBe(true)
  await expect.poll(() => bodyIncludes(session, 'Connected')).toBe(true)
}

async function submit(session: FirefoxSession): Promise<unknown> {
  return evaluate(
    session,
    `(async () => browser.runtime.sendMessage({kind:'bg.submitDownload',payload:{source:{pageUrl:'https://example.com/watch',pageTitle:'Remote Firefox E2E',detectedAt:Date.now()},selection:{kind:'direct',primary:{url:'https://cdn.example.com/video.mp4',headers:{Authorization:'Bearer must-not-cross',Referer:'https://example.com/watch'},cookies:[{name:'session',value:'must-not-cross',domain:'example.com'}],refererPolicy:'strict-origin-when-cross-origin'}},meta:{suggestedFilename:'video.mp4',qualityLabel:'source'}}}))()`
  )
}

for (const routePrefix of [ROUTE_PREFIX, ''])
  test(`real Firefox: unverified pair, consent, reconnect, revoke, and re-pair over WSS (${routePrefix || 'root path'})`, async () => {
    const extensionBuild = process.env.MOTRIX_FIREFOX_EXTENSION_BUILD
    const firefoxExecutable =
      process.env.MOTRIX_FIREFOX_EXECUTABLE ??
      '/Applications/Firefox.app/Contents/MacOS/firefox'
    if (!extensionBuild || !existsSync(join(extensionBuild, 'manifest.json'))) {
      throw new Error(
        'MOTRIX_FIREFOX_EXTENSION_BUILD must point to the Firefox build'
      )
    }
    if (!existsSync(firefoxExecutable))
      throw new Error('Firefox executable missing')

    const fixtureRoot = join(process.cwd(), 'src/server/bridge/__fixtures__')
    const [cert, key] = await Promise.all([
      readFile(join(fixtureRoot, 'motrix.test-cert.pem'), 'utf8'),
      readFile(join(fixtureRoot, 'motrix.test-key.pem'), 'utf8'),
    ])
    const root = await mkdtemp(join(tmpdir(), 'motrix-firefox-remote-e2e-'))
    const serverDataDir = join(root, 'server')
    const profileDir = join(root, 'firefox-profile')
    await mkdir(profileDir, { recursive: true })
    const [bridgePort, proxyPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
    ])
    const submissions: DownloadSubmitParams[] = []
    let runtime: ServerBridgeRuntime | null = null
    let browser: FirefoxSession | null = null
    let closeProxy: (() => Promise<void>) | null = null

    try {
      runtime = await startRuntime({
        dataDir: serverDataDir,
        bridgePort,
        proxyPort,
        submissions,
        publicHost: '127.0.0.1',
        routePrefix,
      })
      closeProxy = await startTlsProxy({
        listenPort: proxyPort,
        upstreamPort: bridgePort,
        key,
        cert,
      })
      browser = await launchFirefox({
        executable: firefoxExecutable,
        extensionBuild,
        profileDir,
      })
      await openIntegration(browser)
      await clickText(browser, 'Add server')
      await fillLabel(browser, 'Server name', 'Remote E2E')
      await fillLabel(
        browser,
        'WebSocket URL',
        `wss://127.0.0.1:${proxyPort}${routePrefix}`
      )
      await clickText(browser, 'Save server')
      await clickText(browser, 'Use Remote E2E')
      const discovery = await evaluate(
        browser,
        `(async () => { try { const response = await fetch('https://127.0.0.1:${proxyPort}${routePrefix}/discovery', {cache:'no-store',credentials:'omit',redirect:'error'}); return {status:response.status,body:await response.json()} } catch (cause) { return {error:String(cause)} } })()`
      )
      expect(discovery).toMatchObject({ status: 200 })
      await pair(browser, runtime)

      expect(await submit(browser)).toMatchObject({
        error: expect.stringMatching(/data boundary consent is required/i),
      })
      await clickText(browser, 'Allow remote downloads')
      // A programmatic click only proves event dispatch. Wait for the UI to
      // render the policy returned by the background; that response now also
      // acknowledges completion of the required capability renegotiation.
      // Reloading before this point would test cancellation of an in-flight
      // click handler rather than MV3 persistence/recovery.
      await expect
        .poll(() =>
          evaluate(
            browser as FirefoxSession,
            `document.querySelector('[role="switch"][aria-label="Send request headers"]') !== null`
          )
        )
        .toBe(true)
      await browser.client.command('browsingContext.reload', {
        context: browser.context,
        wait: 'complete',
      })
      await openIntegration(browser)
      await expect
        .poll(() => bodyIncludes(browser as FirefoxSession, 'Connected'))
        .toBe(true)
      await expect
        .poll(() => submit(browser as FirefoxSession))
        .toEqual({ taskId: 'browser-task-1' })
      expect(submissions[0]?.selection.kind).toBe('direct')
      if (submissions[0]?.selection.kind !== 'direct')
        throw new Error('direct expected')
      expect(submissions[0].selection.primary.headers).toEqual({})
      expect(submissions[0].selection.primary.cookies).toEqual([])

      const paired = (await runtime.bridgeQueryHandlers[
        'bridge:listPaired'
      ]()) as Array<{
        kind: string
        id: string
        browser?: 'chromium' | 'firefox'
        identityTrust?: string
      }>
      const firefoxPair = paired.find((item) => item.kind === 'extension')
      expect(firefoxPair).toMatchObject({
        browser: 'firefox',
        id: FIREFOX_UUID,
        identityTrust: 'unverified',
      })

      await stopFirefox(browser)
      browser = await launchFirefox({
        executable: firefoxExecutable,
        extensionBuild,
        profileDir,
      })
      await openIntegration(browser)
      await expect
        .poll(() => bodyIncludes(browser as FirefoxSession, 'Connected'))
        .toBe(true)
      await expect
        .poll(() => submit(browser as FirefoxSession))
        .toEqual({
          taskId: 'browser-task-2',
        })

      if (!firefoxPair?.browser) throw new Error('Firefox projection missing')
      await runtime.bridgeCommandHandlers['bridge:revokePair']({
        identity: {
          kind: 'extension',
          browser: firefoxPair.browser,
          extensionId: firefoxPair.id,
        },
      })
      await browser.client.command('browsingContext.reload', {
        context: browser.context,
        wait: 'complete',
      })
      await openIntegration(browser)
      await expect
        .poll(() => bodyIncludes(browser as FirefoxSession, 'Not paired'))
        .toBe(true)
      await pair(browser, runtime)
    } finally {
      if (browser) await stopFirefox(browser).catch(() => {})
      if (closeProxy) await closeProxy()
      if (runtime) await runtime.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
