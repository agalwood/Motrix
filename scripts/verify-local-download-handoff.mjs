// Local candidate integration. Uses the real dispatcher, host DB and engine;
// the isolated IPC harness supplies the authenticated-session fixture.
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MdxpDispatcher } from '../src/core/bridge/mdxp-dispatcher.ts'
import { LibsodiumSecretStore } from '../src/core/plugin/secret-store-libsodium.ts'
import {
  DownloadHandoffJournal,
  HandoffJournalRefusal,
} from '../src/core/session/download-handoff-journal.ts'
import { MotrixDatabase } from '../src/core/session/motrix-database.ts'
import { TaskInstancePhase, TaskKind } from '../src/shared/types/task.ts'
import { connectAdapter, spawnAria2ForTest } from '../src/test-utils/aria2.ts'
import { makeInstanceRow, makeTaskRow } from '../src/test-utils/task-rows.ts'

const root = path.resolve(import.meta.dirname, '..')
const sdk = await import('@motrix/mdxp/node')
const methods = sdk.Methods
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const principal = 'local-fixture:installation'
async function peer(input) {
  const { dir, stage, operationId, url, port, secret } = input
  const db = new MotrixDatabase(path.join(dir, 'motrix.db'))
  db.init()
  const journal = new DownloadHandoffJournal(
    db,
    await LibsodiumSecretStore.create({ userDataDir: dir }),
    () => stage === 'prepare'
  )
  const ctx = {
    identity: { kind: 'extension' },
    sessionKey: principal,
    isReady: () => true,
    isAuthorized: () => true,
  }
  const dispatcher = new MdxpDispatcher()
  function register(name, run) {
    dispatcher.register(
      methods[`DownloadHandoff${name}`],
      sdk[`DownloadHandoff${name}ParamsSchema`],
      async (p, session) => {
        assert.equal(session.identity.kind, 'extension')
        assert.ok(
          session.isReady() && session.isAuthorized() && session.sessionKey
        )
        try {
          const state = await run({ ...p, principal: session.sessionKey }, p)
          return sdk[`DownloadHandoff${name}ResultSchema`].parse({
            instanceId: p.instanceId,
            operationId: p.operationId,
            ...state,
          })
        } catch (error) {
          if (!(error instanceof HandoffJournalRefusal)) throw error
          const code = {
            'instance-changed': sdk.ErrorCodes.HandoffInstanceChanged,
            'payload-conflict': sdk.ErrorCodes.HandoffPayloadConflict,
            'not-accepting': sdk.ErrorCodes.CapabilityNotSupported,
          }[error.reason]
          // fromStdio uses the same vscode-jsonrpc ResponseError class as its transport.
          throw new sdk.ResponseError(code, error.message)
        }
      }
    )
  }
  register('Prepare', (key, p) => {
    if (p.download.saveDir !== undefined) assert.equal(p.download.saveDir, dir)
    return journal.prepare(
      key,
      sdk.canonicalDownloadHandoffPayload(p.download),
      dir,
      120_000
    )
  })
  register('Status', (key) => journal.status(key))
  register('Abort', (key) => journal.abort(key))
  register('Commit', (key, p) =>
    journal.commit(key, p.payloadHash, (intent) => {
      const frozen = JSON.parse(intent.canonicalPayload)
      assert.equal(intent.saveDir, dir)
      assert.equal(frozen.selection.primary.url, url)
      const dest = path.join(dir, 'handoff.bin')
      return {
        task: {
          ...makeTaskRow(intent.taskId, TaskKind.Direct),
          source: 'bridge',
          saveDir: dir,
          name: 'handoff.bin',
          finalName: 'handoff.bin',
          finalPath: dest,
        },
        instances: [
          {
            ...makeInstanceRow(
              randomUUID(),
              intent.taskId,
              intent.engineId,
              TaskInstancePhase.HttpDownload
            ),
            uris: [url],
            diskPath: dest,
          },
        ],
      }
    })
  )
  // The inherited pipes carry real JSON-RPC. The IPC channel carries only
  // test barriers so killing a peer can lose its reply without losing evidence.
  const inputPipe = new Socket({ fd: 4, readable: true, writable: false })
  const outputPipe = new Socket({ fd: 5, readable: false, writable: true })
  const connection = sdk.fromStdio({ input: inputPipe, output: outputPipe })
  for (const name of ['Prepare', 'Commit', 'Status', 'Abort']) {
    const method = methods[`DownloadHandoff${name}`]
    connection.onRequest(method, async (params) => {
      const response = await dispatcher.dispatch(method, params, ctx)
      if (stage === 'commit' && name === 'Commit') {
        process.send({ checkpoint: 'commit-before-reply' })
        await new Promise(() => {})
      }
      return response
    })
  }
  connection.listen()
  process.send({ checkpoint: 'ready', instanceId: journal.instanceId })
  const [command] = await once(process, 'message')
  if (command !== 'activate') throw new Error('Unexpected local barrier')
  const status = journal.status({
    principal,
    instanceId: input.instanceId,
    operationId,
  })
  assert.equal(status.state, 'committed')
  assert.equal(status.taskId, input.taskId)
  assert.equal(db.getAllTasks().length, 1)
  const [instance] = db.getTask(status.taskId).instances
  const { adapter, disconnect } = await connectAdapter({ port, secret })
  try {
    const activated = await journal.activate(status.taskId, {
      contains: async (gid) => (await adapter.getTaskStatus(gid)) !== null,
      start: async (intent) => {
        assert.equal(stage, 'start')
        const frozen = sdk.DownloadHandoffPayloadSchema.parse(
          JSON.parse(intent.canonicalPayload)
        )
        const gid = await adapter.createDownload({
          uris: [frozen.selection.primary.url],
          headers: frozen.selection.primary.headers,
          filename: frozen.meta.suggestedFilename,
          saveDir: intent.saveDir,
          gid: intent.engineId,
          connections: 1,
        })
        assert.equal(gid, instance.gid)
        // The parent kills this peer after engine acceptance, before SQLite cleanup.
        process.send({ checkpoint: 'start', gid })
        await new Promise(() => {})
      },
    })
    assert.equal(activated, 'activated')
    assert.deepEqual(journal.pendingActivations(), [])
    assert.equal(
      await journal.activate(status.taskId, {
        contains: async () => false,
        start: () => assert.fail('second dispatch'),
      }),
      'absent'
    )
    return {
      state: status.state,
      taskId: status.taskId,
      gid: instance.gid,
      outbox: 0,
    }
  } finally {
    disconnect()
    connection.dispose()
    inputPipe.destroy()
    outputPipe.destroy()
    db.close()
  }
}

