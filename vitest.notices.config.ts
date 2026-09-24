import { defineConfig } from 'vitest/config'

// License checks read local manifests and artifacts. Keep them independent of
// the application's worker build and signed builtin-plugin downloads.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: [],
    globalSetup: [],
    include: [
      'tests/check-third-party-notices.test.ts',
      'tests/generate-third-party-notices.test.ts',
    ],
  },
})
