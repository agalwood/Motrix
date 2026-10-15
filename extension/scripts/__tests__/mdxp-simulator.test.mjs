import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createMdxpSimulator } from '../fixtures/mdxp-simulator.mjs'

const initialize = {
  protocolVersion: '1.0',
  client: {
    kind: 'extension',
    name: 'test',
    version: '1',
    extensionId: 'test@example.com',
    browser: 'firefox',
    browserVersion: '143.0',
    locale: 'en',
  },
  capabilities: {},
  adapters: [],
}
const submission = {
  idempotencyKey: 'test-operation-1',
  source: {
    pageUrl: 'http://127.0.0.1/page',
    pageTitle: 'Fixture',
    detectedAt: 1,
  },
  selection: {
    kind: 'direct',
    primary: {
      url: 'http://127.0.0.1/file',
      cookies: [],
      headers: {},
      refererPolicy: 'no-referrer',
    },
  },
  meta: { suggestedFilename: 'file.zip', qualityLabel: 'file' },
}

async function fixture(t, scenario = 'normal') {
  const server = createServer()
  const simulator = createMdxpSimulator(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await simulator.close()
    await new Promise((resolve) => server.close(resolve))
  })
  let sequence = 0
  async function connect() {
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/mdxp?case=${scenario}`
    )
    await once(socket, 'open')
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => finish(new Error('RPC timeout')), 2000)
        function finish(error, value) {
          clearTimeout(timer)
          socket.off('message', message)
          socket.off('close', close)
          error ? reject(error) : resolve(value)
        }
        function message(raw) {
          const value = JSON.parse(raw.toString())
          if (value.id === id) finish(null, value)
        }
        const close = () => finish(new Error('Connection closed'))
        socket.on('message', message)
        socket.once('close', close)
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    const response = await request('motrix/initialize', initialize)
    assert.equal(response.result.protocolVersion, '1.0')
    return request
  }
  return { connect, snapshot: () => simulator.snapshot(scenario) }
}

test('same operation survives reconnect; distinct operations remain distinct', {
  timeout: 5000,
}, async (t) => {
  const peer = await fixture(t)
  const first = await peer.connect()
  const accepted = await first('download/submit', submission)
  const second = await peer.connect()
  assert.deepEqual(
    (await second('download/submit', submission)).result,
    accepted.result
  )
  await second('download/submit', {
    ...submission,
    idempotencyKey: 'test-operation-2',
  })
  assert.equal(peer.snapshot().taskCount, 2)
})
test('lost acceptance reply leaves one task and same-key retry returns it', {
  timeout: 5000,
}, async (t) => {
  const peer = await fixture(t, 'early-unknown')
  const first = await peer.connect()
  await assert.rejects(first('download/submit', submission), /closed/)
  assert.equal(peer.snapshot().taskCount, 1)
  const second = await peer.connect()
  assert.equal(
    (await second('download/submit', submission)).result.taskId,
    'sim-1'
  )
  assert.equal(peer.snapshot().taskCount, 1)
})
test('disconnect before creation leaves no task', {
  timeout: 5000,
}, async (t) => {
  const peer = await fixture(t, 'early-disconnect-before')
  const request = await peer.connect()
  await assert.rejects(request('download/submit', submission), /closed/)
  assert.equal(peer.snapshot().taskCount, 0)
})
test('invalid schema and changed operation payload cannot create extra tasks', {
  timeout: 5000,
}, async (t) => {
  const peer = await fixture(t)
  const request = await peer.connect()
  assert.equal((await request('download/submit', {})).error.code, -32602)
  await request('download/submit', submission)
  const changed = {
    ...submission,
    meta: { ...submission.meta, suggestedFilename: 'different.zip' },
  }
  assert.equal((await request('download/submit', changed)).error.code, -32602)
  assert.equal(peer.snapshot().taskCount, 1)
})
