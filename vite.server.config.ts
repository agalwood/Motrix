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

function matchesPackage(id: string, name: string): boolean {
  return id === name || id.startsWith(`${name}/`)
}

function isExternal(id: string): boolean {
  if (id.startsWith('node:')) return true
  if (nodeBuiltinSet.has(id)) return true
  return productionDeps.some((name) => matchesPackage(id, name))
}

export default defineConfig({
  build: {
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'node22',
    ssr: true,
    lib: {
      entry: {
        index: 'src/server/index.ts',
        'motrix-admin': 'src/server/operator-cli.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: isExternal,
      output: {
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
      },
    },
  },
  resolve: {
    conditions: ['node', 'default'],
    mainFields: ['main', 'module'],
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@core': path.resolve(import.meta.dirname, 'src/core'),
      '@server': path.resolve(import.meta.dirname, 'src/server'),
    },
  },
})
