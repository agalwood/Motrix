import { readdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CrxPlugin } from '@crxjs/vite-plugin'
import type { Plugin } from 'vite'

const ADAPTER_REGISTRY_ID = 'virtual:motrix-adapter-registry'
const YOUTUBE_SNIFFER_SCRIPT_ID = 'virtual:motrix-youtube-sniffer-script'

/** CRXJS adds this Chromium-only field after reading manifest.config.ts. */
export function safariManifestPlugin(): CrxPlugin {
  return {
    name: 'motrix-safari-manifest',
    enforce: 'post',
    renderCrxManifest(manifest) {
      return {
        ...manifest,
        web_accessible_resources: manifest.web_accessible_resources?.map(
          (resource) => {
            const safariResource = { ...resource }
            delete safariResource.use_dynamic_url
            return safariResource
          }
        ),
      }
    },
  }
}

export function buildVariantPlugin(excludeYouTube: boolean): Plugin {
  const resolvedAdapterRegistryId = `\0${ADAPTER_REGISTRY_ID}`
  const resolvedYoutubeSnifferScriptId = `\0${YOUTUBE_SNIFFER_SCRIPT_ID}`
  return {
    name: 'motrix-build-variant',
    enforce: 'pre',
    resolveId(id) {
      if (id === ADAPTER_REGISTRY_ID) return resolvedAdapterRegistryId
      if (id === YOUTUBE_SNIFFER_SCRIPT_ID) {
        return resolvedYoutubeSnifferScriptId
      }
      return null
    },
    load(id) {
      if (id === resolvedAdapterRegistryId) {
        if (excludeYouTube) return 'export const adapterRegistry = []'
        const adapterPath = resolve(
          import.meta.dirname,
          'src/adapters/youtube/index'
        )
        return `import { youtubeAdapter } from ${JSON.stringify(adapterPath)}; export const adapterRegistry = [youtubeAdapter]`
      }
      if (id === resolvedYoutubeSnifferScriptId) {
        if (excludeYouTube) return 'export default null'
        const entryPath = `${resolve(
          import.meta.dirname,
          'src/content/youtube-sniffer-entry'
        )}?script&iife`
        return `import scriptPath from ${JSON.stringify(entryPath)}; export default scriptPath`
      }
      return null
    },
  }
}

/**
 * Zod 4 optionally probes and generates parser functions with the Function
 * constructor. Extension CSP blocks those paths at runtime, but store scanners
 * still flag the dormant code. Force the existing interpreted parser path and
 * remove the constructors from the generated extension altogether.
 */
export function cspSafeZodPlugin(): Plugin {
  const zodCoreModule = (id: string, file: string) =>
    id.replaceAll('\\', '/').includes(`/node_modules/zod/v4/core/${file}`)

  return {
    name: 'motrix-csp-safe-zod',
    enforce: 'pre',
    transform(code, id) {
      if (zodCoreModule(id, 'util.js')) {
        const start = code.indexOf('export const allowsEval =')
        const end = code.indexOf('export function isPlainObject', start)
        if (start < 0 || end < 0) {
          throw new Error('Unable to disable the Zod Function probe')
        }
        return {
          code: `${code.slice(0, start)}export const allowsEval = { value: false };\n${code.slice(end)}`,
          map: null,
        }
      }

      if (zodCoreModule(id, 'doc.js')) {
        const compileMethod = / {4}compile\(\) \{[\s\S]*?\n {4}\}(?=\n\})/
        if (!compileMethod.test(code)) {
          throw new Error('Unable to disable the Zod Function compiler')
        }
        return {
          code: code.replace(
            compileMethod,
            '    compile() {\n        throw new Error("Zod JIT is disabled in extension builds.");\n    }'
          ),
          map: null,
        }
      }

      return null
    },
  }
}

async function removeFinderMetadata(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await removeFinderMetadata(path)
      } else if (entry.name === '.DS_Store') {
        await unlink(path)
      }
    })
  )
}

/** Keep OS metadata from leaking into packaged extension artifacts. */
export function buildOutputHygienePlugin(outputDir: string): Plugin {
  return {
    name: 'motrix-build-output-hygiene',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      await removeFinderMetadata(outputDir)
    },
  }
}
