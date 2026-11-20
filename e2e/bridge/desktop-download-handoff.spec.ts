import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { Methods, Notifications } from '@motrix/mdxp/node'
import type { ElectronApplication } from '@playwright/test'
import {
  exchangeCredential,
  initializeParams,
  mdxpOverChannel,
  reconnect,
  runPake,
  startPair,
} from '../../src/core/bridge/__tests__/mbp1-client'
import {
  expect,
  launchMotrix,
  test,
  waitForEngineReady,
} from '../fixtures/electron-app'

test.use({ trace: 'off', screenshot: 'off' })
test('desktop resumes a prepared handoff after restart with new handoffs disabled', async ({
  userDataDir,
  rpcPort,
}) => {
  test.setTimeout(120000)
  const id = 'lggbokfckofcgjndaboioakcmincinpo'
  const origin = 'chrome-extension://' + id
  const file = Buffer.from('same committed desktop handoff')
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.method ?? '')
    res.writeHead(200, { 'Content-Length': file.length }).end(file)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint = server.address()
  if (!endpoint || typeof endpoint === 'string')
    throw new Error('Missing fixture address')
  const url = `http://127.0.0.1:${endpoint.port}/desktop.bin`
  await mkdir(path.join(userDataDir, 'downloads'), { recursive: true })
  let app: ElectronApplication | undefined
  async function launch(enabled: boolean) {
    app = await launchMotrix({
      userDataDir,
      rpcPort,
      extraEnv: { MOTRIX_DOWNLOAD_HANDOFF: enabled ? '1' : '0' },
    })
    const page = await app.firstWindow()
    await waitForEngineReady(page)
    const port = JSON.parse(
      await readFile(path.join(userDataDir, 'bridge', 'endpoint.json'), 'utf8')
    ).port as number
    return { app, page, port }
  }
  try {
    const first = await launch(true)
    const attempt = await startPair({
      port: first.port,
      origin,
      browser: 'chromium',
      claimedExtensionId: id,
    })
    let code: string | undefined
    await expect
      .poll(async () => {
        const entries = await first.page.evaluate(
          async () =>
            (await window.motrix.invoke(
              'bridge:listPendingPairRequests'
            )) as Array<{ kind: string; code?: string }>
        )
        code = entries.find((e) => e.kind === 'extension')?.code
        return Boolean(code)
      })
      .toBe(true)
    if (!code) throw new Error('No local pairing prompt')
    const { channel } = await runPake(attempt, code)
    const credential = await exchangeCredential(attempt, channel)
    const conn = mdxpOverChannel(attempt.wire, channel)
    const init = await conn.sendRequest(
      Methods.MotrixInitialize,
      initializeParams(id)
    )
    conn.sendNotification(Notifications.MotrixInitialized, undefined as never)
    const capability = init.capabilities.downloadHandoff
    expect(capability?.acceptingNew).toBe(true)
    if (!capability) throw new Error('No desktop handoff capability')
    const key = { instanceId: capability.instanceId, operationId: randomUUID() }
    const download = {
      source: { pageUrl: url, pageTitle: 'local', detectedAt: 1 },
      selection: {
        kind: 'direct' as const,
        primary: {
          url,
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin',
        },
      },
      meta: { suggestedFilename: 'desktop.bin', qualityLabel: 'source' },
    }
    const prepared = await conn.sendRequest(Methods.DownloadHandoffPrepare, {
      ...key,
      download,
    })
    if (prepared.state !== 'prepared')
      throw new Error('Expected prepared handoff')
    expect(requests).toEqual([])
    conn.dispose()
    attempt.wire.ws.close()
    await first.app.close()
    app = undefined
    const second = await launch(false)
    const peer = await reconnect({
      port: second.port,
      origin,
      instanceId: attempt.instanceId,
      credential,
    })
    const resumed = mdxpOverChannel(peer.wire, peer.channel)
    const next = await resumed.sendRequest(
      Methods.MotrixInitialize,
      initializeParams(id)
    )
    resumed.sendNotification(
      Notifications.MotrixInitialized,
      undefined as never
    )
    expect(next.capabilities.downloadHandoff).toMatchObject({
      instanceId: key.instanceId,
      acceptingNew: false,
    })
    await expect(
      resumed.sendRequest(Methods.DownloadHandoffPrepare, {
        ...key,
        operationId: randomUUID(),
        download,
      })
    ).rejects.toThrow()
    expect(
      await resumed.sendRequest(Methods.DownloadHandoffStatus, key)
    ).toEqual(prepared)
    const commit = { ...key, payloadHash: prepared.payloadHash }
    const receipt = await resumed.sendRequest(
      Methods.DownloadHandoffCommit,
      commit
    )
    expect(receipt).toMatchObject({
      state: 'committed',
      taskId: prepared.taskId,
    })
    expect(
      await resumed.sendRequest(Methods.DownloadHandoffCommit, commit)
    ).toEqual(receipt)
    expect(
      await resumed.sendRequest(Methods.DownloadHandoffStatus, key)
    ).toEqual(receipt)
    await expect
      .poll(async () =>
        (
          await readFile(
            path.join(userDataDir, 'downloads', 'desktop.bin')
          ).catch(() => null)
        )?.toString()
      )
      .toBe(file.toString())
    expect(requests).toEqual(['GET'])
    resumed.dispose()
    peer.wire.ws.close()
  } finally {
    await app?.close()
    server.closeAllConnections()
    server.close()
  }
})
