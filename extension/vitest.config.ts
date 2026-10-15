import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { buildVariantPlugin } from '#build-variant-plugin'

export default defineConfig({
  plugins: [buildVariantPlugin(false)],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    // Re-evaluate API selection when startup tests reset modules to model
    // different hosts; Node's external-module cache otherwise pins one host.
    server: { deps: { inline: ['webextension-polyfill', '@wxt-dev/browser'] } },
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})
