// Shared staging rule for the Electron and Server packagers.
//
// A published npm package carries payloads that only its own build needed:
// source maps, type declarations, the TypeScript sources they were emitted
// from, and project documentation. Nothing loads them at runtime, so they are
// dead weight in a shipped package.
//
// Both stagers apply this, so the rule lives here rather than in either one.

import path from 'node:path'

// `.d.ts` is matched by the `.ts` alternative as well; both are build-only.
const BUILD_ONLY_EXTENSION = /\.(?:map|ts|tsx|mts|cts|flow)$/i

// Project documentation, matched on the stem so `README.md`, `readme.markdown`
// and `CHANGELOG` all qualify. Attribution files are deliberately absent: the
// notice requirement covers what is distributed, and those still are.
const DOCUMENTATION_STEM =
  /^(?:readme|changelog|changes|history|contributing|authors|security|code_of_conduct|governance|maintainers|upgrading|migration)$/i

function toPortable(relative) {
  return relative.replaceAll(path.sep, '/')
}

/**
 * True when a package-relative entry exists only for a build and is never read
 * at runtime.
 *
 * @param {string} entry Package-relative path, in either separator style.
 */
export function isBuildOnlyEntry(entry) {
  const portable = toPortable(entry)
  const base = portable.slice(portable.lastIndexOf('/') + 1)
  if (BUILD_ONLY_EXTENSION.test(base)) return true
  // Match the stem alone so `readme-parser.js` is code, not documentation.
  const stem = base.includes('.') ? base.slice(0, base.indexOf('.')) : base
  return DOCUMENTATION_STEM.test(stem)
}

/**
 * Build a copy filter that prunes build-time-only files, optionally
 * intersected with a package-specific allowlist. The package root (`''`) is
 * always kept so the directory itself is created.
 *
 * @param {(relative: string) => boolean} [allowlist]
 *   Extra per-package rule; an entry ships only when it also passes this.
 */
export function pruneBuildOnly(allowlist) {
  return (relative) => {
    if (relative.length === 0) return true
    if (isBuildOnlyEntry(relative)) return false
    return allowlist ? allowlist(relative) : true
  }
}
