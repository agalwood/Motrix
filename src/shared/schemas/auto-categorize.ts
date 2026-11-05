import { z } from 'zod'

// IDM-style auto-categorization: map file extensions to a subfolder of the
// default download directory. Rules only apply when the task does not carry
// an explicit saveDir, so a user-picked directory always wins.

export const AUTO_CATEGORIZE_EXT_MAX_LENGTH = 16
export const AUTO_CATEGORIZE_EXTS_PER_RULE_LIMIT = 32
export const AUTO_CATEGORIZE_RULE_LIMIT = 64
export const AUTO_CATEGORIZE_FOLDER_MAX_LENGTH = 120

// Extensions are stored lowercase, without the leading dot, ASCII only —
// anything else (unicode, dots, separators) would need escaping when the
// folder layout is presented back to the user.
export const autoCategorizeExtensionSchema = z
  .string()
  .regex(/^[a-zA-Z0-9]{1,16}$/)

// A folder must survive as a single plain path segment on every supported
// platform: no separators, wildcard characters, control bytes, or
// dot-only names. Windows reserves device names — reject those too, they
// cannot be created as directories.
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

// Forbidden path-segment characters: separators, wildcards, and the full
// C0 control range.
// biome-ignore lint/complexity/useRegexLiterals: RegExp constructor avoids noControlCharactersInRegex
const FORBIDDEN_SEGMENT_CHARS = new RegExp('[/\\\\:*?"<>|\\u0000-\\u001f]')

export function isPlainFolderSegment(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > AUTO_CATEGORIZE_FOLDER_MAX_LENGTH)
    return false
  if (trimmed !== value) return false
  if (FORBIDDEN_SEGMENT_CHARS.test(trimmed)) return false
  if (/^[.]+$/.test(trimmed)) return false
  if (/[. ]$/.test(trimmed)) return false
  return !WINDOWS_RESERVED_DEVICE_NAMES.has(trimmed.toUpperCase())
}

export const autoCategorizeRuleSchema = z.object({
  exts: z
    .array(autoCategorizeExtensionSchema)
    .min(1)
    .max(AUTO_CATEGORIZE_EXTS_PER_RULE_LIMIT),
  folder: z.string().refine(isPlainFolderSegment),
})

export const AUTO_CATEGORIZE_DISABLED: AutoCategorizeSettings = {
  enabled: false,
  rules: [],
}

// Shipped defaults mirror IDM's category layout; users edit them freely.
export const DEFAULT_AUTO_CATEGORIZE_RULES: AutoCategorizeRule[] = [
  {
    exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm2ts', 'mpg'],
    folder: 'Video',
  },
  {
    exts: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'ape', 'wma'],
    folder: 'Audio',
  },
  {
    exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'],
    folder: 'Pictures',
  },
  {
    exts: [
      'pdf',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'ppt',
      'pptx',
      'txt',
      'md',
      'epub',
    ],
    folder: 'Documents',
  },
  {
    exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
    folder: 'Archives',
  },
  {
    exts: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appimage'],
    folder: 'Programs',
  },
]

export const DEFAULT_AUTO_CATEGORIZE: AutoCategorizeSettings = {
  enabled: false,
  rules: DEFAULT_AUTO_CATEGORIZE_RULES,
}

export const autoCategorizeSettingsSchema = z
  .object({
    enabled: z.boolean().catch(false),
    // Deliberately NO field-level catch: a damaged persisted payload recovers
    // via the outer catch below, but an invalid user-submitted rule must
    // fail validation so the settings UI can surface it.
    rules: z.array(autoCategorizeRuleSchema).max(AUTO_CATEGORIZE_RULE_LIMIT),
  })
  .catch(DEFAULT_AUTO_CATEGORIZE)

export interface AutoCategorizeRule {
  exts: string[]
  folder: string
}

export interface AutoCategorizeSettings {
  enabled: boolean
  rules: AutoCategorizeRule[]
}
