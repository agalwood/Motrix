import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MainProcessWorkCoordinator } from './main-process-work-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, reject, resolve }
}

describe('MainProcessWorkCoordinator', () => {
  it('drains startup restore and a waiting query before Activity and SQLite close', async () => {
    const coordinator = new MainProcessWorkCoordinator()
    const restore = deferred<void>()
    const order: string[] = []

    const startup = coordinator.startStartup(async () => {
      order.push('restore-started')
      await restore.promise
      order.push('anchors-recorded')
    })
    const query = coordinator.run(async () => {
      await coordinator.waitForStartup()
      order.push('query-snapshot')
    })

    const shutdown = (async () => {
      await coordinator.stopAndDrain()
      order.push('activity-disposed')
      order.push('database-closed')
    })()

    await vi.waitFor(() => {
      expect(order).toEqual(['restore-started'])
    })

    restore.resolve()
    await Promise.all([startup, query, shutdown])

    expect(order).toEqual([
      'restore-started',
      'anchors-recorded',
      'query-snapshot',
      'activity-disposed',
      'database-closed',
    ])
  })

  it('settles the startup barrier on failure and rejects work after shutdown', async () => {
    const coordinator = new MainProcessWorkCoordinator()
    const startupError = new Error('restore failed')

    await expect(
      coordinator.startStartup(async () => {
        throw startupError
      })
    ).rejects.toBe(startupError)
    await expect(coordinator.waitForStartup()).resolves.toBeUndefined()
    await coordinator.stopAndDrain()

    await expect(coordinator.run(async () => undefined)).rejects.toThrow(
      'stopped'
    )
  })

  it('aborts a Phase 2 resource install when shutdown wins an await', async () => {
    const coordinator = new MainProcessWorkCoordinator()
    const phaseTwo = deferred<void>()
    const order: string[] = []

    const bootstrap = coordinator.run(async () => {
      order.push('phase-two-started')
      await phaseTwo.promise
      if (!coordinator.isAccepting()) {
        order.push('phase-two-aborted')
        return
      }
      order.push('database-opened')
    })
    const shutdown = (async () => {
      await coordinator.stopAndDrain()
      order.push('activity-disposed')
      order.push('database-closed')
    })()

    await vi.waitFor(() => {
      expect(order).toEqual(['phase-two-started'])
    })
    phaseTwo.resolve()
    await Promise.all([bootstrap, shutdown])

    expect(order).toEqual([
      'phase-two-started',
      'phase-two-aborted',
      'activity-disposed',
      'database-closed',
    ])
  })

  it('lets cancellation teardown release blocked startup before awaiting drain', async () => {
    const coordinator = new MainProcessWorkCoordinator()
    const blocked = deferred<void>()
    const order: string[] = []

    const startup = coordinator.startStartup(async () => {
      order.push('startup-blocked')
      await blocked.promise
      order.push('startup-released')
    })
    const cleanup = (async () => {
      const drain = coordinator.stopAndDrain()
      order.push('work-gated')
      order.push('engine-stop')
      blocked.resolve()
      await drain
      order.push('activity-disposed', 'database-closed')
    })()

    await Promise.all([startup, cleanup])

    expect(order).toEqual([
      'work-gated',
      'engine-stop',
      'startup-blocked',
      'startup-released',
      'activity-disposed',
      'database-closed',
    ])
  })

  it('tracks the production ready bootstrap before any database-backed phase', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8'
    )
    const bootstrapDeclaration = source.indexOf(
      'async function initializeMainProcess()'
    )
    const databaseOpen = source.indexOf('motrixDb.init()')
    const trackedBootstrap = source.indexOf(
      'mainProcessWork.run(initializeMainProcess)'
    )
    const ingressClose = source.indexOf(
      "const ingressClose = safely('ipc-ingress'"
    )
    const shutdownGate = source.indexOf(
      'mainProcessWork.stopAndDrain()',
      ingressClose
    )
    const awaitIngressClose = source.indexOf('await ingressClose', shutdownGate)

    expect(bootstrapDeclaration).toBeGreaterThan(-1)
    expect(databaseOpen).toBeGreaterThan(bootstrapDeclaration)
    expect(trackedBootstrap).toBeGreaterThan(databaseOpen)
    expect(ingressClose).toBeGreaterThan(-1)
    expect(shutdownGate).toBeGreaterThan(ingressClose)
    expect(awaitIngressClose).toBeGreaterThan(shutdownGate)
  })

  it('destroys renderers before removing IPC handlers during shutdown', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8'
    )
    const performCleanup = source.indexOf('function performCleanup()')
    const removeHandlers = source.indexOf(
      "const ingressClose = safely('ipc-ingress'",
      performCleanup
    )
    const beginShutdown = source.indexOf('function beginShutdown()')
    const prepareEngine = source.indexOf(
      'supervisor?.prepareForShutdown()',
      beginShutdown
    )
    const destroyRenderers = source.indexOf(
      'windowManager?.destroyAll()',
      beginShutdown
    )
    const callCleanup = source.indexOf(
      'void performCleanup()',
      destroyRenderers
    )

    expect(performCleanup).toBeGreaterThan(-1)
    expect(removeHandlers).toBeGreaterThan(performCleanup)
    expect(beginShutdown).toBeGreaterThan(-1)
    expect(prepareEngine).toBeGreaterThan(beginShutdown)
    expect(prepareEngine).toBeLessThan(destroyRenderers)
    expect(destroyRenderers).toBeGreaterThan(beginShutdown)
    expect(callCleanup).toBeGreaterThan(destroyRenderers)
  })

  it('captures durable Activity gap origins before recovery and observes state after recovery', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8'
    )
    const captureOrigins = source.indexOf('captureRecoveredAnchorOrigins(')
    const recovery = source.indexOf('recoveryService.recoverOnStartup()')
    const observedAnchors = source.indexOf('recordRecoveredAnchors(')

    expect(captureOrigins).toBeGreaterThan(-1)
    expect(recovery).toBeGreaterThan(captureOrigins)
    expect(observedAnchors).toBeGreaterThan(recovery)
  })

  it('publishes restored tasks after startup recovery', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8'
    )
    const restore = source.indexOf('await sessionManager.restore(')
    const recovery = source.indexOf('recoveryService.recoverOnStartup()')
    // The post-recovery snapshot bypasses the coalescing window: the
    // renderer's first paint must not wait 16 ms behind a startup barrier.
    const publish = source.indexOf('publishTaskUpdateNow()', recovery)

    expect(restore).toBeGreaterThan(-1)
    expect(recovery).toBeGreaterThan(restore)
    expect(publish).toBeGreaterThan(recovery)
  })

  it('anchors an authoritative reconnect poll before recording its samples', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
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
      path.resolve(process.cwd(), 'src/main/index.ts'),
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
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8'
    )
    const handler = source.indexOf('async function handlePolledTasks(')
    const discoveredTask = source.indexOf(
      'const discoveredTask: DownloadTask =',
      handler
    )
    const persistParent = source.indexOf(
      'persistTask(discoveredTask)',
      discoveredTask
    )
    const parentBarrier = source.indexOf(
      'taskInspectorActivityRuntime.parentTaskCreated(',
      persistParent
    )
    const publish = source.indexOf(
      'taskManager.set(id, discoveredTask)',
      parentBarrier
    )
    const samples = source.indexOf('recordSamples(tasks)', publish)

    expect(discoveredTask).toBeGreaterThan(handler)
    expect(persistParent).toBeGreaterThan(discoveredTask)
    expect(parentBarrier).toBeGreaterThan(persistParent)
    expect(publish).toBeGreaterThan(parentBarrier)
    expect(samples).toBeGreaterThan(publish)
  })

  it('starts bridge cancellation and stops the engine before awaiting general shell work', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8'
    )
    const cleanup = source.indexOf('function performCleanup()')
    const cancellation = source.indexOf(
      'const cancellationDrain = Promise.all([',
      cleanup
    )
    const bridge = source.indexOf("safely('bridge'", cancellation)
    const engine = source.indexOf("safely('engine'", cancellation)
    const shellDrain = source.indexOf(
      "await safely('main-process-work'",
      cleanup
    )

    expect(cancellation).toBeGreaterThan(cleanup)
    expect(bridge).toBeGreaterThan(cancellation)
    expect(engine).toBeGreaterThan(bridge)
    expect(shellDrain).toBeGreaterThan(bridge)
    expect(shellDrain).toBeGreaterThan(engine)
  })

  it('drains tracker resume compensation before Session and engine teardown', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8'
    )
    const cleanup = source.indexOf('function performCleanup()')
    const trackerDrain = source.indexOf(
      "await safely('tracker', () => trackerManager?.stopAndDrain())",
      cleanup
    )
    const sessionDrain = source.indexOf(
      "safely('session', () => sessionManager?.stopAndDrain())",
      trackerDrain
    )
    const engineStop = source.indexOf(
      "safely('engine', () => supervisor?.stop())",
      trackerDrain
    )

    expect(trackerDrain).toBeGreaterThan(cleanup)
    expect(sessionDrain).toBeGreaterThan(trackerDrain)
    expect(engineStop).toBeGreaterThan(trackerDrain)
  })
})
