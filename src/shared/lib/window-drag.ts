export function shouldUseManualWindowDrag(
  platform: string,
  systemVersion: string | undefined
): boolean {
  if (platform !== 'darwin' || !systemVersion) return false

  const [major, minor = 0] = systemVersion
    .split('.')
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10))

  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false

  // macOS 27.2 regressed AppKit window dragging for custom Electron chrome.
  return major > 27 || (major === 27 && minor >= 2)
}
