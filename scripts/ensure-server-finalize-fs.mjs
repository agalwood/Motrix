import { spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const platform = process.platform
const arch = process.arch
const binary =
  platform === 'win32' ? 'motrix-finalize-fs.exe' : 'motrix-finalize-fs'
const output = path.join(
  repositoryRoot,
  'packages',
  'finalize-fs',
  'dist',
  `${platform}-${arch}`,
  binary
)

if (process.env.MOTRIX_SERVER_FINALIZE_FS_PREBUILT === '1') {
  await access(output)
  process.stdout.write(`[server-finalize-fs] using staged binary: ${output}\n`)
} else {
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, 'packages/finalize-fs/build.mjs')],
    { cwd: repositoryRoot, env: process.env, stdio: 'inherit' }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`finalize-fs build failed with exit code ${result.status}`)
  }
  await access(output)
}
