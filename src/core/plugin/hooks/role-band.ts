export type RoleBand =
  | 'pre-resolve'
  | 'resolve'
  | 'enrich'
  | 'post-process'
  | 'audit'
const ORDER: RoleBand[] = [
  'pre-resolve',
  'resolve',
  'enrich',
  'post-process',
  'audit',
]

export function bandIndex(
  role: RoleBand,
  opts?: { builtin?: boolean }
): number {
  if (role === 'pre-resolve' && opts?.builtin === false)
    throw new Error('plugin.manifest.role.requires_builtin')
  const i = ORDER.indexOf(role)
  if (i < 0) throw new Error(`unknown role band: ${role}`)
  return i
}

export interface BandSortable {
  pluginId: string
  role: RoleBand
}
export function sortByBand<T extends BandSortable>(arr: ReadonlyArray<T>): T[] {
  return [...arr].sort((a, b) => {
    const da = bandIndex(a.role) - bandIndex(b.role)
    return da !== 0 ? da : a.pluginId.localeCompare(b.pluginId)
  })
}

export function isMostCritical(role: RoleBand): boolean {
  return role === 'pre-resolve' || role === 'resolve' || role === 'post-process'
}
