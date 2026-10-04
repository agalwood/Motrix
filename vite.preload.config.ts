import { builtinModules } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vite'
import { PRODUCTION_OUTPUT } from './scripts/vite-production-output'

const nodeExternals = builtinModules.flatMap((m) => [m, `node:${m}`])

export default defineConfig({
  build: {
    outDir: 'dist/preload',
    emptyOutDir: true,
    minify: 'oxc',
    sourcemap: false,
    target: 'node20',
    lib: {
      entry: 'src/preload/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    rollupOptions: {
      output: PRODUCTION_OUTPUT,
      external: ['electron', ...nodeExternals],
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
})
