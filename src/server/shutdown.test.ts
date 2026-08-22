import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createServerExitCoordinator,
  createServerShutdown,
  runServerStartup,
  type ServerShutdownActions,
} from './shutdown'

function actions(
  order: string[],
  overrides: Partial<ServerShutdownActions> = {}
): ServerShutdownActions {
  const step = (name: string) => async () => {
    order.push(name)
  }
  return {
    gateShellWork: step('gate-shell'),
    stopPolling: step('stop-polling'),
    closeIngress: step('close-ingress'),
    closeBridge: step('close-bridge'),
    unsubscribeProducers: step('unsubscribe-producers'),
    drainMagnet: step('drain-magnet'),
    drainSession: step('drain-session'),
    disposeActivity: step('dispose-activity'),
    disposeTransferStats: step('dispose-transfer-stats'),
    disposeTracker: step('dispose-tracker'),
    drainDevWatcher: step('drain-dev-watcher'),
    drainPluginHost: step('drain-plugin-host'),
    stopSpeedLimit: step('stop-speed-limit'),
    stopEngine: step('stop-engine'),
    closeDatabase: step('close-database'),
    ...overrides,
  }
}

describe('createServerShutdown', () => {
  it('closes ingress and drains every producer before closing SQLite', async () => {
    const order: string[] = []
    const shutdown = createServerShutdown(actions(order), vi.fn())

    const first = shutdown()
    expect(shutdown()).toBe(first)
    await first

    expect(order).toEqual([
      'gate-shell',
      'stop-polling',
      'close-ingress',
      'close-bridge',
      'unsubscribe-producers',
      'drain-dev-watcher',
      'drain-plugin-host',
      'drain-magnet',
      'stop-speed-limit',
      'dispose-tracker',
      'drain-session',
      'stop-engine',
      'dispose-activity',
      'dispose-transfer-stats',
      'close-database',
    ])
  })

  it('keeps Session persistence and engine RPC alive until tracker compensation drains', async () => {
    let markTrackerStarted!: () => void
    let releaseTracker!: () => void
    const trackerStarted = new Promise<void>((resolve) => {
      markTrackerStarted = resolve
    })
    const trackerGate = new Promise<void>((resolve) => {
      releaseTracker = resolve
    })
    const order: string[] = []
    const shutdown = createServerShutdown(
      actions(order, {
        disposeTracker: async () => {
          order.push('tracker-start')
          markTrackerStarted()
          await trackerGate
          order.push('tracker-resumed')
        },
        drainSession: async () => {
          order.push('drain-session')
        },
        stopEngine: async () => {
          order.push('stop-engine')
        },
      }),
      vi.fn()
    )

    const pending = shutdown()
    await trackerStarted

    expect(order).not.toContain('drain-session')
    expect(order).not.toContain('stop-engine')

    releaseTracker()
    await pending

    expect(order.indexOf('tracker-resumed')).toBeLessThan(
      order.indexOf('drain-session')
    )
    expect(order.indexOf('tracker-resumed')).toBeLessThan(
      order.indexOf('stop-engine')
    )
  })

  it('runs cancellation teardown before awaiting a blocked startup drain', async () => {
    let releaseDrain!: () => void
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    let cancellationStarted = false
    const order: string[] = []
    const shutdown = createServerShutdown(
      actions(order, {
        gateShellWork: () => {
          order.push('gate-shell')
          return drain
        },
        stopEngine: async () => {
          cancellationStarted = true
          order.push('stop-engine')
          releaseDrain()
        },
      }),
      vi.fn()
    )

    const pending = shutdown()
    await Promise.resolve()
    if (!cancellationStarted) releaseDrain()
    await pending

    expect(cancellationStarted).toBe(true)
    expect(order.indexOf('stop-engine')).toBeLessThan(
      order.indexOf('dispose-activity')
    )
  })

  it('continues through the database close when an earlier step fails', async () => {
    const order: string[] = []
    const error = new Error('ingress close failed')
    const onError = vi.fn()
    const shutdown = createServerShutdown(
      actions(order, {
        closeIngress: async () => {
          order.push('close-ingress')
          throw error
        },
      }),
      onError
    )

    await expect(shutdown()).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledWith(error, 'http-ingress')
    expect(order.at(-1)).toBe('close-database')
  })
})

