import path from 'node:path'

export function aria2BinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'aria2c.exe' : 'aria2c'
}

export function bundledAria2Path(
  extraResourceDir: string,
  platform: NodeJS.Platform,
  arch: string
): string {
  return path.join(extraResourceDir, platform, arch, aria2BinaryName(platform))
}
