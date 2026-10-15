/**
 * Compares the JSON-compatible snapshots returned by the extension message
 * bus. Message responses are structured clones, so referential equality alone
 * cannot tell whether a poll contains new information.
 */
export function snapshotEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => snapshotEqual(value, right[index]))
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false

  return leftKeys.every(
    (key) =>
      Object.hasOwn(rightRecord, key) &&
      snapshotEqual(leftRecord[key], rightRecord[key])
  )
}
