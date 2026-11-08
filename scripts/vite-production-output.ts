import type { Rolldown } from 'vite'

// Apply full output minification even to SSR/ES library builds, whose Vite
// defaults otherwise keep whitespace. Keep distribution attribution in output.
export const PRODUCTION_OUTPUT = {
  minify: true,
  comments: { legal: true, jsdoc: false, annotation: false },
} satisfies Rolldown.OutputOptions
