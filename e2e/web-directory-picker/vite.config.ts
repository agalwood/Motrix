import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
  define: {
    __MOTRIX_TARGET__: JSON.stringify('web'),
    __MOTRIX_PREVIEW_MAC_MENU__: JSON.stringify(false),
  },
  resolve: {
    alias: [
      {
        find: /^@renderer\/lib\/transport$/,
        replacement: path.join(import.meta.dirname, 'fixture-transport.ts'),
      },
      {
        find: '@renderer',
        replacement: path.join(repositoryRoot, 'src/renderer'),
      },
      { find: '@shared', replacement: path.join(repositoryRoot, 'src/shared') },
      {
        find: 'path',
        replacement: path.join(
          repositoryRoot,
          'src/renderer/lib/path-browser-shim.ts'
        ),
      },
    ],
  },
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
})
