import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function serverSource(): string {
  return readFileSync(
    path.resolve(process.cwd(), 'src/server/index.ts'),
    'utf8'
  )
}

describe('Server plugin Hook runtime assembly', () => {
  it('injects every Hook service from one shared runtime instance', () => {
    const source = serverSource()
    expect(source).toContain(
      'const pluginRuntime = await createPluginRuntime({'
    )
    expect(source).toContain('pluginHookRuntime = pluginRuntime.hooks')
    expect(source).toContain('const hookAuditLog = pluginRuntime.auditLog')
    expect(source).toContain(
      'const hookOrchestrator = pluginRuntime.orchestrator'
    )
    expect(source).toContain(
      'const finalizeFilesystemAdapter = pluginRuntime.finalizeFilesystem'
    )
    expect(source).toContain(
      'const durableFinalizeRuntime = pluginRuntime.finalize'
    )
  })

  it('recovers and drains before opening producers', () => {
    const source = serverSource()
    const recover = source.indexOf('await pluginStartup.recoverFinalize(')
    const tasks = source.indexOf('pluginStartup.markTasksRecovered()')
    const drain = source.indexOf('await pluginStartup.drainBeforeProducers({')
    const scheduler = source.indexOf(
      'postDeliveryLoop = pluginHookRuntime.scheduler'
    )
    const producers = source.indexOf('pluginStartup.openProducers(() => {')

    expect(recover).toBeGreaterThan(-1)
    expect(recover).toBeLessThan(tasks)
    expect(tasks).toBeLessThan(drain)
    expect(drain).toBeLessThan(scheduler)
    expect(scheduler).toBeLessThan(producers)
  })

  it('aborts and drains post delivery before shutting down the Host', () => {
    const source = serverSource()
    const shutdown = source.slice(
      source.indexOf('shutdownActions.drainPluginHost = async () => {'),
      source.indexOf(
        'shutdownActions.disposeFinalizeFs = () => finalizeFilesystemAdapter.dispose()'
      )
    )
    const abort = shutdown.indexOf('postDeliveryAbortController.abort()')
    const drain = shutdown.indexOf('await postDeliveryLoop')
    const host = shutdown.indexOf('await pluginHost.shutdown()')

    expect(abort).toBeGreaterThan(-1)
    expect(abort).toBeLessThan(drain)
    expect(drain).toBeLessThan(host)
  })
})
