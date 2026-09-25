// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = path.resolve(
  import.meta.dirname,
  '../../scripts/check-boundaries.mjs'
)
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function check(files: Record<string, string>) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'motrix-icon-boundary-'))
  directories.push(cwd)
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(cwd, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' })
}

describe('semantic icon import boundary', () => {
  it.each([
    "import { Download } from 'lucide-react'",
    "import type { LucideIcon } from 'lucide-react'",
    "import * as icons from 'lucide-react'",
    "export { Download } from 'lucide-react'",
    "export * from 'lucide-react'",
    "import 'lucide-react'",
    "const icons = require('lucide-react')",
    "const icons = import(\n  'lucide-react'\n)",
    'const icons = import(`lucide-react`)',
    "type Icon = import('lucide-react').LucideIcon",
    "import Download from 'lucide-react/dist/esm/icons/download.mjs'",
  ])('rejects a direct library reference: %s', (source) => {
    const result = check({ 'src/renderer/routes/example.tsx': source })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(
      '[FAIL] renderer must use semantic icons outside components/icons'
    )
    expect(result.stdout).toContain('src/renderer/routes/example.tsx:')
  })

  it('allows semantic consumers and isolated library adapters/tests', () => {
    const result = check({
      'src/renderer/routes/example.tsx':
        "import { DownloadIcon, type MotrixIcon } from '@renderer/components/icons'",
      'src/renderer/components/icons/download.tsx':
        "import { Download } from 'lucide-react'",
      'src/renderer/components/icons/create-icon.test.tsx':
        "import { LucideProvider } from 'lucide-react'",
      'src/renderer/components/icons/adapters/lucide.ts':
        "import type { LucideIcon } from 'lucide-react'",
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      '[PASS] renderer must use semantic icons outside components/icons'
    )
  })

  it.each([
    'src/renderer/components/icons-extra/download.tsx',
    'src/renderer/routes/example.test.tsx',
    'src/renderer/routes/components/icons/download.tsx',
  ])('keeps the directory exception scoped: %s', (file) => {
    const result = check({ [file]: "import { Download } from 'lucide-react'" })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(file)
  })
})
