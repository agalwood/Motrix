export type DetectedSource = 'github' | 'url' | 'local' | null

export function detectInstallSource(input: string): DetectedSource {
  const v = input.trim()
  if (!v) return null
  if (v.toLowerCase().endsWith('.moext')) return 'local'
  if (/^https?:\/\//i.test(v)) return 'url'
  if (/^[\w.-]+\/[\w.-]+(@[\w.-]+)?$/.test(v)) return 'github'
  return null
}
