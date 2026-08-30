import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPEATS = 20
const MAX_REPEATS = 100

export function parseRemoteExtensionSoakRepeats(value) {
  if (value === undefined || value === '') return DEFAULT_REPEATS
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(
      'MOTRIX_REMOTE_EXTENSION_SOAK_REPEATS must be a positive integer'
    )
  }
  const repeats = Number(value)
  if (!Number.isSafeInteger(repeats) || repeats > MAX_REPEATS) {
    throw new TypeError(
      `MOTRIX_REMOTE_EXTENSION_SOAK_REPEATS must be <= ${MAX_REPEATS}`
    )
  }
  return repeats
}

export function runRemoteExtensionSoak({
  repeats = parseRemoteExtensionSoakRepeats(
    process.env.MOTRIX_REMOTE_EXTENSION_SOAK_REPEATS
  ),
  spawn = spawnSync,
} = {}) {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawn(
    executable,
    ['test:e2e:remote-extension', `--repeat-each=${repeats}`],
    { stdio: 'inherit', env: process.env }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `remote Extension soak failed with exit code ${String(result.status)}`
    )
  }
  return { repeats, browserCases: repeats * 5 }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = runRemoteExtensionSoak()
    console.log(
      `Remote Extension soak passed ${result.repeats} repetitions / ${result.browserCases} browser cases`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
