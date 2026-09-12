type DirtyTree = boolean | { [key: string]: DirtyTree | undefined }

export function pickDirty<T>(
  values: T,
  dirty: DirtyTree | undefined
): Partial<T> | undefined {
  if (!dirty) return undefined
  if (dirty === true) return values as Partial<T>
  if (typeof dirty !== 'object' || values == null) return undefined

  // Settings patches replace arrays as a whole; numeric object keys are not a valid list.
  if (Array.isArray(values)) {
    const hasDirty = (node: DirtyTree | undefined): boolean =>
      node === true ||
      (typeof node === 'object' && Object.values(node).some(hasDirty))
    return hasDirty(dirty) ? (values as Partial<T>) : undefined
  }

  const out: Record<string, unknown> = {}
  let hasAny = false
  for (const key of Object.keys(dirty)) {
    const child = pickDirty(
      (values as Record<string, unknown>)[key],
      (dirty as Record<string, DirtyTree>)[key]
    )
    if (child !== undefined) {
      out[key] = child
      hasAny = true
    }
  }
  return hasAny ? (out as Partial<T>) : undefined
}
