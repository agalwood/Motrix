import { constants } from 'node:fs'
import { lstat, open, readlink } from 'node:fs/promises'

// Linux O_PATH allows traversal through execute-only NAS ancestors. Node does
// not expose this flag; NAS hosts run on Linux and requires procfs for this reader.
const O_PATH = 0x200000

/** Anchor every component to an open parent; never follow replacement links. */
export async function openNasFile(
  canonical: string,
  authorize: (path: string) => Promise<string>
) {
  if (process.platform !== 'linux' || !canonical.startsWith('/'))
    throw new Error('Descriptor-relative file access is unavailable')
  const parts = canonical.slice(1).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('Invalid canonical file path')
  const directoryFlags = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
  let parent = await open('/', directoryFlags)
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(
        `/proc/self/fd/${parent.fd}/${part}`,
        directoryFlags
      )
      const previous = parent
      parent = next
      await previous.close()
    }
    const file = await open(
      `/proc/self/fd/${parent.fd}/${parts.at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const descriptor = `/proc/self/fd/${file.fd}`
      // A held ancestor may have been renamed. Authorize the opened file's
      // actual location and confirm that the checked name still denotes it.
      if ((await readlink(descriptor)) !== canonical)
        throw new Error('File moved while opening')
      if ((await authorize(canonical)) !== canonical)
        throw new Error('File authorization changed')
      const named = await lstat(canonical, { bigint: true })
      const opened = await file.stat({ bigint: true })
      if (
        !opened.isFile() ||
        named.dev !== opened.dev ||
        named.ino !== opened.ino ||
        (await readlink(descriptor)) !== canonical
      )
        throw new Error('File changed during authorization')
      return file
    } catch (error) {
      await file.close()
      throw error
    }
  } finally {
    await parent.close()
  }
}
