// @vitest-environment node
import path from 'node:path'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../..')

describe('renderer icon tree shaking', () => {
  it('bundles only the requested glyph from the semantic barrel', async () => {
    const entry = 'virtual:motrix-icon-probe'
    const result = await build({
      root,
      configFile: path.join(root, 'vite.renderer.config.ts'),
      logLevel: 'silent',
      plugins: [
        {
          name: 'icon-probe',
          resolveId(id) {
            if (id === entry) return `\0${entry}`
          },
          load(id) {
            if (id === `\0${entry}`) {
              return 'export { DownloadIcon } from "@renderer/components/icons"'
            }
          },
        },
      ],
      build: {
        write: false,
        emptyOutDir: false,
        minify: false,
        rolldownOptions: {
          input: entry,
          external: ['react', 'react/jsx-runtime', 'clsx', 'tailwind-merge'],
          preserveEntrySignatures: 'strict',
        },
      },
    })
    const outputs = Array.isArray(result) ? result : [result]
    const glyphs = outputs.flatMap((output) => {
      if (!('output' in output)) throw new Error('Expected a completed build')
      return output.output.flatMap((chunk) => {
        if (chunk.type !== 'chunk') return []
        return Object.entries(chunk.modules)
          .filter(
            ([id, module]) =>
              id
                .replaceAll('\\', '/')
                .includes('lucide-react/dist/esm/icons/') &&
              module.renderedLength > 0
          )
          .map(([id]) => path.basename(id))
      })
    })
    expect(glyphs).toEqual(['download.mjs'])
  })
})
