import { resolve } from 'node:path'
import { crx } from '@crxjs/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import {
  buildOutputHygienePlugin,
  buildVariantPlugin,
  cspSafeZodPlugin,
  safariManifestPlugin,
} from '#build-variant-plugin'
import manifest from '#manifest-config'

export default defineConfig(({ command, mode }) => {
  const firefox = mode === 'firefox'
  const safari = mode === 'safari'
  const webStore =
    !safari && (mode === 'webstore' || process.env.MOTRIX_BUILD === 'webstore')
  const excludeYouTube = webStore || firefox || safari
  const safariRelease = safari && process.env.MOTRIX_SAFARI_RELEASE === '1'
  const releaseBuild = command === 'build' && (webStore || safariRelease)
  const debugBuild = command === 'build' && !releaseBuild
  const outputDir = resolve(
    import.meta.dirname,
    `dist/${safari ? 'safari' : webStore ? 'webstore' : firefox ? 'firefox' : 'chromium'}`
  )
  return {
    plugins: [
      buildVariantPlugin(excludeYouTube),
      cspSafeZodPlugin(),
      react(),
      tailwindcss(),
      crx({ manifest, browser: firefox ? 'firefox' : 'chrome' }),
      ...(safari ? [safariManifestPlugin()] : []),
      buildOutputHygienePlugin(outputDir),
    ],
    build: {
      target: 'es2022',
      outDir: outputDir,
      emptyOutDir: true,
      // Local browser builds stay readable and debuggable. The Web Store
      // artifact is the release boundary: optimize it and never ship maps.
      sourcemap: debugBuild,
      minify: releaseBuild ? 'oxc' : false,
    },
    resolve: {
      alias: {
        ...(safari
          ? {
              '@/shared/browser': resolve(
                import.meta.dirname,
                'src/shared/browser.safari.ts'
              ),
            }
          : {}),
        '@': resolve(import.meta.dirname, 'src'),
      },
    },
    define: {
      __BROWSER__: JSON.stringify(
        safari ? 'safari' : firefox ? 'firefox' : 'chromium'
      ),
      __MOTRIX_BUILD__: JSON.stringify(excludeYouTube ? 'webstore' : 'full'),
      // Dev-only §7.3 backoff override (see shared/buildFlags.ts). Never
      // honored in a Web Store build: the define is forced to undefined
      // here regardless of the environment.
      __MOTRIX_DEV_PAIR_BACKOFF_MS__: (() => {
        if (webStore) return 'undefined'
        const parsed = Number.parseInt(
          process.env.MOTRIX_DEV_PAIR_BACKOFF_MS ?? '',
          10
        )
        return Number.isFinite(parsed) && parsed > 0
          ? String(parsed)
          : 'undefined'
      })(),
    },
    server: {
      cors: { origin: [/chrome-extension:\/\//, /moz-extension:\/\//] },
    },
  }
})
