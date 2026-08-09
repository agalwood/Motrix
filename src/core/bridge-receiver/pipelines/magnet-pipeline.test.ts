import { describe, expect, it, vi } from 'vitest'
import type { AdaptedMagnet } from '../submit-download-adapter'
import { MagnetPipeline } from './magnet-pipeline'

const adapted: AdaptedMagnet = {
  kind: 'magnet',
  saveDir: '/tmp/save',
  uri: 'magnet:?xt=urn:btih:abc',
  sourceMeta: {
    kind: 'magnet',
    extensionId: 'e',
    browser: 'chromium',
    sessionKey: 'chromium:e',
    pageUrl: 'https://example.com/p',
    pageTitle: 'demo',
    qualityLabel: 'file',
    durationSec: null,
    submittedAt: 1,
  },
}

describe('MagnetPipeline.dispatch', () => {
  it('routes through MagnetTracker when file selection is enabled, preserving bridge provenance', async () => {
    // When the "pick files after metadata resolves" setting is on, the bridge
    // magnet MUST go through the metadata-only fetch (no aria2 auto-follow ⇒ no
    // duplicate BT record, and MagnetFileSelection opens the dialog) — NOT
    // straight to the engine. The metadata task's id is returned to the ext.
    const createTask = vi.fn(async () => ({ gid: 'g1', taskId: 't1' }))
    const submitMagnetForFileSelection = vi.fn(async () => 'meta-task-1')
    const pipeline = new MagnetPipeline({
      createTask,
      removeTask: vi.fn(async () => {}),
      submitMagnetForFileSelection,
      isMagnetFileSelectionEnabled: () => true,
    })

    const out = await pipeline.dispatch(adapted)

    expect(out).toEqual({ taskId: 'meta-task-1' })
    expect(submitMagnetForFileSelection).toHaveBeenCalledWith(
      'magnet:?xt=urn:btih:abc',
      '/tmp/save',
      adapted.sourceMeta
    )
    // Dispatching straight to the engine is exactly the bug: it spawns the
    // duplicate followed-by BT record and skips the file dialog.
    expect(createTask).not.toHaveBeenCalled()
  })

  it('dispatches straight to the engine as a bt task when file selection is disabled', async () => {
    const createTask = vi.fn(async () => ({ gid: 'g1', taskId: 't1' }))
    const submitMagnetForFileSelection = vi.fn(async () => 'meta-task-1')
    const pipeline = new MagnetPipeline({
      createTask,
      removeTask: vi.fn(async () => {}),
      submitMagnetForFileSelection,
      isMagnetFileSelectionEnabled: () => false,
    })

    const out = await pipeline.dispatch(adapted)

    expect(out).toEqual({ taskId: 't1' })
    expect(createTask).toHaveBeenCalledWith(
      {
        type: 'bt',
        saveDir: '/tmp/save',
        payload: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:abc' },
        selectedFiles: [],
      },
      undefined,
      { source: 'bridge', sourceMeta: adapted.sourceMeta }
    )
    expect(submitMagnetForFileSelection).not.toHaveBeenCalled()
  })
})
