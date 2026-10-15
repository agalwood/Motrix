import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyNativeResources } from '../safari-native-resources.mjs'

test('native packaging rejects newly added resources omitted by Xcode and stale JS', () => {
  const root = mkdtempSync(join(tmpdir(), 'motrix-native-resources-'))
  try {
    const source = join(root, 'source')
    const target = join(root, 'target')
    mkdirSync(join(source, 'assets'), { recursive: true })
    mkdirSync(join(target, 'assets'), { recursive: true })
    writeFileSync(join(source, 'assets/worker.js'), 'new')
    assert.throws(() => verifyNativeResources(source, target), /Missing/)
    writeFileSync(join(target, 'assets/worker.js'), 'old')
    assert.throws(() => verifyNativeResources(source, target), /Stale/)
    writeFileSync(join(target, 'assets/worker.js'), 'new')
    assert.doesNotThrow(() => verifyNativeResources(source, target))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