if (process.argv.includes('--peer')) {
  process.once('message', async (input) => {
    try {
      const data = await peer(input)
      process.send({ checkpoint: input.stage, ...data })
      // Deliberately leave prepared/committed DB connections open at the barrier.
      if (input.stage === 'recover') process.disconnect()
    } catch (error) {
      process.send({ error: String(error) })
      process.exitCode = 1
      process.disconnect()
    }
  })
} else {
  const output = path.join(root, 'output/ci/download-handoff')
  await mkdir(output, { recursive: true })
  const dir = await mkdtemp(path.join(output, 'run-'))
  const bytes = Buffer.alloc(256 * 1024, 0x35)
  const requests = []
  const server = createServer((req, res) => {
    if (req.url === '/start/click-live') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<a href="/download/click-live" data-dl-file="click-live" data-dl-bytes="${bytes.length}">Download</a>`
      )
      return
    }
    if (req.url !== '/download/click-live') {
      res.writeHead(404).end()
      return
    }
    requests.push({
      method: req.method,
      usesFrozenHeader: req.headers['x-motrix-test-context'] === 'fixture',
    })
    if (
      requests.length !== 1 ||
      req.method !== 'GET' ||
      !requests[0].usesFrozenHeader
    ) {
      res.writeHead(410).end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': bytes.length,
    })
    res.end(bytes)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/download/click-live`
  let engine
  const evidence = {
    status: 'running',
    hostRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    sdkVersion: JSON.parse(
      await readFile(
        new URL('../package.json', import.meta.resolve('@motrix/mdxp/node')),
        'utf8'
      )
    ).version,
    checkpoints: [],
  }
  try {
    engine = await spawnAria2ForTest({ baseDir: dir })
    const example = {
      source: { pageUrl: url, pageTitle: 'local integration', detectedAt: 42 },
      selection: {
        kind: 'direct',
        primary: { url, headers: { 'X-Motrix-Test-Context': 'fixture' } },
      },
      meta: { suggestedFilename: 'handoff.bin', qualityLabel: 'local' },
      saveDir: dir,
    }
    const runHandoff = async (download) => {
      const operationId = randomUUID()
      let instanceId, taskId, gid
      const hash = sha(sdk.canonicalDownloadHandoffPayload(download))
      for (const stage of ['prepare', 'commit', 'start', 'recover']) {
        const child = fork(fileURLToPath(import.meta.url), ['--peer'], {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe', 'pipe'],
        })
        const exited = once(child, 'exit')
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
        const client = sdk.fromStdio({
          input: child.stdio[5],
          output: child.stdio[4],
        })
        client.listen()
        const nextBarrier = async () => {
          const [message] = await Promise.race([
            once(child, 'message'),
            exited.then(() => {
              throw new Error(`peer exited before ${stage}`)
            }),
          ])
          if (message.error) throw new Error(message.error)
          return message
        }
        try {
          const ready = nextBarrier()
          child.send({
            stage,
            dir,
            url,
            instanceId,
            taskId,
            operationId,
            port: engine.port,
            secret: engine.secret,
          })
          const init = await ready
          assert.equal(init.checkpoint, 'ready')
          if (instanceId) assert.equal(init.instanceId, instanceId)
          instanceId = init.instanceId
          const key = { instanceId, operationId }
          const call = async (name, params) =>
            sdk[`DownloadHandoff${name}ResultSchema`].parse(
              await client.sendRequest(
                methods[`DownloadHandoff${name}`],
                params
              )
            )
          if (stage === 'prepare') {
            const prepared = await call('Prepare', { ...key, download })
            assert.equal(prepared.state, 'prepared')
            assert.equal(prepared.payloadHash, hash)
            taskId = prepared.taskId
            assert.deepEqual(
              await call('Prepare', { ...key, download }),
              prepared
            )
            await assert.rejects(
              call('Prepare', {
                ...key,
                download: {
                  ...download,
                  meta: {
                    ...download.meta,
                    suggestedFilename: 'different.bin',
                  },
                },
              }),
              { code: sdk.ErrorCodes.HandoffPayloadConflict }
            )
            await assert.rejects(
              call('Status', { ...key, instanceId: randomUUID() }),
              { code: sdk.ErrorCodes.HandoffInstanceChanged }
            )
            assert.equal(requests.length, 0)
            evidence.checkpoints.push({
              stage,
              taskId,
              sourceRequests: requests.length,
            })
          } else if (stage === 'commit') {
            const prior = await call('Status', key)
            assert.equal(prior.state, 'prepared')
            assert.equal(prior.taskId, taskId)
            const barrier = nextBarrier()
            const lost = client
              .sendRequest(methods.DownloadHandoffCommit, {
                ...key,
                payloadHash: hash,
              })
              .then(
                () => false,
                () => true
              )
            assert.equal((await barrier).checkpoint, 'commit-before-reply')
            assert.equal(requests.length, 0)
            child.kill('SIGKILL')
            await exited
            client.dispose()
            assert.equal(await lost, true)
            evidence.checkpoints.push({
              stage,
              replyLost: true,
              sourceRequests: requests.length,
            })
          } else {
            const committed = await call('Status', key)
            assert.equal(committed.state, 'committed')
            assert.equal(committed.taskId, taskId)
            assert.deepEqual(
              await call('Commit', { ...key, payloadHash: hash }),
              committed
            )
            assert.deepEqual(await call('Abort', key), committed)
            const barrier = nextBarrier()
            child.send('activate')
            const data = await barrier
            assert.equal(data.checkpoint, stage)
            if (stage === 'start') gid = data.gid
            else {
              assert.equal(data.gid, gid)
              assert.equal(data.outbox, 0)
            }
            evidence.checkpoints.push(data)
          }
        } finally {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL')
          await exited
          client.dispose()
          clearTimeout(timer)
        }
      }
      return { taskId }
    }
    if (process.env.MOTRIX_EXTENSION_DIR) {
      const { confirmLocalHandoff } = await import(
        './local-handoff-browser.mjs'
      )
      evidence.browser = await confirmLocalHandoff({
        root,
        extensionRoot: path.resolve(process.env.MOTRIX_EXTENSION_DIR),
        origin: new URL(url).origin,
        submit: runHandoff,
        requestCount: () => requests.length,
      })
    } else await runHandoff(example)
    const end = Date.now() + 5000
    do {
      const content = await readFile(path.join(dir, 'handoff.bin')).catch(() =>
        Buffer.alloc(0)
      )
      if (sha(content) === sha(bytes)) {
        evidence.sha256 = sha(content)
        break
      }
      await new Promise((r) => setTimeout(r, 50))
    } while (Date.now() < end)
    assert.deepEqual(requests, [{ method: 'GET', usesFrozenHeader: true }])
    assert.equal(evidence.sha256, sha(bytes))
    evidence.requests = requests
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'
    throw error
  } finally {
    await engine?.kill()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    const report = path.join(dir, 'report.json')
    await writeFile(report, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(evidence.status, report)
  }
}
