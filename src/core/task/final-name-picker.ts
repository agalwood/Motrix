import path from 'node:path'
import {
  INCOMPLETE_SUFFIX,
  MAX_DEDUP_ATTEMPTS,
} from '@shared/constants/incomplete'
import { AppError, ErrorCode } from '@shared/errors'
import { outputNameIdentity } from './output-path-identity'

export interface FsProbe {
  exists(absPath: string): Promise<boolean>
}

export interface FinalNamePicker {
  pick(
    saveDir: string,
    desiredName: string,
    reservedNames?: readonly string[],
    adjacentControlFile?: boolean
  ): Promise<string>
  isTaken?(
    dir: string,
    name: string,
    adjacentControlFile?: boolean
  ): Promise<boolean>
}

export class FinalNamePickerImpl implements FinalNamePicker {
  constructor(private readonly fs: FsProbe) {}

  async pick(
    saveDir: string,
    desiredName: string,
    reservedNames: readonly string[] = [],
    adjacentControlFile = false
  ): Promise<string> {
    const reserved = new Set(reservedNames.map(outputNameIdentity))
    const isReserved = (name: string): boolean =>
      reserved.has(outputNameIdentity(name)) ||
      reserved.has(outputNameIdentity(`${name}${INCOMPLETE_SUFFIX}`)) ||
      reserved.has(outputNameIdentity(`${name}${INCOMPLETE_SUFFIX}.aria2`)) ||
      (adjacentControlFile && reserved.has(outputNameIdentity(`${name}.aria2`)))
    if (
      !isReserved(desiredName) &&
      !(await this.isTaken(saveDir, desiredName, adjacentControlFile))
    ) {
      return desiredName
    }

    const { base, ext } = splitNameExt(desiredName)

    for (let n = 1; n <= MAX_DEDUP_ATTEMPTS; n++) {
      const candidate = ext ? `${base} (${n})${ext}` : `${base} (${n})`
      if (
        !isReserved(candidate) &&
        !(await this.isTaken(saveDir, candidate, adjacentControlFile))
      ) {
        return candidate
      }
    }

    throw new AppError(
      ErrorCode.TaskCreateDedupExhausted,
      `Too many files with name "${desiredName}" already exist in ${saveDir}`
    )
  }

  async isTaken(
    dir: string,
    name: string,
    adjacentControlFile = false
  ): Promise<boolean> {
    const finalPath = path.join(dir, name)
    const tempPath = finalPath + INCOMPLETE_SUFFIX
    const [f, t, c] = await Promise.all([
      this.fs.exists(finalPath),
      this.fs.exists(tempPath),
      adjacentControlFile ? this.fs.exists(`${finalPath}.aria2`) : false,
    ])
    return f || t || c
  }
}

/**
 * Split "foo.mp4" into { base: "foo", ext: ".mp4" }.
 * Dotfiles (.env) → { base: ".env", ext: "" }.
 * Multi-dot (archive.tar.gz) → { base: "archive.tar", ext: ".gz" } —
 * only the last extension is treated as ext.
 *
 * Names whose trailing dot-token doesn't look like a real extension
 * (release-tag tails like ".1 Tigole)", version strings like "v1.2.3")
 * are returned with an empty ext so the dedup suffix lands at the end
 * of the whole name. A "real" extension is 2–8 alphanumeric chars.
 */
function splitNameExt(name: string): { base: string; ext: string } {
  if (name.startsWith('.') && name.lastIndexOf('.') === 0) {
    return { base: name, ext: '' }
  }
  const ext = path.extname(name)
  if (!ext || !/^\.[A-Za-z0-9]{2,8}$/.test(ext)) {
    return { base: name, ext: '' }
  }
  return { base: name.slice(0, -ext.length), ext }
}
