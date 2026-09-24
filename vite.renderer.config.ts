import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import packageJson from './package.json' with { type: 'json' }

export default defineConfig(({ command }) => ({
  // Electron file:// + asar needs relative asset paths; the default
  // '/' resolves to the filesystem root, not inside the asar.
  base: './',
  plugins: [tailwindcss()],
  define: {
    __MOTRIX_TARGET__: JSON.stringify('electron'),
    __MOTRIX_PREVIEW_MAC_MENU__: JSON.stringify(
      command === 'serve' && process.env.MOTRIX_PREVIEW_MAC_MENU === '1'
    ),
    __MOTRIX_APP_METADATA__: JSON.stringify({
      name: packageJson.productName,
      version: packageJson.version,
      author: packageJson.author,
      license: packageJson.license,
    }),
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@renderer': path.resolve(import.meta.dirname, 'src/renderer'),
      path: path.resolve(
        import.meta.dirname,
        'src/renderer/lib/path-browser-shim.ts'
      ),
    },
  },
}))
