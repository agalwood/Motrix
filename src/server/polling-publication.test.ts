import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Source-literal contract, same pattern as shutdown.test.ts and
// main-process-work-coordinator.test.ts: the server shell's poll tick must
// gate its TaskUpdated publication on an observed engine delta, matching
// the desktop shell. Without the gate an idle server broadcasts the full
// snapshot every second to every SSE/WS consumer for no change at all.
describe('server poll tick publication', () => {
  it('publishes only when the poll observed an engine delta', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/server/index.ts'),
      'utf8'
    )
    const handler = source.indexOf('async function handlePolledTasks(')
    expect(handler).toBeGreaterThan(-1)

    const dirtyInit = source.indexOf('let dirty = false', handler)
    const delta = source.indexOf(
      'hasEngineTaskDelta(existing, merged)',
      handler
    )
    const gated = source.indexOf('if (dirty) publishTaskUpdate()', handler)

    expect(dirtyInit).toBeGreaterThan(handler)
    expect(delta).toBeGreaterThan(dirtyInit)
    expect(gated).toBeGreaterThan(delta)
  })

  it('publishes the post-recovery snapshot before polling can observe it', () => {
    // Recovery rewrites stopped-state rows (intent replay, finalize repair)
    // that polling never observes — with the dirty gate above, the startup
    // snapshot is the ONLY publication that can carry them. Mirrors the
    // desktop shell's post-recovery publishNow and its source assertion in
    // main-process-work-coordinator.test.ts.
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/server/index.ts'),
      'utf8'
    )
    const restore = source.indexOf('await sessionManager.restore(')
    const recovery = source.indexOf('recoveryService.recoverOnStartup()')
    const publish = source.indexOf('publishTaskUpdateNow()', recovery)

    expect(restore).toBeGreaterThan(-1)
    expect(recovery).toBeGreaterThan(restore)
    expect(publish).toBeGreaterThan(recovery)
  })
})
