// scripts/check-schema-parity.mjs
//
// Sanity check: ensures the host manifest schema façade remains a pure
// re-export of @motrix/plugin-manifest-schema. The actual schema lives in the
// plugin-sdk repo (packages/plugin-manifest-schema, published to npm) and is
// re-exported by:
//
//   - src/core/plugin/manifest/schema.ts  (host)
//
// The CLI-side façade (plugin-cli/src/manifest-schema.ts) moved to plugin-sdk
// with the package; its purity is guarded there by scripts/check-facade.mjs.
//
// If you see a "drift" failure here, do NOT copy schema code into the façade
// file — change @motrix/plugin-manifest-schema (plugin-sdk repo) and bump the
// dependency instead.

import { readFile } from 'node:fs/promises'

const FACADES = ['src/core/plugin/manifest/schema.ts']
const REQUIRED_LINE = `export * from '@motrix/plugin-manifest-schema'`

let failed = false
for (const path of FACADES) {
  const content = await readFile(path, 'utf8')
  if (!content.includes(REQUIRED_LINE)) {
    console.error(`drift: ${path} is missing the required re-export.`)
    console.error(`       expected to find: ${REQUIRED_LINE}`)
    failed = true
    continue
  }
  // Strip comments and the required line, then ensure nothing else of
  // substance remains (no top-level statements, no zod imports, etc.).
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(REQUIRED_LINE, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped !== '') {
    console.error(
      `drift: ${path} contains unexpected content beyond the re-export.`
    )
    const display =
      stripped.length > 200 ? `${stripped.slice(0, 200)}...` : stripped
    console.error(`       residue: ${display}`)
    failed = true
  }
}

if (failed) {
  console.error('')
  console.error(
    'Manifest schema must live in @motrix/plugin-manifest-schema only.'
  )
  process.exit(1)
}
console.log('Schema façade sanity OK')
