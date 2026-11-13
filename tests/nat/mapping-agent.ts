import { writeFileSync } from 'node:fs'
import type { NatManager } from '@motrix/nat'
import { TaijiNatBridge } from '../../src/core/engine/taiji/taiji-nat-bridge'
import { EventBus } from '../../src/core/events/event-bus'
import { createNatManager } from '../../src/core/nat/nat-manager-factory'
import { SettingsNatProvider } from '../../src/core/nat/settings-nat-provider'
import type { SettingsManager } from '../../src/core/settings/settings-manager'
import { DEFAULT_NAT_SETTINGS } from '../../src/shared/schemas/nat-settings'

const dest = process.argv[2]
const eventBus = new EventBus()
const settingsManager = {
  get: () => ({
    nat: { ...DEFAULT_NAT_SETTINGS, preferredProtocol: 'natpmp' },
  }),
  getEngine: () => ({ listenPort: 40000, dhtListenPort: 40000 }),
} as unknown as SettingsManager
const managers: NatManager[] = []
async function call<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch('http://127.0.0.1:16880/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: `taiji.${method}`,
      params: ['token:nat-lab', ...params],
    }),
  })
  const body = (await response.json()) as { result: T; error?: unknown }
  if (body.error) throw new Error(JSON.stringify(body.error))
  return body.result
}
const updates: unknown[] = []
const bridge = new TaijiNatBridge({
  eventBus,
  settingsManager,
  isEngineReady: () => true,
  rpc: {
    getGlobalOption: () => call<Record<string, string>>('getGlobalOption'),
    changeGlobalOption: async (options) => {
      updates.push(JSON.parse(options['motrix-peer-mappings']))
      writeFileSync(
        `${dest}/mapping-updates.json`,
        JSON.stringify(updates, null, 2)
      )
      return call<'OK'>('changeGlobalOption', [options])
    },
  },
  createManager: (port) => {
    const provider = new SettingsNatProvider(settingsManager)
    const stack = createNatManager({
      eventBus,
      settingsManager,
      isEngineReady: () => true,
      publishEvents: false,
      settingsProvider: {
        getEngine: () => ({ listenPort: port, dhtListenPort: port }),
        getNat: () => provider.getNat(),
      },
    })
    managers.push(stack.manager)
    return stack.manager
  },
})
bridge.start()
const timer = setInterval(
  () =>
    writeFileSync(
      `${dest}/mapping-status.json`,
      JSON.stringify(
        managers.map((m) => m.getStatus()),
        null,
        2
      )
    ),
  250
)
let renewing = false
process.on('SIGUSR1', () => {
  if (renewing) return
  renewing = true
  void Promise.all(managers.map((m) => m.forceRemap()))
    .then(() => {
      writeFileSync(
        `${dest}/renewed.json`,
        JSON.stringify(
          managers.map((m) => m.getStatus()),
          null,
          2
        )
      )
    })
    .finally(() => {
      renewing = false
    })
})
process.once('SIGTERM', () => {
  clearInterval(timer)
  void bridge.stop().then(() => {
    writeFileSync(
      `${dest}/mapping-stopped.json`,
      JSON.stringify(
        managers.map((m) => m.getStatus()),
        null,
        2
      )
    )
    process.exit(0)
  })
})
