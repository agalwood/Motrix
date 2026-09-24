import path from 'node:path'
import { sanitizeFinalizePath } from '@core/fs/finalize-path'
import type { FinalNamePicker } from './final-name-picker'

/**
 * Resolve the path a finalized artifact is published under.
 *
 * The final component is sanitized for every supported filesystem, and when
 * sanitization changes it the result is deduplicated again. The name was
 * reserved at create time in its unsanitized spelling, so the sanitized one
 * can collide with an existing file; publication renames without replacing,
 * so an unhandled collision fails the task instead of becoming `name (1)`.
 *
 * An already-clean name is returned as-is: it is the reservation made at
 * create time, and re-picking it would count the task's own temporary file
 * as a conflict.
 */
export async function resolvePublishedTargetPath(
  requested: string,
  picker: Pick<FinalNamePicker, 'pick'> | undefined
): Promise<string> {
  const sanitized = sanitizeFinalizePath(requested)
  if (sanitized === requested || !picker) return sanitized
  const dir = path.dirname(sanitized)
  return path.join(dir, await picker.pick(dir, path.basename(sanitized)))
}
