#!/usr/bin/env node
// Compatibility command name for the sole engine's pinned source build.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runBuild } from './build-taiji.mjs'

export { binaryName, bundledPath, sha256Hex } from './build-taiji.mjs'
export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2
export const EXIT_UNSUPPORTED_HOST = 3
export async function run(argv = []) {
  try {
    await runBuild(argv)
    return EXIT_OK
  } catch (error) {
    console.error(`[fetch-engine] ${error.message}`)
    return /^Unsupported taiji target:/.test(error.message)
      ? EXIT_UNSUPPORTED_HOST
      : EXIT_FAILURE
  }
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await run(process.argv.slice(2))
}
