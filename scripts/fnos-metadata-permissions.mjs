import { chmod, lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

export async function normalizeFnosMetadataPermissions(project) {
  const directory = path.join(project, 'cmd')
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Invalid fnOS callback directory')
  await chmod(directory, 0o755)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Invalid fnOS callback: ${entry.name}`)
    await chmod(
      path.join(directory, entry.name),
      entry.name.endsWith('.mjs') ? 0o644 : 0o755
    )
  }
}

export async function verifyFnosMetadataPermissions(project) {
  const directory = path.join(project, 'cmd')
  const root = await lstat(directory)
  if (!root.isDirectory() || (root.mode & 0o022) !== 0)
    throw new Error('Writable or invalid fnOS callback directory')
  for (const name of await readdir(directory)) {
    const file = await lstat(path.join(directory, name))
    if (!file.isFile() || (file.mode & 0o022) !== 0)
      throw new Error(`Writable or invalid fnOS callback: ${name}`)
  }
}
