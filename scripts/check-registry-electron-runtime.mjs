import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import electronPath from 'electron'
import { build } from 'esbuild'

const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), 'motrix-registry-runtime-')
)
const rendererBundle = path.join(temporaryDirectory, 'renderer.js')
const mainBundle = path.join(temporaryDirectory, 'main.cjs')

try {
  await Promise.all([
    build({
      entryPoints: ['scripts/registry-runtime-conformance.ts'],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'MotrixRegistryRuntime',
      outfile: rendererBundle,
      logLevel: 'silent',
    }),
    build({
      entryPoints: ['scripts/check-registry-electron-runtime.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: mainBundle,
      logLevel: 'silent',
    }),
  ])

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [mainBundle], {
      stdio: 'inherit',
      env: {
        ...process.env,
        MOTRIX_REGISTRY_RENDERER_BUNDLE: rendererBundle,
      },
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Electron exited with signal ${signal}`))
      else resolve(code ?? 1)
    })
  })
  if (exitCode !== 0) {
    throw new Error(`Electron conformance failed with exit code ${exitCode}`)
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
