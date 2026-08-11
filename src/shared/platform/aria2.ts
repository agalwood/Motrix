export function aria2BinaryName(platform: string): string {
  return platform === 'win32' ? 'aria2c.exe' : 'aria2c'
}