describe('server startup/exit coordination', () => {
  it('cleans resources whose ownership was registered during early acquisition', async () => {
    const failure = new Error('capability host acquisition failed')
    const order: string[] = []
    const mutableActions = actions(order, {
      drainPluginHost: () => {},
      closeDatabase: () => {},
    })
    const shutdown = createServerShutdown(mutableActions, vi.fn())

    mutableActions.drainPluginHost = async () => {
      order.push('drain-acquired-plugin-host')
    }
    mutableActions.closeDatabase = async () => {
      order.push('close-acquired-database')
    }

    await expect(
      runServerStartup(async () => {
        order.push('database-acquired', 'plugin-host-acquired')
        throw failure
      }, shutdown)
    ).rejects.toBe(failure)

    expect(order).toContain('drain-acquired-plugin-host')
    expect(order.at(-1)).toBe('close-acquired-database')
  })

  it('drains every partial resource when listen fails after producers began', async () => {
    const failure = new Error('listen EADDRINUSE')
    const order: string[] = []
    const shutdown = createServerShutdown(actions(order), vi.fn())

    await expect(
      runServerStartup(
        async () => {
          order.push('plugin-started', 'watcher-started', 'polling-started')
          throw failure
        },
        shutdown,
        () => {
          order.push('fatal-startup')
        }
      )
    ).rejects.toBe(failure)

    expect(order).toEqual([
      'plugin-started',
      'watcher-started',
      'polling-started',
      'fatal-startup',
      'gate-shell',
      'stop-polling',
      'close-ingress',
      'close-bridge',
      'unsubscribe-producers',
      'drain-dev-watcher',
      'drain-plugin-host',
      'drain-magnet',
      'stop-speed-limit',
      'dispose-tracker',
      'drain-session',
      'stop-engine',
      'dispose-activity',
      'dispose-transfer-stats',
      'close-database',
    ])

    await shutdown()
    expect(order.filter((step) => step === 'close-database')).toHaveLength(1)
  })

  it('coalesces signal/fatal/normal exit races and preserves the fatal code', async () => {
    let releaseShutdown!: () => void
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })
    const shutdown = vi.fn(() => shutdownGate)
    const exit = vi.fn()
    const requestExit = createServerExitCoordinator(shutdown, exit)

    const signal = requestExit(0)
    const normal = requestExit(0)
    const fatal = requestExit(1)

    expect(normal).toBe(signal)
    expect(fatal).toBe(signal)
    await Promise.resolve()
    expect(shutdown).toHaveBeenCalledOnce()
    releaseShutdown()
    await signal

    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('server lifecycle production wiring', () => {
  it('opens HTTP query/command ingress only after recovered anchors complete', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/server/index.ts'),
      'utf8'
    )

    expect(source.indexOf('recordRecoveredAnchors(')).toBeGreaterThan(-1)
    expect(source.indexOf('await app.listen(')).toBeGreaterThan(
      source.indexOf('recordRecoveredAnchors(')
    )
  })

  it('captures durable Activity gap origins before recovery and observes state after recovery', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/server/index.ts'),
      'utf8'
    )
    const captureOrigins = source.indexOf('captureRecoveredAnchorOrigins(')
    const recovery = source.indexOf('recoveryService.recoverOnStartup()')
    const observedAnchors = source.indexOf('recordRecoveredAnchors(')

    expect(captureOrigins).toBeGreaterThan(-1)
    expect(recovery).toBeGreaterThan(captureOrigins)
    expect(observedAnchors).toBeGreaterThan(recovery)
  })

  it('anchors an authoritative reconnect poll before recording its samples', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/server/index.ts'),
      'utf8'
    )
    const handler = source.indexOf('async function handlePolledTasks(')
    const reconnectAnchor = source.indexOf(
      'recordAuthoritativeReconnectAnchors(',
      handler
    )
    const samples = source.indexOf('recordSamples(tasks)', reconnectAnchor)

    expect(handler).toBeGreaterThan(-1)
    expect(reconnectAnchor).toBeGreaterThan(handler)
    expect(samples).toBeGreaterThan(reconnectAnchor)
  })

  it('rejects retired engine ownership before orphan adoption', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/server/index.ts'),
      'utf8'
    )
    const handler = source.indexOf('async function handlePolledTasks(')
    const retiredGate = source.indexOf(
      'taskManager.isEngineTaskIdRetired(raw.gid)',
      handler
    )
    const orphanId = source.indexOf('const id = newTaskId()', handler)

    expect(handler).toBeGreaterThan(-1)
    expect(retiredGate).toBeGreaterThan(handler)
    expect(orphanId).toBeGreaterThan(retiredGate)
  })

  it('persists an engine-discovered parent before Activity samples and publication', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/server/index.ts'),
      'utf8'
    )
    const handler = source.indexOf('async function handlePolledTasks(')
    const discoveredTask = source.indexOf(
      'const discoveredTask: DownloadTask =',
      handler
    )
    const parentBarrier = source.indexOf(
      'taskInspectorActivityRuntime.parentTaskCreated(',
      discoveredTask
    )
    const persistParent = source.indexOf(
      'persistTask(discoveredTask)',
      parentBarrier
    )
    const publish = source.indexOf(
      'taskManager.set(id, discoveredTask)',
      persistParent
    )
    const samples = source.indexOf('recordSamples(tasks)', publish)

    expect(discoveredTask).toBeGreaterThan(handler)
    expect(parentBarrier).toBeGreaterThan(discoveredTask)
    expect(persistParent).toBeGreaterThan(parentBarrier)
    expect(publish).toBeGreaterThan(persistParent)
    expect(samples).toBeGreaterThan(publish)
  })

  it('constructs shutdown before early acquisitions, producers, or HTTP ingress', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/server/index.ts'),
      'utf8'
    )
    const shutdown = source.indexOf('const shutdown = createServerShutdown(')
    const signalOwner = source.indexOf('requestActiveServerExit = requestExit')
    const database = source.indexOf('db.init()')
    const app = source.indexOf('const app = await createApp(')
    const producers = source.indexOf("runShellAsyncWork('tracker manager init'")
    const listen = source.indexOf('await app.listen(')

    expect(shutdown).toBeGreaterThan(-1)
    expect(signalOwner).toBeGreaterThan(shutdown)
    expect(database).toBeGreaterThan(signalOwner)
    expect(app).toBeGreaterThan(database)
    expect(producers).toBeGreaterThan(shutdown)
    expect(listen).toBeGreaterThan(producers)
  })

  it('wires TrackerManager stopAndDrain into production shutdown', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/server/index.ts'),
      'utf8'
    )

    expect(source).toContain(
      'shutdownActions.disposeTracker = () => trackerManager.stopAndDrain()'
    )
  })
})
