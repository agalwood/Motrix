export const PROBE_STORAGE_KEY = 'safariNativeProbe'

// This module is copied only into the packaged development harness.
export async function probeNativeMessaging(api, timeoutMs = 5_000) {
  const requestId = crypto.randomUUID()
  let timer
  try {
    const response = await Promise.race([
      Promise.resolve().then(() =>
        api.runtime.sendNativeMessage('app.motrix.bridge', {
          action: 'ping',
          protocolVersion: 1,
          requestId,
        })
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      }),
    ])
    if (
      response?.action !== 'pong' ||
      response.protocolVersion !== 1 ||
      response.requestId !== requestId ||
      response.capabilities?.bootstrap !== false
    ) {
      throw new Error('invalid-response')
    }
    return { status: 'ok', protocolVersion: 1, bootstrap: false }
  } catch (error) {
    const code =
      error instanceof Error &&
      ['timeout', 'invalid-response'].includes(error.message)
        ? error.message
        : 'native-unavailable'
    return { status: 'error', code }
  } finally {
    clearTimeout(timer)
  }
}

export function installNativeProbe(api) {
  let inFlight
  const run = async () => {
    const attemptId = crypto.randomUUID()
    const startedAt = new Date().toISOString()
    await api.storage.local.set({
      [PROBE_STORAGE_KEY]: { status: 'pending', attemptId, startedAt },
    })
    const result = await probeNativeMessaging(api)
    await api.storage.local.set({
      [PROBE_STORAGE_KEY]: {
        ...result,
        attemptId,
        startedAt,
        checkedAt: new Date().toISOString(),
      },
    })
    console.info('[Motrix Extension]', result)
  }
  const start = () => {
    inFlight ??= run()
      .catch(() => {
        console.warn('[Motrix Extension] Could not save diagnostic result')
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }
  api.runtime.onInstalled.addListener(start)
  api.runtime.onStartup.addListener(start)
  start()
  return start
}

const api = globalThis.browser
if (api?.runtime?.id) installNativeProbe(api)
