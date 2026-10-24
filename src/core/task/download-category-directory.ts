import path from 'node:path'
import { DOWNLOAD_CATEGORY_FOLDERS } from '@shared/schemas/download-category'
import { classifyDownload } from '@shared/utils/download-category'

function isCategoryDirectory(directory: string): boolean {
  const name = path.basename(path.resolve(directory)).toLowerCase()
  return Object.values(DOWNLOAD_CATEGORY_FOLDERS).some(
    (folder) => folder.toLowerCase() === name
  )
}

export function categorySaveDirectory(
  directory: string,
  filename: string,
  enabled: boolean
): string {
  if (!enabled || isCategoryDirectory(directory)) return directory
  return path.join(
    directory,
    DOWNLOAD_CATEGORY_FOLDERS[classifyDownload(filename)]
  )
}

/** Category children share their parent's admission lock with the root. */
export function categoryAdmissionDirectory(
  directory: string,
  enabled: boolean
): string {
  return enabled && isCategoryDirectory(directory)
    ? path.dirname(directory)
    : directory
}
