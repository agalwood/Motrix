import type { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import { createNatManager } from '@core/nat/nat-manager-factory'
import { SettingsNatProvider } from '@core/nat/settings-nat-provider'
import type { SettingsManager } from '@core/settings/settings-manager'
import type { NatManager } from '@motrix/nat'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { z } from 'zod'
import type { TaijiRpcClient } from './taiji-rpc-client'

const listenersSchema = z
  .array(
    z.object({
      id: z.string().regex(/^[a-f0-9]{16}-[a-f0-9]{16}$/),
      gid: z.string().regex(/^[a-f0-9]{16}$/),
      port: z.number().int().min(1).max(65535),
      hostManaged: z.boolean(),
    })
  )
  .max(256)

type MappingManager = Pick<NatManager, 'start' | 'stop' | 'getStatus'>
interface OwnedMapping {
  manager: MappingManager
  started: Promise<void>
  lastSeen: number
}

/** Maps the sockets taiji actually bound, including concurrent magnet tasks. */
export class TaijiNatBridge {
  private readonly owned = new Map<number, OwnedMapping>()
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<void> | undefined
  private stopped = true
  private generation = 0
  private reset = false
  private lastSent = ''
  private readonly log = getLogger('taiji-nat')

  constructor(
    private readonly deps: {
      rpc: Pick<TaijiRpcClient, 'getGlobalOption' | 'changeGlobalOption'>
      eventBus: EventBus
      settingsManager: SettingsManager
      isEngineReady: () => boolean
      primary?: NatManager
      createManager?: (port: number) => MappingManager
    }
  ) {}

  private readonly stateChanged = (state: unknown) => {
    if (state !== EngineState.Ready) {
      this.generation++
      this.reset = true
      this.lastSent = ''
    }
    void this.refresh()
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.deps.eventBus.on(Events.EngineStateChanged, this.stateChanged)
    this.deps.eventBus.on(Events.SettingsChanged, this.settingsChanged)
    this.timer = setInterval(() => void this.refresh(), 500)
    this.timer.unref()
    void this.refresh()
  }

  private readonly settingsChanged = () => {
    void this.refresh()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.generation++
    clearInterval(this.timer)
    this.deps.eventBus.off(Events.EngineStateChanged, this.stateChanged)
    this.deps.eventBus.off(Events.SettingsChanged, this.settingsChanged)
    await this.inFlight
    await this.clearOwned()
    this.lastSent = ''
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    this.inFlight = this.reconcile()
      .catch((error) => {
        if (!this.stopped && this.deps.isEngineReady())
          this.log.debug({ error }, 'peer port mapping synchronization failed')
      })
      .finally(() => {
        this.inFlight = undefined
      })
    return this.inFlight
  }

  private async clearOwned(): Promise<void> {
    const entries = [...this.owned.values()]
    this.owned.clear()
    await Promise.all(
      entries.map(async (entry) => {
        await entry.started
        await entry.manager.stop()
      })
    )
  }

  private makeManager(port: number): MappingManager {
    if (this.deps.createManager) return this.deps.createManager(port)
    const provider = new SettingsNatProvider(this.deps.settingsManager)
    return createNatManager({
      ...this.deps,
      publishEvents: false,
      settingsProvider: {
        getEngine: () => ({ listenPort: port, dhtListenPort: port }),
        getNat: () => provider.getNat(),
      },
    }).manager
  }

  private async reconcile(): Promise<void> {
    const generation = this.generation
    if (this.reset) {
      this.reset = false
      await this.clearOwned()
    }
    if (this.stopped || generation !== this.generation) return
    if (!this.deps.isEngineReady()) return
    const options = await this.deps.rpc.getGlobalOption()
    if (this.stopped || generation !== this.generation) return
    const listeners = listenersSchema
      .parse(JSON.parse(options['motrix-peer-listeners'] ?? '[]'))
      .filter((listener) => listener.hostManaged)
    const enabled = this.deps.settingsManager.get().nat.enabled
    const primaryPort = this.deps.settingsManager.getEngine().listenPort
    const now = Date.now()
    const seen = new Set(
      enabled ? listeners.map((listener) => listener.port) : []
    )
    for (const [port, entry] of this.owned) {
      if (seen.has(port)) entry.lastSeen = now
      // Preserve a lease briefly while metadata hands its socket to payload.
      if (
        !enabled ||
        (this.deps.primary && port === primaryPort) ||
        now - entry.lastSeen > 2000
      ) {
        this.owned.delete(port)
        await entry.started
        await entry.manager.stop()
      }
    }
    if (this.stopped || generation !== this.generation) return
    const mappings = listeners
      .map(({ id, port }) => {
        let manager: MappingManager | undefined
        if (enabled) {
          if (this.deps.primary && port === primaryPort)
            manager = this.deps.primary
          else {
            let entry = this.owned.get(port)
            if (!entry) {
              manager = this.makeManager(port)
              entry = {
                manager,
                lastSeen: now,
                started: manager.start().catch((error) => {
                  this.log.debug(
                    { error, port },
                    'peer port mapping start failed'
                  )
                }),
              }
              this.owned.set(port, entry)
            }
            manager = entry.manager
          }
        }
        const active =
          manager
            ?.getStatus()
            .activeMappings.filter(
              (mapping) =>
                mapping.internalPort === port &&
                (mapping.ttl === 0 || mapping.expiresAt > now)
            ) ?? []
        return {
          id,
          port,
          tcp:
            active.find((mapping) => mapping.protocol === 'TCP')
              ?.externalPort ?? null,
          udp:
            active.find((mapping) => mapping.protocol === 'UDP')
              ?.externalPort ?? null,
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
    const serialized = JSON.stringify(mappings)
    if (serialized !== this.lastSent) {
      await this.deps.rpc.changeGlobalOption({
        'motrix-peer-mappings': serialized,
      })
      if (!this.stopped && generation === this.generation)
        this.lastSent = serialized
    }
  }
}
