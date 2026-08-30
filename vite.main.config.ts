import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
const pkg = require('./package.json') as {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const productionDeps = Object.keys({
  ...(pkg.dependencies ?? {}),
  ...(pkg.optionalDependencies ?? {}),
})
const nodeBuiltinSet = new Set(builtinModules)

// Packages that must be bundled into the cjs main output instead of
// being externalized. require(ESM) is stable in Node 22.12+ (Electron
// 41 bundles Node 22.14+), so merely declaring "type": "module" is no
// longer a reason to bundle — Node can require() an ESM file once it is
// resolved. A package lands here for one of two reasons:
//
//   1. Its `exports` map exposes ONLY an "import" condition (no
//      "require"/"node"/"default"). require()'s resolver never matches
//      such a map and throws ERR_PACKAGE_PATH_NOT_EXPORTED *before*
//      loading, so require(ESM) can't help — the failure is in
//      resolution, not loading. Bundling resolves it at build time via
//      the import condition. `bittorrent-peerid` and `parse-torrent`
//      (both feross/webtorrent, `exports: { import: "./index.js" }`)
//      are this case.
//   2. Its transitive deps get dropped from the asar by electron-builder
//      26 + pnpm hoisted layout (the Go-based dep walker can't follow
//      the tree without a `package-lock.json`). Bundling sidesteps the
//      walker because every transitive dep ends up in the cjs output at
//      build time. `pino` is the canonical example — its grandchildren
//      (pino-std-serializers, safe-stable-stringify, thread-stream,
//      etc.) get dropped from the asar otherwise.
export const BUNDLED_PACKAGES = ['bittorrent-peerid', 'parse-torrent', 'pino']

function matchesPackage(id: string, name: string): boolean {
  return id === name || id.startsWith(`${name}/`)
}

function isExternal(id: string): boolean {
  if (id === 'electron') return true
  if (id.startsWith('node:')) return true
  if (nodeBuiltinSet.has(id)) return true
  if (BUNDLED_PACKAGES.some((name) => matchesPackage(id, name))) {
    return false
  }
  return productionDeps.some((name) => matchesPackage(id, name))
}

export default defineConfig({
  build: {
    outDir: 'dist/main',
    emptyOutDir: true,
    target: 'node20',
    lib: {
      entry: 'src/main/index.ts',
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      external: isExternal,
    },
  },
  resolve: {
    // Prefer Node entry points when packages declare conditional
    // exports (e.g. cross-fetch-ponyfill ships node-only code under
    // the "node" condition and browser code under "default").
    conditions: ['node', 'default'],
    mainFields: ['main', 'module'],
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@core': path.resolve(import.meta.dirname, 'src/core'),
      '@main': path.resolve(import.meta.dirname, 'src/main'),
    },
  },
})
