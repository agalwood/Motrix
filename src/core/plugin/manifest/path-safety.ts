import path from 'node:path'

/**
 * Resolve a manifest-declared relative path (`main`, `l10n`, ...) against the
 * plugin's root directory, returning the absolute path only if it stays inside
 * that root. Returns null on any traversal (`../`) or absolute-path escape.
 *
 * Manifest path fields are only length-validated by the schema, so this is the
 * filesystem boundary: it stops a malicious manifest from making the host read
 * a file outside the plugin's own directory (e.g. main: "../../secret.js").
 */
export function resolveInsidePluginDir(
  rootDir: string,
  relative: string
): string | null {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null
  }
  return resolved
}
