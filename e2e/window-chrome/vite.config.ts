import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import packageJson from '../../package.json' with { type: 'json' }

const repositoryRoot = path.resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
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
  resolve: {
    alias: {
      '@renderer': path.join(repositoryRoot, 'src/renderer'),
      '@shared': path.join(repositoryRoot, 'src/shared'),
      path: path.join(repositoryRoot, 'src/renderer/lib/path-browser-shim.ts'),
    },
  },
  server: { host: '127.0.0.1', port: 4186, strictPort: true },
})
