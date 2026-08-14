import path from 'node:path'
import { defineConfig } from 'vitest/config'
import packageJson from './package.json' with { type: 'json' }

export default defineConfig({
  define: {
    __MOTRIX_TARGET__: JSON.stringify('electron'),
    __MOTRIX_PREVIEW_MAC_MENU__: JSON.stringify(false),
    __MOTRIX_APP_METADATA__: JSON.stringify({
      name: packageJson.productName,
      version: packageJson.version,
      author: packageJson.author,
      license: packageJson.license,
    }),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    globalSetup: ['tests/setup/build-worker.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'dist-test/**'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@core': path.resolve(import.meta.dirname, 'src/core'),
      '@renderer': path.resolve(import.meta.dirname, 'src/renderer'),
      '@server': path.resolve(import.meta.dirname, 'src/server'),
      '@test-utils': path.resolve(import.meta.dirname, 'src/test-utils'),
    },
  },
})
