export function assertMessageSucceeded(value: unknown): void {
  if (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string'
  ) {
    throw new Error(value.error)
  }
}
