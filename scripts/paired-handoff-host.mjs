// Local acceptance composition root: a real loopback MBP1 host, prompt, journal
// and engine. The inherited IPC channel is the isolated operator's display.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import { ErrorCodes, makeMdxpError } from '@motrix/mdxp/node'
import metadata from '../package.json' with { type: 'json' }
import { Mbp1CredentialStore } from '../src/core/bridge/credential-store.ts'
import { FilePairingStore } from '../src/core/bridge/file-pairing-store.ts'
import { PairingPromptController } from '../src/core/bridge/pairing-prompt-controller.ts'
import { PairingService } from '../src/core/bridge/pairing-service.ts'
import { FileRegistryStoreAdapter } from '../src/core/bridge/registry-store-adapter.ts'
import { TrustedExtensionRegistry } from '../src/core/bridge/trusted-extension-registry.ts'
import { WebSocketBridgeServer } from '../src/core/bridge/web-socket-bridge-server.ts'
import { LibsodiumSecretStore } from '../src/core/plugin/secret-store-libsodium.ts'
import { AppliedDownloadProxyPolicy } from '../src/core/proxy/applied-download-proxy-policy.ts'
import { DownloadHandoffJournal } from '../src/core/session/download-handoff-journal.ts'
import { MotrixDatabase } from '../src/core/session/motrix-database.ts'
import { SessionManager } from '../src/core/session/session-manager.ts'
import { FinalNamePickerImpl } from '../src/core/task/final-name-picker.ts'
import { TaskManager } from '../src/core/task/task-manager.ts'
import { desktopDownloadHandoff } from '../src/main/bridge/desktop-download-handoff.ts'
import { DEFAULT_APP_SETTINGS } from '../src/shared/schemas/app-settings.ts'
import { DEFAULT_ENGINE_SETTINGS } from '../src/shared/schemas/engine-settings.ts'
import { connectAdapter, spawnAria2ForTest } from '../src/test-utils/aria2.ts'

const root = path.resolve(import.meta.dirname, '../output/ci/paired-handoff')
await mkdir(root, { recursive: true })
const dir = await mkdtemp(path.join(root, 'run-'))
const origin = process.env.MOTRIX_FIXTURE_ORIGIN
assert.equal(new URL(origin).hostname, '127.0.0.1')
const pairing = new PairingService(
  new FilePairingStore(path.join(dir, 'pairing.json'))
)
const registry = new TrustedExtensionRegistry(
  new FileRegistryStoreAdapter(path.join(dir, 'registry.json')),
  []
)
await pairing.load()
await registry.load()
let pairPrompts = 0
const prompts = new PairingPromptController({
  onEnqueued: (prompt) => {
    pairPrompts++
    process.send({ event: 'pairing-prompt', code: prompt.code })
    return 'delivered'
  },
})
const db = new MotrixDatabase(path.join(dir, 'motrix.db'))
db.init()
const journal = new DownloadHandoffJournal(
  db,
  await LibsodiumSecretStore.create({ userDataDir: dir }),
  () => true
)
const engine = await spawnAria2ForTest({ baseDir: dir })
const { adapter, rpc, disconnect } = await connectAdapter(engine)
const history = []
const operationKeys = new Map()
let authenticated = 0
const taskManager = new TaskManager()
const session = new SessionManager(taskManager, rpc, db, adapter)
const proxy = new AppliedDownloadProxyPolicy()
proxy.commit(null)
const module = desktopDownloadHandoff(journal, db, session, {
  adapter,
  taskManager,
  settingsManager: {
    getApp: () => ({ ...DEFAULT_APP_SETTINGS, defaultSaveDir: dir }),
    getEngine: () => DEFAULT_ENGINE_SETTINGS,
  },
  finalNamePicker: new FinalNamePickerImpl({
    exists: async (file) => existsSync(file),
  }),
  directResourceProxyPolicy: proxy,
  activityRecorder: { recordSubmitted() {} },
  publishTaskUpdate() {},
})
let dropId
for (const [method, binding] of Object.entries(module.methods)) {
  const handle = binding.handle
  binding.handle = async (params, ctx) => {
    operationKeys.set(params.operationId, {
      instanceId: params.instanceId,
      operationId: params.operationId,
      principal: ctx.sessionKey,
    })
    history.push({
      method: method
        .split('.')
        .at(-1)
        .replace(/^./, (c) => c.toUpperCase()),
      id: params.operationId,
    })
    if (params.download) {
      const url = new URL(params.download.selection.primary.url)
      assert.equal(url.origin, origin)
      assert.match(url.pathname, /^\/download\/paired-(accept|rejected|lost)$/)
      if (url.pathname.endsWith('rejected'))
        throw makeMdxpError(
          ErrorCodes.InvalidParams,
          'Fixture directory unavailable'
        )
      if (url.pathname.endsWith('lost')) dropId = params.operationId
    }
    const reply = await handle(params, ctx)
    if (method.endsWith('.commit') && dropId === params.operationId) {
      dropId = undefined
      server.getSession(ctx.sessionKey).envelope.close()
    }
    return reply
  }
}
const server = new WebSocketBridgeServer({
  pairing,
  registry,
  motrixVersion: metadata.version,
  appVersion: metadata.version,
  runtime: 'electron',
  ffmpegAvailable: false,
  localToken: randomBytes(32).toString('hex'),
  instanceId: randomUUID(),
  serverGeneration: randomUUID(),
  credentials: await Mbp1CredentialStore.load(
    path.join(dir, 'credentials.json')
  ),
  isOfficialId: () => false,
  queueMbp1Dialog: (req) => prompts.enqueue(req),
  onExtensionAuthenticated: () => {
    authenticated++
  },
  extensionHandoff: module,
})
const port = await server.start('127.0.0.1', 0)
process.send({ event: 'ready', port, instanceId: journal.instanceId })
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await server.stop()
  await pairing.stopAndDrain()
  disconnect()
  await engine.kill()
  db.close()
  process.exit(0)
}
process.on('disconnect', shutdown)
process.on('message', async (m) => {
  if (m === 'close') return shutdown()
  if (m?.action !== 'snapshot') return
  try {
    const name = m.name
    assert.match(name, /^paired-(accept|lost|rejected|cancel|browser)$/)
    const tasks = db
      .getAllTasks()
      .filter((t) =>
        t.instances[0]?.uris.some(
          (uri) => new URL(uri).pathname === '/download/' + name
        )
      )
    let sha256 = null
    if (tasks.length) {
      const end = Date.now() + 8000
      while (Date.now() < end) {
        const status = await adapter.getTaskStatus(tasks[0].instances[0].gid)
        if (status?.status === 'completed') {
          sha256 = createHash('sha256')
            .update(await readFile(tasks[0].instances[0].diskPath))
            .digest('hex')
          break
        }
        await new Promise((r) => setTimeout(r, 40))
      }
    }
    process.send({
      event: 'snapshot',
      name,
      authenticated,
      pairPrompts,
      states: [...new Set(history.map((h) => h.id))].map(
        (id) => journal.status(operationKeys.get(id)).state
      ),
      history: history.splice(0),
      tasks: tasks.map((t) => t.task.motrixId),
      outbox: journal.pendingActivations(),
      sha256,
    })
  } catch (error) {
    process.send({ event: 'failure', message: error.message })
  }
})
