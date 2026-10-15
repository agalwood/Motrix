import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  installNativeProbe,
  PROBE_STORAGE_KEY,
  probeNativeMessaging,
} from '../../native/safari/probe.js'

function apiWithReply(reply) {
  return {
    runtime: {
      sendNativeMessage: async (host, request) => {
        assert.equal(host, 'app.motrix.bridge')
        assert.deepEqual(Object.keys(request).sort(), [
          'action',
          'protocolVersion',
          'requestId',
        ])
        assert.equal(request.action, 'ping')
        assert.equal(request.protocolVersion, 1)
        assert.match(request.requestId, /^[0-9a-f-]{36}$/)
        return reply(request)
      },
    },
  }
}

test('accepts a matching native pong without enabling bootstrap', async () => {
  const api = apiWithReply(({ requestId }) => ({
    action: 'pong',
    protocolVersion: 1,
    requestId,
    capabilities: { bootstrap: false },
  }))
  assert.deepEqual(await probeNativeMessaging(api), {
    status: 'ok',
    protocolVersion: 1,
    bootstrap: false,
  })
})

for (const [name, change] of [
  ['missing response', () => undefined],
  ['null response', () => null],
  ['array response', () => []],
  ['unexpected action', (reply) => ({ ...reply, action: 'requestPair' })],
  ['unsupported version', (reply) => ({ ...reply, protocolVersion: 2 })],
  ['wrong request', (reply) => ({ ...reply, requestId: crypto.randomUUID() })],
  ['missing capability', (reply) => ({ ...reply, capabilities: undefined })],
  [
    'unexpected bootstrap',
    (reply) => ({ ...reply, capabilities: { bootstrap: true } }),
  ],
]) {
  test(`rejects ${name}`, async () => {
    const api = apiWithReply(({ requestId }) =>
      change({
        action: 'pong',
        protocolVersion: 1,
        requestId,
        capabilities: { bootstrap: false },
      })
    )
    assert.deepEqual(await probeNativeMessaging(api), {
      status: 'error',
      code: 'invalid-response',
    })
  })
}

test('reports a missing native handler without persisting the raw error', async () => {
  const api = apiWithReply(() => {
    throw new Error('private host error details')
  })
  assert.deepEqual(await probeNativeMessaging(api), {
    status: 'error',
    code: 'native-unavailable',
  })
})

test('bounds a native request that does not respond', async () => {
  const api = apiWithReply(() => new Promise(() => {}))
  assert.deepEqual(await probeNativeMessaging(api, 5), {
    status: 'error',
    code: 'timeout',
  })
})

test('coalesces startup events and replaces old results with a pending attempt', async () => {
  const writes = []
  const listeners = []
  let calls = 0
  const api = apiWithReply(({ requestId }) => {
    calls++
    assert.equal(writes.at(-1)[PROBE_STORAGE_KEY].status, 'pending')
    return {
      action: 'pong',
      protocolVersion: 1,
      requestId,
      capabilities: { bootstrap: false },
    }
  })
  api.runtime.onInstalled = {
    addListener: (listener) => listeners.push(listener),
  }
  api.runtime.onStartup = {
    addListener: (listener) => listeners.push(listener),
  }
  api.storage = { local: { set: async (value) => writes.push(value) } }
  const run = installNativeProbe(api)
  await Promise.all([run(), ...listeners.map((listener) => listener())])
  assert.equal(calls, 1)
  assert.equal(writes.length, 2)
  assert.equal(writes[1][PROBE_STORAGE_KEY].status, 'ok')
  assert.equal(
    writes[0][PROBE_STORAGE_KEY].attemptId,
    writes[1][PROBE_STORAGE_KEY].attemptId
  )
  await run()
  assert.equal(calls, 2)
  assert.notEqual(
    writes[1][PROBE_STORAGE_KEY].attemptId,
    writes[3][PROBE_STORAGE_KEY].attemptId
  )
})
