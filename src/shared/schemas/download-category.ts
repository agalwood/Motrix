import { z } from 'zod'

export const DOWNLOAD_CATEGORIES = [
  'compressed',
  'documents',
  'music',
  'programs',
  'video',
  'other',
] as const

export const downloadCategorySchema = z.enum(DOWNLOAD_CATEGORIES)
export type DownloadCategory = z.infer<typeof downloadCategorySchema>

/** Stable folder names, independent of the display language. */
export const DOWNLOAD_CATEGORY_FOLDERS: Record<DownloadCategory, string> = {
  compressed: 'Compressed',
  documents: 'Documents',
  music: 'Music',
  programs: 'Programs',
  video: 'Video',
  other: 'Other',
}
