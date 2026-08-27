import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')

describe('development runner process spawning', () => {
  it('uses a direct cross-spawn dependency for Windows command resolution', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/dev.mjs'), 'utf8')
    const packageJson = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8')
    ) as { devDependencies?: Record<string, string> }

    expect(source).toContain("import spawn from 'cross-spawn'")
    expect(source).not.toContain("from 'node:child_process'")
    expect(packageJson.devDependencies?.['cross-spawn']).toBe('^7.0.6')
  })
})
