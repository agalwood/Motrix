import {
  type DownloadSubmitParams,
  DownloadSubmitResultSchema,
  InitializeResultSchema,
  type MdxpConnection,
  Methods,
} from '@motrix/mdxp/browser'
import { createConfirmedDownloadActions } from '@/background/confirmedDownload'
import { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import {
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { registerFirefoxInterception } from '@/background/interception/firefox'
import { registerWebRequestEarlyTakeover } from '@/background/interception/webRequestEarly'
import { log } from '@/background/log'
import { WebSocketClient } from '@/background/WebSocketClient'
import { extensionBrowser as browser } from '@/shared/browser'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import { TAKEOVER_DEFAULT, type TakeoverTarget } from '@/shared/takeover'

// Exercise the production adapter with Firefox's real downloads/cookies APIs.
// The backend is a loopback MDXP peer; MBP1 and desktop startup are out of scope.
let client: WebSocketClient
let connection: MdxpConnection
async function submit(params: DownloadSubmitParams) {
  let received = false
  try {
    const result = await connection.sendRequest(Methods.DownloadSubmit, {
      ...params,
      idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
    })
    submits += 1
    received = true
    return DownloadSubmitResultSchema.parse(result)
  } catch (error) {
    if ((error as { code?: number }).code === -32602)
      throw new DownloadPreparationError(DOWNLOAD_ERROR.rejected)
    // A lost response cannot establish whether the peer created a task.
    if (!received) submits += 1
    throw new DownloadOutcomeUnknownError()
  }
}
const observations: Record<string, unknown>[] = []
let config = { ...TAKEOVER_DEFAULT, enabled: true }
let submits = 0
let confirmations = 0
let nativeId: number | undefined
let nativeIds: number[] = []
let caseName = ''
let confirmationSettled = false
log.setLevel('debug')
const debug = console.debug.bind(console)
console.debug = (...args: unknown[]) => {
  if (args[1] === '[takeover] probe outcome=')
    observations.push({ event: 'probe', outcome: args[2], head: args[4] })
  debug(...args)
}
browser.downloads.onCreated.addListener((item) => {
  if (!item.url.endsWith(`/download/${caseName}`)) return
  nativeId = item.id
  nativeIds.push(item.id)
  observations.push({
    event: 'created',
    totalBytes: item.totalBytes,
    mime: item.mime,
  })
})
browser.downloads.onChanged.addListener((delta) => {
  if (!nativeIds.includes(delta.id)) return
  observations.push({ event: 'changed', keys: Object.keys(delta) })
})
const deps = {
  getConfig: async () => config,
  isPaired: async () => true,
  gate: { shouldAutoConnect: async () => true },
  nudge: { maybeNudge: async () => {} },
  captureGuard: async () => ({ origin: 'auto', assertCurrent() {} }),
  selfExtensionId: browser.runtime.id,
  manager: {
    getState: () => 'connected',
    getRpcStatus: () => ({ health: 'healthy' }),
    submitDownload: submit,
  },
  confirm: async (target: TakeoverTarget) => {
    confirmations += 1
    observations.push({ event: 'confirmed', sizeBytes: target.sizeBytes })
  },
  notify() {},
} as unknown as ChromiumInterceptionDeps
registerFirefoxInterception(deps)
registerWebRequestEarlyTakeover(deps, {
  confirmRequest: async (target, windowId, guard) => {
    confirmations += 1
    const confirmation = new DownloadConfirmationService({
      supported: () => true,
      open: async () => {},
      publish: () => {},
      userAgent: () => navigator.userAgent,
    })
    const actions = createConfirmedDownloadActions(
      {
        ...deps,
        confirmation,
        submissions: {
          run: async (request, prepare) => {
            const params = await prepare({ assertCurrent() {} } as Parameters<
              typeof prepare
            >[0])
            return submit({ ...params, idempotencyKey: request.idempotencyKey })
          },
        },
      },
      target,
      guard
    )
    const result = confirmation.request(target, windowId, actions)
    await new Promise((resolve) => setTimeout(resolve, 300))
    observations.push({
      event: 'confirmation-hold',
      nativeCount: nativeIds.length,
    })
    if (windowId === undefined) throw new Error('No originating window')
    const draft = confirmation.get(windowId)
    if (!draft) throw new Error('No confirmation draft')
    const action =
      caseName === 'early-confirm-accept'
        ? 'submit'
        : caseName === 'early-confirm-browser'
          ? 'browser'
          : 'cancel'
    confirmation.decide(windowId, draft.id, { action, options: draft.options })
    const decision = await result
    confirmationSettled = true
    observations.push({
      event: 'confirmation-settled',
      action: decision.action,
    })
    return decision
  },
})

Object.assign(window, {
  async checkFetchReceiver(baseUrl: string) {
    const injected = { fetch: globalThis.fetch }
    let unboundError = ''
    try {
      await injected.fetch(`${baseUrl}/receiver-probe`)
    } catch (error) {
      unboundError = String(error)
    }
    const bound = await injected.fetch.call(
      globalThis,
      `${baseUrl}/receiver-probe`
    )
    return { unboundError, boundStatus: bound.status }
  },
  async runCase(input: { baseUrl: string; name: string }) {
    client?.close()
    client = new WebSocketClient()
    connection = await client.connect(
      `${input.baseUrl.replace('http:', 'ws:')}/mdxp?case=${encodeURIComponent(input.name)}`,
      'motrix-mdxp-test'
    )
    connection.listen()
    InitializeResultSchema.parse(
      await connection.sendRequest(Methods.MotrixInitialize, {
        protocolVersion: '1.0',
        client: {
          kind: 'extension',
          name: 'takeover-fixture',
          version: '1.0',
          extensionId: browser.runtime.id,
          browser: 'firefox',
          browserVersion: navigator.userAgent,
          locale: 'en',
        },
        capabilities: { submitDownload: true },
        adapters: [],
      })
    )
    observations.length = 0
    submits = 0
    confirmations = 0
    nativeId = undefined
    nativeIds = []
    caseName = input.name
    confirmationSettled = false
    await browser.storage.local.set({
      'motrix.earlyTakeover': {
        enabled: input.name.startsWith('early-') && input.name !== 'early-kill',
      },
    })
    if (input.name === 'early-default')
      await browser.storage.local.remove('motrix.earlyTakeover')
    config = {
      ...TAKEOVER_DEFAULT,
      enabled: input.name !== 'early-off',
      downloadMode:
        input.name === 'confirm' || input.name.startsWith('early-confirm-')
          ? 'confirm'
          : 'direct',
      unknownSizeAction: input.name === 'unknown-motrix' ? 'motrix' : 'chrome',
      rules: ['small', 'early-small'].includes(input.name)
        ? [{ id: 'small', match: { minSizeMB: 10 }, action: 'chrome' }]
        : input.name === 'early-excluded'
          ? [
              {
                id: 'excluded',
                match: { domains: ['127.0.0.1'] },
                action: 'chrome',
              },
            ]
          : [],
    }
    const tab = await browser.tabs.create({
      url: `${input.baseUrl}/start/${input.name}`,
    })
    const deadline =
      Date.now() + (input.name.startsWith('early-') ? 1800 : 4200)
    while (Date.now() < deadline && submits === 0 && confirmations === 0)
      await new Promise((resolve) => setTimeout(resolve, 50))
    if (input.name.startsWith('early-'))
      await new Promise((resolve) => setTimeout(resolve, 500))
    if (input.name.startsWith('early-confirm-')) {
      // Persisting the decision and creating a native download are asynchronous.
      // Wait for the actual outcome instead of attributing late events to the next case.
      const confirmationDeadline = Date.now() + 5000
      while (
        Date.now() < confirmationDeadline &&
        (!confirmationSettled ||
          (input.name === 'early-confirm-browser' && nativeIds.length === 0))
      )
        await new Promise((resolve) => setTimeout(resolve, 50))
      if (!confirmationSettled)
        observations.push({ event: 'confirmation-timeout' })
    }
    const items =
      nativeId === undefined
        ? []
        : await browser.downloads.search({ id: nativeId })
    const result = {
      name: input.name,
      submits,
      confirmations,
      observations: [...observations],
      nativeCount: nativeIds.length,
      native: items.map(({ state, totalBytes, paused }) => ({
        state,
        totalBytes,
        paused,
      })),
    }
    for (const id of nativeIds) {
      await browser.downloads.cancel(id).catch(() => {})
      await browser.downloads.erase({ id })
    }
    if (tab.id !== undefined) await browser.tabs.remove(tab.id)
    // Let cancellation events settle before clearing observations for the next case.
    await new Promise((resolve) => setTimeout(resolve, 100))
    client.close()
    return result
  },
})
