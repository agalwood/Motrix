import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = [
  'main',
  'preload',
  'worker',
  'renderer',
  'renderer.web',
  'server',
]

function initialChunks(chunks) {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const loaded = new Map()
  function visit(chunk) {
    if (loaded.has(chunk.fileName)) return
    loaded.set(chunk.fileName, chunk)
    for (const name of chunk.imports) {
      const dependency = byName.get(name)
      if (dependency) visit(dependency)
    }
  }
  chunks.filter((chunk) => chunk.isEntry).forEach(visit)
  return [...loaded.values()]
}

function moduleIds(chunks) {
  return chunks
    .flatMap((chunk) => Object.keys(chunk.modules))
    .map((id) => id.replaceAll('\\', '/'))
}

function locales(modules) {
  return [
    ...new Set(
      modules.flatMap(
        (id) => /\/src\/shared\/locales\/(.+)\.json$/.exec(id)?.[1] ?? []
      )
    ),
  ].sort()
}

export async function measureProductionBundles() {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('Run bundle measurement with NODE_ENV=production')
  }
  const report = {}
  for (const target of TARGETS) {
    let copiesPublicAssets = false
    const result = await build({
      root: ROOT,
      configFile: path.join(ROOT, `vite.${target}.config.ts`),
      mode: 'production',
      logLevel: 'silent',
      build: { write: false },
      plugins: [
        {
          name: 'measure-production-assets',
          configResolved(config) {
            copiesPublicAssets =
              Boolean(config.publicDir) && config.build.copyPublicDir
          },
        },
      ],
    })
    if (!Array.isArray(result) && 'close' in result) {
      await result.close()
      throw new Error('unexpected watch build')
    }
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (r) => r.output
    )
    const chunks = outputs.filter((item) => item.type === 'chunk')
    const initial = initialChunks(chunks)
    const bytes = (items) =>
      items.reduce((sum, item) => sum + Buffer.byteLength(item.code), 0)
    const gzipBytes = (items) =>
      items.reduce((sum, item) => sum + gzipSync(item.code).length, 0)
    const allModules = moduleIds(chunks)
    const startupModules = moduleIds(initial)
    report[target] = {
      copiesPublicAssets,
      totalBytes: bytes(chunks),
      totalGzipBytes: gzipBytes(chunks),
      initialBytes: bytes(initial),
      initialGzipBytes: gzipBytes(initial),
      initialChunks: initial.length,
      chunkCount: chunks.length,
      sourceMaps: outputs.filter((item) => item.fileName.endsWith('.map'))
        .length,
      initialLocales: locales(startupModules),
      bundledLocales: locales(allModules),
      initialElk: startupModules.some((id) => id.includes('/elkjs/')),
      bundledElk: allModules.some((id) => id.includes('/elkjs/')),
    }
  }
  return report
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await measureProductionBundles(), null, 2)}\n`
  )
}
