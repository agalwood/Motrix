// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RendererDiagnostics } from './renderer-diagnostics'

describe('RendererDiagnostics', () => {
  it('bounds the in-memory history and rotates fixed-size files', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'motrix-renderer-logs-')
    )
    try {
      const file = path.join(directory, 'renderer-health.jsonl')
      await writeFile(file, 'x'.repeat(2 * 1024 * 1024))
      const diagnostics = new RendererDiagnostics(directory)
      for (let index = 0; index < 150; index++)
        diagnostics.record({
          generation: 'test-generation',
          incidentId: String(index),
          windowId: 'main',
          phase: 'blocked',
          reason: 'crashed',
          attempt: 0,
        })
      await diagnostics.drain()
      expect(diagnostics.snapshot()).toHaveLength(100)
      expect(await readdir(directory)).toEqual(
        expect.arrayContaining([
          'renderer-health.jsonl',
          'renderer-health.jsonl.1',
        ])
      )
      const rows = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row))
      expect(rows).toHaveLength(100)
      expect(rows.at(-1).incidentId).toBe('149')
      expect(rows.at(-1)).not.toHaveProperty('route')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
