import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

function directory(path) {
  if (!lstatSync(path).isDirectory())
    throw new Error(`Expected a directory, not a symlink or file: ${path}`)
}

/** Replace only a validated bundle, retaining the previous copy for recovery. */
export function installSafariApp({
  source,
  destination,
  verify,
  registry,
  apply = false,
}) {
  source = resolve(source)
  destination = resolve(destination)
  directory(source)
  const parent = dirname(destination)
  if (existsSync(parent)) directory(parent)
  // Compare canonical paths as well as names to catch aliases and containment.
  const canonicalSource = realpathSync(source)
  const canonicalDestination = join(
    realpathSync(existsSync(parent) ? parent : dirname(parent)),
    ...(existsSync(parent) ? [] : [parent.split(sep).at(-1)]),
    destination.split(sep).at(-1)
  )
  if (
    canonicalSource === canonicalDestination ||
    canonicalSource.startsWith(`${canonicalDestination}${sep}`) ||
    canonicalDestination.startsWith(`${canonicalSource}${sep}`)
  ) {
    throw new Error('Source and installation must be separate bundles')
  }
  // lstat detects dangling symlinks that existsSync intentionally ignores.
  try {
    directory(destination)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const incoming = verify(source)
  const previous = existsSync(destination) ? verify(destination) : null
  if (previous?.fingerprint === incoming.fingerprint)
    return { status: 'up-to-date', destination, build: incoming.build }
  if (previous && incoming.build <= previous.build)
    throw new Error(
      'Rebuild with a newer CFBundleVersion before replacing this app'
    )
  if (!apply) return { status: 'ready', destination, build: incoming.build }

  mkdirSync(parent, { recursive: true })
  const lock = join(parent, '.motrix-safari-install.lock')
  mkdirSync(lock) // A concurrent or interrupted installer requires inspection.
  let transaction
  let backup
  let oldMoved = false
  let newPlaced = false
  let registryTouched = false
  try {
    // Revalidate under the lock before touching the previous installation.
    if (
      (existsSync(destination) ? verify(destination).fingerprint : null) !==
      (previous?.fingerprint ?? null)
    )
      throw new Error('The installed app changed during preflight; retry')
    transaction = mkdtempSync(join(parent, '.motrix-safari-install-'))
    const staged = join(transaction, 'incoming.app.disabled')
    backup = join(transaction, 'previous.app.disabled')
    cpSync(source, staged, { recursive: true, verbatimSymlinks: true })
    if (verify(staged).fingerprint !== incoming.fingerprint)
      throw new Error('The staged app differs from the verified source')
    if (previous) {
      // Keep the stable path registered so Safari can retain its installation
      // identity. Refresh that registration after replacing the bundle.
      renameSync(destination, backup)
      oldMoved = true
    }
    renameSync(staged, destination)
    newPlaced = true
    if (verify(destination).fingerprint !== incoming.fingerprint)
      throw new Error('The installed app differs from the verified source')
    registryTouched = true
    registry.unregister(source)
    registry.register(destination)
    if (!previous) rmSync(transaction, { recursive: true })
    return {
      status: 'installed',
      destination,
      build: incoming.build,
      backup: previous ? backup : null,
    }
  } catch (error) {
    const failures = []
    const recover = (action) => {
      try {
        action()
      } catch (failure) {
        failures.push(failure)
      }
    }
    if (newPlaced) {
      if (registryTouched && !previous)
        recover(() => registry.unregister(destination))
      recover(() => rmSync(destination, { recursive: true }))
    }
    if (oldMoved) recover(() => renameSync(backup, destination))
    if (previous && (oldMoved || registryTouched) && existsSync(destination))
      recover(() => {
        if (verify(destination).fingerprint !== previous.fingerprint)
          throw new Error('The previous bundle could not be restored')
        registry.register(destination)
      })
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        `Installation failed; recovery needs inspection. Preserve ${transaction}`
      )
    if (transaction) rmSync(transaction, { recursive: true })
    throw new Error('Installation failed; the previous state was restored', {
      cause: error,
    })
  } finally {
    rmSync(lock, { recursive: true })
  }
}
