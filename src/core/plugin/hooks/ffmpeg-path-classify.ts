// src/core/plugin/hooks/ffmpeg-path-classify.ts
// Pure path classifier for ffmpeg outputs. Categorises a user-supplied output
// path as belonging to the current task's saveDir, the plugin's storage root,
// or "other" (rejected). No IO; no symlink resolution at this layer (the
// FfmpegStaging / fs.storage capabilities handle realpath/symlink guards).

import path from 'node:path'

export type FfmpegOutputKind = 'saveDir' | 'pluginStorage' | 'other'

/**
 * Classify `userOutput` against the current task's `saveDir` and the
 * calling plugin's `pluginStorageRoot`. `userOutput` may be absolute or
 * relative; relative paths resolve against `saveDir` (the bridge's
 * historical convention — keeps muxed-output writes ergonomic for plugin
 * authors who just say `output: 'final.mp4'`).
 *
 * Both roots are normalised to drop any trailing separator so that
 * `/tmp/save/` and `/tmp/save` behave identically. Comparison is exact
 * prefix + separator boundary so `/tmp/task-1` doesn't match `/tmp/task-12`.
 */
export function classifyFfmpegOutput(
  userOutput: string,
  saveDir: string,
  pluginStorageRoot: string
): FfmpegOutputKind {
  const sd = saveDir.replace(/[/\\]+$/, '')
  const ps = pluginStorageRoot.replace(/[/\\]+$/, '')
  // Empty roots are degenerate: '' + path.sep matches every absolute path.
  // Reject rather than silently misclassify; callers must supply real roots.
  if (!sd || !ps) return 'other'

  const resolved = path.resolve(sd, userOutput)
  if (resolved === sd || resolved.startsWith(sd + path.sep)) return 'saveDir'
  if (resolved === ps || resolved.startsWith(ps + path.sep))
    return 'pluginStorage'
  return 'other'
}
