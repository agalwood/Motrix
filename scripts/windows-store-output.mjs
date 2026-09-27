import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

function contains(parent, child) {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

/** Resolve a new output without creating it or traversing input via a parent alias. */
export async function resolveWindowsStoreOutput({
  outputDirectory,
  inputDirectories,
}) {
  if (
    typeof outputDirectory !== 'string' ||
    !path.isAbsolute(outputDirectory)
  ) {
    throw new Error('outputDirectory must be absolute')
  }
  const requested = path.resolve(outputDirectory)
  const parent = await realpath(path.dirname(requested))
  const output = path.join(parent, path.basename(requested))
  for (const input of inputDirectories) {
    const root = await realpath(input)
    if (contains(root, output) || contains(output, root)) {
      throw new Error(
        'Build output must be outside and not contain an input directory'
      )
    }
  }
  try {
    await lstat(output)
    throw new Error('Build output already exists; choose a fresh directory')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return output
}
