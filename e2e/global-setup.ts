import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

// Build artifacts live under dist/ at the repo root. globalSetup runs
// from the repo root because Playwright resolves relative paths against
// playwright.config.ts. Use process.cwd() instead of __dirname so the
// path is stable regardless of how this file is bundled.
const ROOT = process.cwd()

const REQUIRED_ARTIFACTS = [
  'dist/main/index.cjs',
  'dist/preload/preload.cjs',
  'dist/renderer/index.html',
]

export default async function globalSetup() {
  // Keep direct `pnpm exec playwright ...` invocations safe as well as the
  // package scripts: existing build artifacts do not prove that pnpm left the
  // Electron runtime (including its legal files) fully hydrated.
  const electronRuntime = spawnSync(
    'pnpm',
    ['run', 'ensure:electron-runtime'],
    {
      stdio: 'inherit',
      cwd: ROOT,
      shell: process.platform === 'win32',
    }
  )
  if (electronRuntime.error) throw electronRuntime.error
  if (electronRuntime.signal) {
    throw new Error(
      `Electron runtime check was killed by ${electronRuntime.signal}`
    )
  }
  if (electronRuntime.status !== 0) {
    throw new Error(
      `Electron runtime check exited with status ${electronRuntime.status ?? 'unknown'}`
    )
  }

  const missing = REQUIRED_ARTIFACTS.filter(
    (rel) => !existsSync(path.join(ROOT, rel))
  )

  if (missing.length === 0 && !process.env.MOTRIX_E2E_FORCE_BUILD) {
    // Reuse existing artifacts. Set MOTRIX_E2E_FORCE_BUILD=1 to force
    // a rebuild (e.g. after pulling latest in CI).
    return
  }

  if (missing.length > 0) {
    console.log(
      `[e2e] missing artifacts: ${missing.join(', ')} — running pnpm build`
    )
  } else {
    console.log('[e2e] MOTRIX_E2E_FORCE_BUILD set — running pnpm build')
  }

  const result = spawnSync('pnpm', ['build'], {
    stdio: 'inherit',
    cwd: ROOT,
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`pnpm build exited with status ${result.status}`)
  }
}
