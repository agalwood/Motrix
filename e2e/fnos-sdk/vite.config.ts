import path from 'node:path'
import { defineConfig } from 'vite'

const root = path.resolve(import.meta.dirname, '../..')
export default defineConfig({
  root: import.meta.dirname,
  define: {
    __MOTRIX_TARGET__: JSON.stringify('web'),
    __MOTRIX_FNOS__: JSON.stringify(true),
    __MOTRIX_PREVIEW_MAC_MENU__: JSON.stringify(false),
  },
  resolve: {
    alias: [
      {
        find: /^@renderer\/lib\/transport$/,
        replacement: path.join(import.meta.dirname, 'fixture-transport.ts'),
      },
      { find: '@renderer', replacement: path.join(root, 'src/renderer') },
      { find: '@shared', replacement: path.join(root, 'src/shared') },
      {
        find: 'path',
        replacement: path.join(root, 'src/renderer/lib/path-browser-shim.ts'),
      },
    ],
  },
  server: { host: '127.0.0.1', port: 4189, strictPort: true },
})
