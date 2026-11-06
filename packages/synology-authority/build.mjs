import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('DSM authority build failed')
}
if (process.platform === 'linux' && process.arch === 'x64') {
  run(
    'cargo',
    ['build', '--release', '--locked', '--target', 'x86_64-unknown-linux-musl'],
    { cwd: directory }
  )
} else {
  run('docker', [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--mount',
    `type=bind,source=${directory},target=/src`,
    '--workdir',
    '/src',
    'rust:1.94.1',
    'sh',
    '-c',
    'rustup target add x86_64-unknown-linux-musl && cargo build --release --locked --target x86_64-unknown-linux-musl',
  ])
}
const output = path.join(directory, 'dist/linux-x64')
await mkdir(output, { recursive: true })
await copyFile(
  path.join(
    directory,
    'target/x86_64-unknown-linux-musl/release/motrix-dsm-authority'
  ),
  path.join(output, 'motrix-dsm-authority')
)
await chmod(path.join(output, 'motrix-dsm-authority'), 0o700)
