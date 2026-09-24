import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import packageJson from './package.json' with { type: 'json' }

export default defineConfig({
  base: '/',
  plugins: [tailwindcss()],
  define: {
    __MOTRIX_TARGET__: JSON.stringify('web'),
    __MOTRIX_PREVIEW_MAC_MENU__: JSON.stringify(false),
    __MOTRIX_APP_METADATA__: JSON.stringify({
      name: packageJson.productName,
      version: packageJson.version,
      author: packageJson.author,
      license: packageJson.license,
    }),
  },
  build: {
    outDir: 'dist/renderer-web',
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
})
