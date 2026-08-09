// src/core/plugin/host/e2e-builtins.test.ts
//
// Plan H milestones M1 / M2: dogfood the three built-in plugins through the
// real CapabilityBridge + QuickJS worker. Each test loads the actual released
// bundle out of dist/builtin-plugins/<id>/dist/plugin.js (fetched seeds,
// ensured by the vitest globalSetup in tests/setup/build-worker.ts) and
// exercises the registered commands; hook firing through the full
// HookOrchestrator is covered by Plan C's orchestrator suites.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type SpawnedBridge, spawnTestBridge } from './test-helpers'

const ROOT = path.resolve(__dirname, '../../../..')

async function load(id: string): Promise<SpawnedBridge> {
  const fixture = path.join(ROOT, 'dist', 'builtin-plugins', id)
  const s = await spawnTestBridge(fixture, { timeoutMs: 10_000 })
  if (s.errorCode) {
    throw new Error(
      `plugin ${id} failed to load: ${s.errorCode} — ${s.errorMessage}`
    )
  }
  return s
}

describe('Built-in plugins via PluginHost', () => {
  it('M1: motrix.url-resolver loads + registers beforeCreate hook and resolve command', async () => {
    const s = await load('motrix.url-resolver')
    try {
      expect(
        s.registrations.some(
          (r) => r.kind === 'hook' && r.key === 'beforeCreate'
        )
      ).toBe(true)
      expect(
        s.registrations.some(
          (r) => r.kind === 'command' && r.key === 'motrix.url-resolver.resolve'
        )
      ).toBe(true)
      // NOTE: this builtin ships NO risky extractor — only a Wikimedia Commons
      // demo resolver (a freely-licensed source, `direct` result) plus a
      // `generic` no-op. The Commons success path needs network, so it is
      // covered offline by commons.test.ts; here (network-free) the resolve
      // command yields no result for bilibili/unmatched URLs → "no resolver
      // matched", asserted in M2. Real site-specific extraction lives in
      // separately installed site-resolver plugins, not in this official builtin.
    } finally {
      await s.bridge.dispose()
    }
  })

  it('M2: motrix.url-resolver yields no result for bilibili (no site extractor shipped)', async () => {
    const s = await load('motrix.url-resolver')
    try {
      // This builtin ships no bilibili extractor — only the generic no-op —
      // so the resolve command returns nothing and surfaces "no resolver
      // matched". bilibili extraction lives in a separate site-resolver plugin.
      await expect(
        s.callPlugin('motrix.url-resolver.resolve', {
          url: 'https://www.bilibili.com/video/BV1xx411c7mD',
        })
      ).rejects.toThrow(/no resolver matched/)
    } finally {
      await s.bridge.dispose()
    }
  })

  it('M2: motrix.url-resolver rejects an unmatched URL', async () => {
    const s = await load('motrix.url-resolver')
    try {
      await expect(
        s.callPlugin('motrix.url-resolver.resolve', {
          url: 'https://example.com/file.zip',
        })
      ).rejects.toThrow(/no resolver matched/)
    } finally {
      await s.bridge.dispose()
    }
  })

  it('M2: motrix.filename-template registers beforeFinalize + preview', async () => {
    // 1.1.x renamed the applyTemplate command to preview and returns a
    // structured { output, valid, diagnostics } result; the engine renders
    // the template as the filename stem and re-appends the original
    // extension (deduplicated), so this template still yields the same name.
    const s = await load('motrix.filename-template')
    try {
      expect(
        s.registrations.some(
          (r) => r.kind === 'hook' && r.key === 'beforeFinalize'
        )
      ).toBe(true)
      expect(
        s.registrations.some(
          (r) =>
            r.kind === 'command' && r.key === 'motrix.filename-template.preview'
        )
      ).toBe(true)

      const out = (await s.callPlugin('motrix.filename-template.preview', {
        template: '{{title}}-{{id}}.{{ext}}',
        filePath: '/downloads/Big Buck Bunny.mp4',
        taskId: 'task-42',
      })) as { output: string; valid: boolean }
      expect(out.output).toBe('Big Buck Bunny-task-42.mp4')
      expect(out.valid).toBe(true)
    } finally {
      await s.bridge.dispose()
    }
  })

  it('M2: motrix.filename-template sanitizes unsafe characters', async () => {
    const s = await load('motrix.filename-template')
    try {
      const out = (await s.callPlugin('motrix.filename-template.preview', {
        template: 'a/b\\c<>:"|?*.txt',
        filePath: '/downloads/anything',
        taskId: 'x',
      })) as { output: string }
      expect(out.output).not.toMatch(/[/\\<>:"|?*]/)
    } finally {
      await s.bridge.dispose()
    }
  })

  it('M2: motrix.scraper-hook registers beforeCreate hook', async () => {
    const s = await load('motrix.scraper-hook')
    try {
      expect(
        s.registrations.some(
          (r) => r.kind === 'hook' && r.key === 'beforeCreate'
        )
      ).toBe(true)
      // No public commands; the hook itself is exercised via the
      // HookOrchestrator suite, not directly here.
    } finally {
      await s.bridge.dispose()
    }
  })
})
