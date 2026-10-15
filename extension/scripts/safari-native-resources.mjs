import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Xcode's generated project lists top-level files explicitly, so refresh is not enough. */
export function verifyNativeResources(source, destination) {
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        const name = relative(source, path)
        const built = join(destination, name)
        if (!existsSync(built))
          throw new Error(
            `Missing packaged Safari resource: ${name}; add it to the Xcode resource target`
          )
        if (
          /\.(?:js|json|html|css)$/.test(name) &&
          !readFileSync(path).equals(readFileSync(built))
        ) {
          throw new Error(`Stale packaged Safari resource: ${name}`)
        }
      } else
        throw new Error(
          'Safari resources must contain only files and directories'
        )
    }
  }
  visit(source)
}
