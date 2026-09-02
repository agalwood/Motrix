import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function mainSource(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
}

describe('Electron plugin Hook runtime assembly', () => {
  it('injects every Hook service from one shared runtime instance', () => {
    const source = mainSource()
    expect(source).toContain(
      'const pluginRuntime = await createPluginRuntime({'
    )
    expect(source).toContain('hookAuditLog = pluginRuntime.auditLog')
    expect(source).toContain('hookOrchestrator = pluginRuntime.orchestrator')
    expect(source).toContain('pluginHookRuntime = pluginRuntime.hooks')
    expect(source).toContain(
      'finalizeFilesystemAdapter = pluginRuntime.finalizeFilesystem'
    )
    expect(source).toContain('durableFinalizeRuntime = pluginRuntime.finalize')
  })

  it('recovers and drains before opening producers', () => {
    const source = mainSource()
    const recover = source.indexOf('await pluginStartup.recoverFinalize(')
    const tasks = source.indexOf('pluginStartup.markTasksRecovered()')
    const drain = source.indexOf('await pluginStartup.drainBeforeProducers({')
    const scheduler = source.indexOf(
      'postDeliveryLoop = activePluginHookRuntime.scheduler'
    )
    const producers = source.indexOf('pluginStartup.openProducers(() => {')

    expect(recover).toBeGreaterThan(-1)
    expect(recover).toBeLessThan(tasks)
    expect(tasks).toBeLessThan(drain)
    expect(drain).toBeLessThan(scheduler)
    expect(scheduler).toBeLessThan(producers)
  })

  it('aborts and drains post delivery before shutting down the Host', () => {
    const source = mainSource()
    const cleanup = source.slice(
      source.indexOf('cleanupPromise = (async () => {'),
      source.indexOf("await safely('magnet'")
    )
    const abort = cleanup.indexOf('postDeliveryAbortController?.abort()')
    const drain = cleanup.indexOf('await postDeliveryLoop')
    const shutdown = cleanup.indexOf('await host?.shutdown()')

    expect(abort).toBeGreaterThan(-1)
    expect(abort).toBeLessThan(drain)
    expect(drain).toBeLessThan(shutdown)
  })
})
