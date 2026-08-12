export function resolveSmokePlatform(value) {
  if (value === undefined) return undefined
  if (!['linux/amd64', 'linux/arm64'].includes(value)) {
    throw new Error(`unsupported Server image smoke platform: ${value}`)
  }
  return value
}

export function resolveSmokeMode(value) {
  if (value === undefined) return 'full'
  if (!['full', 'health'].includes(value)) {
    throw new Error(`unsupported Server image smoke mode: ${value}`)
  }
  return value
}
