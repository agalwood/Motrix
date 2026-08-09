import { builtinModules } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vite'

const nodeExternals = builtinModules.flatMap((m) => [m, `node:${m}`])

export default defineConfig({
  build: {
    outDir: 'dist/preload',
    emptyOutDir: true,
    target: 'node20',
    lib: {
      entry: 'src/preload/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    rollupOptions: {
      external: ['electron', ...nodeExternals],
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
})
