import {
  type DownloadCategory,
  downloadCategorySchema,
} from '@shared/schemas/download-category'
import type { DownloadTask } from '@shared/types/task'

const EXTENSIONS: Record<
  Exclude<DownloadCategory, 'other'>,
  readonly string[]
> = {
  compressed: [
    'zip',
    'rar',
    '7z',
    'gz',
    'bz2',
    'xz',
    'tar',
    'tgz',
    'tbz',
    'tbz2',
    'txz',
    'zst',
    'lz',
    'lzma',
    'cab',
    'iso',
  ],
  documents: [
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'odt',
    'ods',
    'odp',
    'rtf',
    'txt',
    'csv',
    'tsv',
    'epub',
    'mobi',
    'azw',
    'azw3',
    'djvu',
    'md',
    'html',
    'htm',
    'xml',
    'json',
  ],
  music: [
    'mp3',
    'm4a',
    'aac',
    'flac',
    'wav',
    'ogg',
    'opus',
    'wma',
    'aiff',
    'aif',
    'alac',
    'mid',
    'midi',
    'ape',
  ],
  programs: [
    'exe',
    'msi',
    'msix',
    'msixbundle',
    'appx',
    'appxbundle',
    'apk',
    'aab',
    'dmg',
    'pkg',
    'deb',
    'rpm',
    'appimage',
    'bat',
    'cmd',
    'com',
    'jar',
    'ps1',
    'sh',
  ],
  video: [
    'mp4',
    'mkv',
    'webm',
    'avi',
    'mov',
    'm4v',
    'wmv',
    'flv',
    'mpeg',
    'mpg',
    'ts',
    'm2ts',
    'mts',
    '3gp',
    'ogv',
    'vob',
  ],
}

const CATEGORY_BY_EXTENSION = new Map<string, DownloadCategory>(
  Object.entries(EXTENSIONS).flatMap(([category, extensions]) =>
    extensions.map((ext) => [ext, category as DownloadCategory] as const)
  )
)

export function classifyDownload(filename: string): DownloadCategory {
  const basename = filename.split(/[\\/]/).pop()?.trim() ?? ''
  const dot = basename.lastIndexOf('.')
  if (dot <= 0) return 'other'
  return (
    CATEGORY_BY_EXTENSION.get(basename.slice(dot + 1).toLowerCase()) ?? 'other'
  )
}

/** Existing history is classified for display without moving its files. */
export function taskDownloadCategory(task: DownloadTask): DownloadCategory {
  const saved = downloadCategorySchema.safeParse(task.category)
  if (saved.success) return saved.data
  if (task.fileCount > 1) return 'other'
  return classifyDownload(task.finalName || task.filename || task.name)
}
