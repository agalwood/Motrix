// src/core/plugin/manifest/schema.ts
// Manifest Zod schema lives in @motrix/plugin-manifest-schema (published
// from the plugin-sdk repo). This file is a re-export façade so host imports
// continue to resolve via `@core/plugin/manifest/schema`. Do not add logic
// here — change the schema in plugin-sdk and bump the dependency instead.
export * from '@motrix/plugin-manifest-schema'
