import path from 'node:path'
import type { AutoCategorizeSettings } from '@shared/schemas/auto-categorize'

// IDM-style routing: when a task is created without an explicit saveDir,
// pick a subfolder of the default download directory from the file-name
// extension. Tasks whose hint yields no extension (or match no rule) fall
// back to the default directory unchanged.

export function extensionFromName(name: string): string | null {
  const base = name.replace(/.*[/\\]/, '').trim()
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return null
  const ext = base.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : null
}

// Extension guess for task creation input: the magnet `dn=` hint for
// magnet URIs, the URL path basename for http(s), the raw value otherwise.
export function extensionFromTaskSource(source: string): string | null {
  const trimmed = source.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('magnet:')) {
    const dn = safeUrl(trimmed)?.searchParams.get('dn')
    return dn ? extensionFromName(dn) : null
  }
  const url = safeUrl(trimmed)
  if (url && /^https?:$/.test(url.protocol)) {
    const segment = url.pathname.split('/').pop() ?? ''
    const decoded = safeDecode(segment)
    return decoded ? extensionFromName(decoded) : null
  }
  return extensionFromName(trimmed)
}

export function autoCategorizeSaveDir(
  settings: AutoCategorizeSettings | undefined,
  ext: string | null | undefined,
  defaultSaveDir: string
): string {
  // Defensive on settings: untyped composition code and partial test
  // fixtures may predate the field; treat it as disabled.
  if (!settings?.enabled || !ext || !defaultSaveDir) return defaultSaveDir
  const rule = settings.rules.find((candidate) =>
    candidate.exts.some((candidateExt) => candidateExt.toLowerCase() === ext)
  )
  if (!rule) return defaultSaveDir
  return path.join(defaultSaveDir, rule.folder)
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
